/**
 * @fileoverview Autonomous Test Coverage & PR agent — the `CoverageAgent` reasoning loop.
 *
 * **What this module does**
 * - Implements the Gemini tool‑calling loop that **explores → tests → verifies → opens a PR**.
 * - Maintains an ever‑growing `history: AgentMessage[]` so each `generateContent` call
 *   has full conversational context (user messages + tool results).
 * - Delegates every side‑effect to {@link executeAgentTool} (file ops, `run_command`, `create_pr`).
 *
 * **Key configurations / parameters**
 *
 * | Param / Env | Type | Default | Notes |
 * |-------------|------|---------|-------|
 * | `config.model` (`GEMINI_MODEL`) | `string` | `gemini-2.5-flash` | Overridable per‑agent via `new CoverageAgent('gemini-1.5-pro')` |
 * | `config.maxTurns` (`MAX_AGENT_TURNS`) | `number` | `25` | Hard loop bound — `runMission` stops and returns the limit message instead of looping forever |
 * | `RunMissionOptions.focusArea` | `string` | unset | Limits mission to a path, e.g. `src/lib/utils` — woven into the first user prompt |
 * | `RunMissionOptions.customPrompt` | `string` | unset | Bypasses `focusArea` template when set; any natural‑language instruction |
 * | `AgentMessage.role` | `'user' \| 'model'` | — | Mirrors Gemini `Content.role`; tool results are appended as a synthetic `user` turn |
 *
 * **Usage examples**
 * ```ts
 * import { CoverageAgent } from './agent.js';
 *
 * // 1. Daily unattended job (clone → cover → PR)
 * const agent = new CoverageAgent();              // uses config.model
 * await agent.initWorkspace();
 * const report = await agent.runMission();        // full‑codebase
 * const narrowed = await agent.runMission({ focusArea: 'src/lib/utils' });
 * const custom  = await agent.runMission({ customPrompt: 'Only add tests for TRPC routers' });
 *
 * // 2. Single‑turn / interactive
 * await agent.chat('Write tests for src/lib/currency.ts and verify they pass');
 *
 * // 3. Reset state between independent runs
 * agent.resetHistory();
 * ```
 *
 * **Edge cases / gotchas**
 * - `chat()` accumulates state in `this.history`. Call `resetHistory()` when starting an
 *   unrelated task or when `history` grows large enough to approach the Gemini context limit.
 * - `history` is **append‑only** inside a single `chat()` invocation. The “no tool calls → return”
 *   rule is the only termination signal; if the LLM stalls on tool calls the loop will run
 *   exactly `config.maxTurns` (≈ cost) then return the `reached maximum turns` sentinel.
 * - `createGenAIClient()` may still be mis‑configured (no PAT, no API key, wrong region) —
 *   the first `models.generateContent` will throw; callers should catch and surface to `console.error`.
 * - Tool results are truncated to 250 chars in the console but **not** truncated in the
 *   `functionResponse` payload sent back to the LLM (full 8 000‑char cap comes from `command_runner`).
 * - `workspaceRootOverride` is only for tests — production code always uses `repoManager.getWorkspacePath()`.
 *
 * @see {@link DailyCommitDigestAgent} — peer agent for the daily digest workflow.
 */

import { GoogleGenAI } from '@google/genai';
import { createGenAIClient, config } from './config.js';
import { agentToolDeclarations, executeAgentTool, GitRepoManager } from './tools/index.js';

/** Gemini‑style content block the SDK expects (thinly typed; SDK drift is tolerated as `any`). */
export interface AgentMessage {
  role: 'user' | 'model';
  parts: any[];
}

/**
 * Mission narrowing controls for {@link CoverageAgent#runMission}.
 * At most one of `focusArea` / `customPrompt` should be set; `customPrompt` takes precedence.
 */
export interface RunMissionOptions {
  /**
   * Limit the mission to a sub‑tree, e.g. `"src/lib/utils"` or `"src/features/audio"`.
   * Interpreted by the first user prompt: `Focus on increasing test coverage for: …`.
   */
  focusArea?: string;
  /**
   * Arbitrary natural‑language instruction that entirely replaces the default mission prompt.
   * When set, `focusArea` is ignored.
   * @example "Only add tests for TRPC routers and verify with npx vitest run"
   */
  customPrompt?: string;
}

/**
 * Autonomous coverage engineer — an LLM that can read, write, test, and open PRs.
 *
 * @category Agents
 * @example
 * ```ts
 * const agent = new CoverageAgent(); // or new CoverageAgent('gemini-2.0-flash')
 * await agent.initWorkspace();
 * const report = await agent.runMission({ focusArea: 'src/lib/utils' });
 * console.log(report);
 * ```
 */
