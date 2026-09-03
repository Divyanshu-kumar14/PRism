/**
 * @fileoverview Autonomous Test Coverage & PR agent — the `CoverageAgent` reasoning loop.
 *
 * **What this module does**
 * - Implements the Gemini tool‑calling loop that **explores → tests → verifies → opens a PR**.
 * - Maintains an ever‑growing `history: AgentMessage[]` so each `generateContent` call
 *   has full conversational context (user messages + tool results).
 * - Delegates every side‑effect to {@link executeAgentTool} (file ops, `run_command`, `create_pr`).
 * - Provides structured telemetry/metrics for observability (turn timing, tool usage, errors).
 *
 * **Performance Optimizations:**
 * - **Free-tier throttle**: 13s minimum interval between Gemini calls to stay under 5 RPM.
 *   Prevents 429 RESOURCE_EXHAUSTED errors on free tier without billing.
 * - **Retry with exponential backoff**: On 429, waits `retryDelay + 2s` up to 2 attempts.
 * - **History management**: `resetHistory()` clears context between independent runs to
 *   prevent context window overflow and reduce token costs.
 * - **Structured logging**: Turn-level and tool-level timing for observability dashboards.
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
 * - `history` is **append‑only** inside a single `chat()` invocation. The "no tool calls → return"
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

// ── Telemetry Types ──────────────────────────────────────────────────────

/** Per-turn metrics for observability. */
export interface TurnMetrics {
  turnNumber: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  toolCalls: ToolCallMetric[];
  hasTextResponse: boolean;
  hasFunctionCalls: boolean;
  error?: string;
}