export class CoverageAgent {
  private client: GoogleGenAI;
  private model: string;
  private repoManager: GitRepoManager;
  private history: AgentMessage[] = [];

  /**
   * @param customModel - Gemeni model id overriding `config.model` for this agent only.
   *   Useful for A/B‑testing `gemini‑2.0‑flash` vs `gemini‑1.5‑pro`.
   */
  constructor(customModel?: string) {
    this.client = createGenAIClient();
    this.model = customModel || config.model;
    this.repoManager = new GitRepoManager();
  }

  /** Exposes the workspace manager for callers that need `getWorkspacePath()` / manual git ops. */
  public getRepoManager(): GitRepoManager {
    return this.repoManager;
  }

  /** Clears `history` so the next `chat()` starts without prior context. Also resets any diff memory. */
  public resetHistory(): void {
    this.history = [];
  }

  /**
   * Ensures the workspace clone exists and is on `origin/<targetBranch>`.
   * Delegates to {@link GitRepoManager#setupWorkspace}.
   *
   * Call this once before any `runMission()` / `chat()` call. Safe to re‑call —
   * an existing clone is `checkout` → `fetch` → `reset --hard`.
   */
  public async initWorkspace(): Promise<void> {
    console.log('\n\x1b[36m⚙️  Preparing target repository workspace...\x1b[0m');
    const result = await this.repoManager.setupWorkspace();
    console.log(`\x1b[32m✔  ${result.message}\x1b[0m\n`);
  }

  /**
   * Starts (or continues) the autonomous **test coverage** mission.
   *
   * Builds a `missionPrompt` (from `options` or the default 5‑step template) and
   * delegates to `chat(missionPrompt)` — so `history` accrues across chained missions.
   *
   * Default 5 steps when neither `focusArea` nor `customPrompt` is set:
   * 1. `list_dir` + `read_file` exploration
   * 2. Identify untested modules
   * 3. `write_file` test suites
   * 4. `run_command` verification (must be 100 % green)
   * 5. `create_pr`
   *
   * @param options - Optional narrowing ({@link RunMissionOptions}).
   * @returns LLM's final textual report (or the max‑turns sentinel).
   */
  public async runMission(options: RunMissionOptions = {}): Promise<string> {
    const workspaceRoot = this.repoManager.getWorkspacePath();

    const missionPrompt = options.customPrompt || (
      options.focusArea
        ? `Focus on increasing test coverage for: ${options.focusArea}. Analyze the code, create/update test files, run tests to verify they pass, and open a PR.`
        : `Your mission is to increase test coverage of the codebase.
1. Explore the project structure using list_dir, grep_search, and read package.json / key source files.
2. Run tests with coverage (e.g. "npx vitest run --coverage" or "npm test -- --coverage") and call get_coverage_summary to pinpoint untested modules and exact uncovered lines.
3. Write high-quality, comprehensive unit or integration tests using write_file or patch_file covering normal paths and uncovered edge cases.
4. Re-run test and coverage commands to verify that all tests pass 100% cleanly and test coverage has increased.
5. Once all tests are passing and coverage gains are verified, open a Pull Request using create_pr with a detailed breakdown of the tests added and coverage gained.`
    );

    return await this.chat(missionPrompt, workspaceRoot);
  }

  /**
   * Core reasoning loop — single‑turn or multi‑turn depending on whether `userMessage`
   * triggers tool use.
   *
   * Flow (repeated for up to `config.maxTurns`):
   * ```
   * append userMessage → generateContent(system + history + tools)
   *   → print text parts
   *   → if no functionCall → return text (mission done)
   *   → else executeAgentTool for each call → push functionResponse parts → loop
   * ```
   *
   * @param userMessage - Natural‑language instruction (first user prompt or follow‑up).
   * @param workspaceRootOverride - Absolute path override (tests only); defaults to `repoManager.getWorkspacePath()`.
   * @returns LLM's final `response.text` or a limit sentinel.
   * @throws If the Gemini SDK returns no candidates/candidate.content.
   *
   * **Gotchas**
   * - `systemInstruction` enforces test quality (no fake `assert(true)`) and the `run_command` → `create_pr`
   *   verification contract. Tweaking it is the primary lever for agent quality.
   * - Tool errors are fed back as `{ error: err.message }` function responses so the LLM can self‑fix.
   */
  public async chat(userMessage: string, workspaceRootOverride?: string): Promise<string> {
    const workspaceRoot = workspaceRootOverride || this.repoManager.getWorkspacePath();

    // 1. Append user message to conversation history
    this.history.push({
      role: 'user',
      parts: [{ text: userMessage }],
    });

    const systemInstruction = `You are PRism, an expert autonomous software engineer and test coverage specialist.
Your primary objective is to increase test coverage and code quality of the target repository.

Guidelines:
1. Workspace: You have direct access to the cloned repository workspace via tools.
2. Tool Usage:
   - Use list_dir to inspect directories and find source code files.
   - Use grep_search to quickly search for function names, classes, types, exports, and imports across the repository.
   - Use read_file to inspect source code and understand requirements, exports, types, and logic.
   - Use get_coverage_summary to inspect coverage reports and identify exact uncovered line ranges.
   - Use write_file to create new test files (e.g., in a tests/ directory or co-located *.test.ts files).
   - Use patch_file to make surgical updates or fixes to existing files without rewriting them entirely.
   - Use run_command to run test runners (e.g., "npx vitest run --coverage", "npm test", "npx jest", or installing test utilities if required), typechecks ("npx tsc --noEmit"), and check git status.
   - ALWAYS verify your tests by running them through run_command before concluding. Tests MUST pass 100% without errors.
   - Once tests are passing and coverage is verified, call create_pr to submit a Pull Request with a clear title and informative Markdown description.
3. High Quality Tests:
   - Test real behavior and logic, edge cases, error conditions, boundary values, and null/undefined handling.
   - Do NOT write trivial or fake assert(true) tests. Write meaningful assertions that validate inputs/outputs and state.
4. Autonomous Execution:
   - Work methodically step by step. If a command or test fails, analyze the error output and iteratively fix it.`;

    const tools = [
      {
        functionDeclarations: agentToolDeclarations,
      },
    ];

    let turns = 0;
    const maxTurns = config.maxTurns;

    while (turns < maxTurns) {
      turns++;
      console.log(`\n\x1b[90m[Turn ${turns}/${maxTurns}] Agent thinking...\x1b[0m`);

      // 2. Call Gemini model with history and tools
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: this.history,
        config: {
          systemInstruction,
          tools,
        },
      });

      const candidate = response.candidates?.[0];
      if (!candidate || !candidate.content) {
        throw new Error('No candidate content received from the Gemini model.');
      }

      const modelContent = candidate.content;
      this.history.push(modelContent as AgentMessage);

      // Print any model reasoning/text thought
      const textParts = candidate.content.parts?.filter((p: any) => p.text);
      if (textParts && textParts.length > 0) {
        for (const p of textParts) {
          if (p.text && typeof p.text === 'string' && p.text.trim()) {
            console.log(`\x1b[37m${p.text}\x1b[0m`);
          }
        }
      }

      // 3. Check for function calls
      const functionCalls = candidate.content.parts?.filter((p: any) => p.functionCall);

      if (!functionCalls || functionCalls.length === 0) {
        // No function calls: agent completed its response
        return response.text || '(Mission concluded)';
      }

      // 4. Execute all requested tool calls
      const functionResponseParts = [];

      for (const part of functionCalls) {
        const call = part.functionCall!;
        const toolName = call.name || 'unknown_tool';
        console.log(`\x1b[36m⚙️ [Tool Call]\x1b[0m \x1b[1m${toolName}\x1b[0m(${JSON.stringify(call.args)})`);

        try {
          const toolResult = await executeAgentTool(
            toolName,
            call.args,
            workspaceRoot,
            this.repoManager
          );

          // Log brief summary of tool output
          const summaryStr = JSON.stringify(toolResult);
          const truncatedSummary = summaryStr.length > 250 ? summaryStr.slice(0, 250) + '...' : summaryStr;
          console.log(`\x1b[32m✔ [Tool Result]\x1b[0m ${truncatedSummary}`);

          functionResponseParts.push({
            functionResponse: {
              name: toolName,
              response: toolResult,
            },
          });
        } catch (err: any) {
          console.error(`\x1b[31m✖ [Tool Error]\x1b[0m ${err.message}`);
          functionResponseParts.push({
            functionResponse: {
              name: toolName,
              response: { error: err.message },
            },
          });
        }
      }

      // 5. Append tool responses as user turn back to model
      this.history.push({
        role: 'user',
        parts: functionResponseParts,
      });
    }

    return `Agent reached maximum turns limit (${maxTurns}) without final completion.`;
  }
}