/** Per-tool-call metrics for observability. */
export interface ToolCallMetric {
  toolName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

/** Mission-level summary metrics. */
export interface MissionMetrics {
  missionId: string;
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  totalTurns: number;
  totalToolCalls: number;
  toolCallCounts: Record<string, number>;
  success: boolean;
  finalError?: string;
  focusArea?: string;
  customPrompt?: boolean;
}

/** Simple mission ID generator for tracing. */
function generateMissionId(): string {
  return `mission_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Formats duration in human-readable form. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

// ── Free-tier throttling ─────────────────────────────────────────────────

// Free-tier throttling: 5 RPM → 13s gap (see digest_agent.ts)
const FREE_TIER_MIN_INTERVAL_MS_COV = 13_000;
const sleepCov = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── AgentMessage & RunMissionOptions ─────────────────────────────────────

export interface AgentPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  thought?: boolean;
}

/** Gemini‑style content block the SDK expects (thinly typed; SDK drift guarded via AgentPart). */
export interface AgentMessage {
  role: 'user' | 'model';
  parts: AgentPart[];
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
  private lastGeminiCallMs = 0;

  // Telemetry state
  private currentMissionMetrics: MissionMetrics | null = null;
  private currentTurnMetrics: TurnMetrics | null = null;
  private missionStartTime = 0;

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
   * Returns the telemetry metrics for the last completed mission.
   * Useful for observability dashboards and debugging.
   */
  public getLastMissionMetrics(): MissionMetrics | null {
    return this.currentMissionMetrics;
  }

  /**
   * Returns the telemetry metrics for the current/last turn.
   */
  public getLastTurnMetrics(): TurnMetrics | null {
    return this.currentTurnMetrics;
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
    const startTime = Date.now();
    const result = await this.repoManager.setupWorkspace();
    const durationMs = Date.now() - startTime;
    console.log(`\x1b[32m✔  ${result.message}\x1b[0m \x1b[90m(${durationMs}ms)\x1b[0m\n`);
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

    // Initialize mission telemetry
    const missionId = generateMissionId();
    this.missionStartTime = Date.now();
    this.currentMissionMetrics = {
      missionId,
      startTime: this.missionStartTime,
      endTime: 0,
      totalDurationMs: 0,
      totalTurns: 0,
      totalToolCalls: 0,
      toolCallCounts: {},
      success: false,
      focusArea: options.focusArea,
      customPrompt: !!options.customPrompt,
    };

    console.log(`\x1b[36m[Telemetry]\x1b[0m Mission started: ${missionId} ${options.focusArea ? `(focus: ${options.focusArea})` : ''}`);

    try {
      const result = await this.chat(missionPrompt, workspaceRoot);

      // Finalize mission metrics
      const missionEndTime = Date.now();
      if (this.currentMissionMetrics) {
        this.currentMissionMetrics.endTime = missionEndTime;
        this.currentMissionMetrics.totalDurationMs = missionEndTime - this.missionStartTime;
        this.currentMissionMetrics.success = true;
        console.log(`\x1b[36m[Telemetry]\x1b[0m Mission completed: ${missionId} in ${formatDuration(this.currentMissionMetrics.totalDurationMs)} (${this.currentMissionMetrics.totalTurns} turns, ${this.currentMissionMetrics.totalToolCalls} tool calls)`);
      }

      return result;
    } catch (error: unknown) {
      // Finalize mission metrics on error
      const missionEndTime = Date.now();
      if (this.currentMissionMetrics) {
        this.currentMissionMetrics.endTime = missionEndTime;
        this.currentMissionMetrics.totalDurationMs = missionEndTime - this.missionStartTime;
        this.currentMissionMetrics.success = false;
        this.currentMissionMetrics.finalError = (error instanceof Error ? error.message : String(error));
        console.error(`\x1b[31m[Telemetry]\x1b[0m Mission failed: ${missionId} after ${formatDuration(this.currentMissionMetrics.totalDurationMs)} — ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
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
   * - Tool errors are fed back as `{ error: (err instanceof Error ? err.message : String(err)) }` function responses so the LLM can self‑fix.
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
      const turnStartTime = Date.now();

      // Initialize turn telemetry
      this.currentTurnMetrics = {
        turnNumber: turns,
        startTime: turnStartTime,
        endTime: 0,
        durationMs: 0,
        toolCalls: [],
        hasTextResponse: false,
        hasFunctionCalls: false,
      };

      console.log(`\n\x1b[90m[Turn ${turns}/${maxTurns}] Agent thinking...\x1b[0m`);

      // Free-tier throttle: keep <5 RPM to avoid 429 on free tier (see digest_agent)
      const sinceLast = Date.now() - this.lastGeminiCallMs;
      if (this.lastGeminiCallMs !== 0 && sinceLast < FREE_TIER_MIN_INTERVAL_MS_COV) {
        const waitMs = FREE_TIER_MIN_INTERVAL_MS_COV - sinceLast;
        console.log(`\x1b[90m⏳ Free-tier throttle: waiting ${Math.ceil(waitMs / 1000)}s...\x1b[0m`);
        await sleepCov(waitMs);
      }

      let response: { candidates?: Array<{ content?: { parts?: AgentPart[] } }>; text?: string } | undefined;
      let attempt = 0;
      while (true) {
        try {
          this.lastGeminiCallMs = Date.now();
          response = (await this.client.models.generateContent({
            model: this.model,
            // Cast to accommodate SDK Content type while keeping our typed AgentMessage
            contents: this.history as unknown as never,
            config: {
              systemInstruction,
              tools,
            },
          })) as unknown as { candidates?: Array<{ content?: { parts?: AgentPart[] } }>; text?: string };
          break;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const errStatus = (err as { status?: number })?.status;
          const msg = errorMessage || '';
          const is429 = errStatus === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded');
          const retryMatch = msg.match(/retryDelay.*?(\d+)s/i) || msg.match(/Please retry in (\d+)/i);
          const retrySec = retryMatch ? parseInt(retryMatch[1], 10) : 50;
          if (is429 && attempt < 2) {
            attempt++;
            const RETRY_BUFFER_SECONDS = 2;
            const waitMs = (retrySec + RETRY_BUFFER_SECONDS) * 1000;
            console.warn(`\x1b[33m⚠️  Gemini 429 — waiting ${retrySec}s (attempt ${attempt}/2)...\x1b[0m`);
            await sleepCov(waitMs);
            continue;
          }
          // Record error in turn metrics
          if (this.currentTurnMetrics) {
            this.currentTurnMetrics.error = msg;
          }
          throw err;
        }
      }

      const candidate = response.candidates?.[0];
      if (!candidate || !candidate.content) {
        throw new Error('No candidate content received from the Gemini model.');
      }

      const modelContent = candidate.content;
      this.history.push(modelContent as AgentMessage);

      // Print any model reasoning/text thought
      const textParts = candidate.content.parts?.filter((p: AgentPart) => p.text);
      if (textParts && textParts.length > 0) {
        for (const p of textParts) {
          if (p.text && typeof p.text === 'string' && p.text.trim()) {
            console.log(`\x1b[37m${p.text}\x1b[0m`);
          }
        }
        if (this.currentTurnMetrics) {
          this.currentTurnMetrics.hasTextResponse = true;
        }
      }

      // 3. Check for function calls
      const functionCalls = candidate.content.parts?.filter((p: AgentPart) => p.functionCall);

      if (!functionCalls || functionCalls.length === 0) {
        // No function calls: agent completed its response
        const turnEndTime = Date.now();
        if (this.currentTurnMetrics) {
          this.currentTurnMetrics.endTime = turnEndTime;
          this.currentTurnMetrics.durationMs = turnEndTime - turnStartTime;
        }
        if (this.currentMissionMetrics) {
          this.currentMissionMetrics.totalTurns = turns;
        }
        return response.text || '(Mission concluded)';
      }

      if (this.currentTurnMetrics) {
        this.currentTurnMetrics.hasFunctionCalls = true;
      }

      // 4. Execute all requested tool calls
      const functionResponseParts = [];

      for (const part of functionCalls) {
        const call = part.functionCall!;
        const toolName = call.name || 'unknown_tool';
        const toolStartTime = Date.now();

        console.log(`\x1b[36m⚙️ [Tool Call]\x1b[0m \x1b[1m${toolName}\x1b[0m(${JSON.stringify(call.args)})`);

        let toolResult: unknown;
        let toolError: string | undefined;

        try {
          toolResult = await executeAgentTool(
            toolName,
            call.args as unknown,
            workspaceRoot,
            this.repoManager
          );

          const toolEndTime = Date.now();
          const toolDurationMs = toolEndTime - toolStartTime;

          // Record tool call metrics
          const toolMetric: ToolCallMetric = {
            toolName,
            startTime: toolStartTime,
            endTime: toolEndTime,
            durationMs: toolDurationMs,
            success: true,
          };

          if (this.currentTurnMetrics) {
            this.currentTurnMetrics.toolCalls.push(toolMetric);
          }
          if (this.currentMissionMetrics) {
            this.currentMissionMetrics.totalToolCalls++;
            this.currentMissionMetrics.toolCallCounts[toolName] = (this.currentMissionMetrics.toolCallCounts[toolName] || 0) + 1;
          }

          // Log brief summary of tool output
          const summaryStr = JSON.stringify(toolResult);
          const truncatedSummary = summaryStr.length > 250 ? summaryStr.slice(0, 250) + '...' : summaryStr;
          console.log(`\x1b[32m✔ [Tool Result]\x1b[0m ${truncatedSummary} \x1b[90m(${toolDurationMs}ms)\x1b[0m`);

          functionResponseParts.push({
            functionResponse: {
              name: toolName,
              response: toolResult,
            },
          });
        } catch (err: unknown) {
          const toolEndTime = Date.now();
          const toolDurationMs = toolEndTime - toolStartTime;
          toolError = (err instanceof Error ? err.message : String(err));

          // Record failed tool call metrics
          const toolMetric: ToolCallMetric = {
            toolName,
            startTime: toolStartTime,
            endTime: toolEndTime,
            durationMs: toolDurationMs,
            success: false,
            error: toolError,
          };

          if (this.currentTurnMetrics) {
            this.currentTurnMetrics.toolCalls.push(toolMetric);
          }
          if (this.currentMissionMetrics) {
            this.currentMissionMetrics.totalToolCalls++;
            this.currentMissionMetrics.toolCallCounts[toolName] = (this.currentMissionMetrics.toolCallCounts[toolName] || 0) + 1;
          }

          console.error(`\x1b[31m✖ [Tool Error]\x1b[0m ${toolError} \x1b[90m(${toolDurationMs}ms)\x1b[0m`);
          functionResponseParts.push({
            functionResponse: {
              name: toolName,
              response: { error: toolError },
            },
          });
        }
      }

      // 5. Append tool responses as user turn back to model
      this.history.push({
        role: 'user',
        parts: functionResponseParts,
      });

      // Finalize turn metrics
      const turnEndTime = Date.now();
      if (this.currentTurnMetrics) {
        this.currentTurnMetrics.endTime = turnEndTime;
        this.currentTurnMetrics.durationMs = turnEndTime - turnStartTime;
      }
    }

    // Max turns reached
    if (this.currentMissionMetrics) {
      this.currentMissionMetrics.totalTurns = turns;
      this.currentMissionMetrics.success = false;
      this.currentMissionMetrics.finalError = `Reached maximum turns limit (${maxTurns})`;
    }

    return `Agent reached maximum turns limit (${maxTurns}) without final completion.`;
  }
}