/**
 * @fileoverview CI Healer Agent — the third autonomous teammate that fixes red builds.
 *
 * **What this module does**
 * - Watches a PR/branch whose CI is red, reproduces the failure locally inside `workspaceRoot`,
 *   diagnoses via Gemini tool-calling loop (read → grep → patch/write), verifies with `run_command`,
 *   and pushes a fix commit back to the PR branch.
 * - Reuses the same sandboxed toolset as {@link CoverageAgent} (`read_file`, `patch_file`, `grep_search`, `run_command`)
 *   so the Healer never escapes the workspace (via {@link resolveWorkspacePath} fix).
 * - Provides structured telemetry (attempts, tool counts, durations) for dashboards.
 *
 * **Performance Optimizations:**
 * - **Free-tier throttle**: 13s gap between Gemini calls (same 5 RPM guard as CoverageAgent/Sentinel).
 * - **429 retry**: 2 attempts with `retryDelay + 2s` backoff.
 * - **Bounded loop**: `maxAttempts` (default 3, capped to 5) prevents doom-loop on unfixable failures.
 * - **Log truncation**: `ciLogTail` capped to 8000 chars before sending to LLM to keep context small.
 * - **Command cache reuse**: Leverages `command_runner` LRU for `git status`/`git log` during checkout.
 *
 * **Key configurations / parameters**
 *
 * | Param / Env | Type | Default | Notes |
 * |-------------|------|---------|-------|
 * | `config.model` (`GEMINI_MODEL`) | `string` | `gemini-2.5-flash` | Overridden via `new HealerAgent('gemini-2.0-flash')` |
 * | `HealContext.failingCommand` | `string` | `npx tsc --noEmit` | Command that failed in CI (e.g. `npm test`) |
 * | `HealContext.branch` | `string` | `targetBranch` | PR branch to checkout; if omitted, heals current workspace branch |
 * | `HealContext.prNumber` | `number` | unset | Used only for PR comment + commit message |
 * | `HealContext.ciLogTail` | `string` | unset | Last ~200 lines of CI log (truncated to 8k) |
 * | `HealContext.maxAttempts` | `number` | `3` | Bounded to 5; one LLM turn per attempt |
 * | `config.healerMaxAttempts` (`HEALER_MAX_ATTEMPTS`) | `number` | `3` | Global cap |
 * | `HealerAgent.HEALER_MAX_TURNS` | `const` | `10` | Hard LLM turn limit per `heal()` (not per attempt) |
 *
 * **Usage examples**
 * ```ts
 * import { HealerAgent } from './healer_agent.js';
 *
 * const healer = new HealerAgent();
 * await healer.initWorkspace();
 *
 * // 1. Heal a PR that failed `npm test`
 * const res = await healer.heal({
 *   prNumber: 42,
 *   branch: 'feat/add-checkout',
 *   failingCommand: 'npm test',
 *   ciLogTail: fs.readFileSync('/tmp/ci.log','utf8').slice(-8000),
 * });
 * console.log(res.healed ? `Fixed in ${res.attempts} attempts` : `Gave up: ${res.summary}`);
 *
 * // 2. Heal `tsc` on current branch
 * await healer.heal({ failingCommand: 'npx tsc --noEmit' });
 *
 * // 3. Custom branch with more attempts
 * await healer.heal({ branch: 'fix/login-bug', failingCommand: 'npx eslint .', maxAttempts: 5 });
 * ```
 *
 * **Edge cases / gotchas**
 * - `heal()` **mutates the PR branch** and pushes — caller must set `HEALER_ALLOW_PUSH=true` or pass `allowPush:true` else dry-run only.
 * - If the branch has diverged, `git checkout` will `fetch` + `checkout -B` (force) to ensure Healer works on latest CI HEAD.
 * - Tool errors are fed back as `{ error }` function responses so LLM can self-fix (same as CoverageAgent).
 * - If `failingCommand` is `undefined`, defaults to `npx tsc --noEmit` (fastest smoke check).
 * - History is reset at start of each `heal()` — no cross-PR leakage.
 * - First `models.generateContent` will throw if `GEMINI_API_KEY` missing — caller should catch and surface to `console.error`.
 * - Max 3 auto-commits per `heal()` to avoid spamming PR — doom-loop breaker.
 *
 * @see {@link CoverageAgent} — peer for test creation.
 * @see {@link DailyCommitDigestAgent} — peer for digest.
 */

import { GoogleGenAI } from '@google/genai';
import { createGenAIClient, config } from './config.js';
import { agentToolDeclarations, executeAgentTool, GitRepoManager } from './tools/index.js';
import { executeRunCommand } from './tools/command_runner.js';

// ── Telemetry Types ──────────────────────────────────────────────────────

export interface HealerTurnMetrics {
  turnNumber: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  toolCalls: { name: string; durationMs: number; success: boolean }[];
  hasTextResponse: boolean;
  hasFunctionCalls: boolean;
  error?: string;
}

export interface HealerMetrics {
  healId: string;
  branch: string;
  prNumber?: number;
  failingCommand: string;
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  attempts: number;
  totalTurns: number;
  totalToolCalls: number;
  toolCallCounts: Record<string, number>;
  healed: boolean;
  finalError?: string;
}

function generateHealId(): string {
  return `heal_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

// ── Free-tier throttle ──────────────────────────────────────────────────
const HEALER_FREE_TIER_INTERVAL_MS = process.env.VITEST ? 0 : 13_000;
const sleepHealer = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── HealContext & Result ────────────────────────────────────────────────

export interface HealContext {
  /** PR number for commit message / PR comment. If omitted, message is generic. */
  prNumber?: number;
  /** PR branch to checkout (e.g. `feat/add-checkout`). Defaults to current workspace branch. */
  branch?: string;
  /** Command that failed in CI. Defaults to `npx tsc --noEmit` (fastest). */
  failingCommand?: string;
  /** Last ~200 lines of CI log (truncated to 8000 chars before LLM). */
  ciLogTail?: string;
  /** Max LLM heal attempts. Defaults to `config.healerMaxAttempts` (3, capped 5). */
  maxAttempts?: number;
  /** If true, push fix commit to remote. Requires `GITHUB_TOKEN`. Defaults to false (dry-run). */
  allowPush?: boolean;
}

export interface HealResult {
  /** True if `failingCommand` now exits 0 after fix. */
  healed: boolean;
  /** Human summary for PR comment / digest. */
  summary: string;
  /** Number of LLM attempts executed. */
  attempts: number;
  /** Full metrics for observability. */
  metrics: HealerMetrics;
  /** Fix commit SHA if pushed. */
  fixCommitSha?: string;
}

// ── AgentMessage (reuse typed pattern from CoverageAgent) ───────────────

export interface HealerPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  thought?: boolean;
}

export interface HealerMessage {
  role: 'user' | 'model';
  parts: HealerPart[];
}

const HEALER_MAX_TURNS = 10;
const LOG_TAIL_MAX_CHARS = 8000;
const HEALER_MAX_ATTEMPTS_CAP = 5;

/**
 * Autonomous CI Healer — fixes red builds by reproducing, diagnosing, patching, and verifying.
 *
 * @category Agents
 */
export class HealerAgent {
  private client: GoogleGenAI;
  private model: string;
  private repoManager: GitRepoManager;
  private history: HealerMessage[] = [];
  private lastGeminiCallMs = 0;
  private currentMetrics: HealerMetrics | null = null;

  constructor(customModel?: string) {
    this.client = createGenAIClient();
    this.model = customModel || config.model;
    this.repoManager = new GitRepoManager();
  }

  public getRepoManager(): GitRepoManager {
    return this.repoManager;
  }

  public resetHistory(): void {
    this.history = [];
  }

  public getLastMetrics(): HealerMetrics | null {
    return this.currentMetrics;
  }

  public async initWorkspace(): Promise<void> {
    console.log('\n\x1b[36m⚙️  Preparing Healer workspace...\x1b[0m');
    const start = Date.now();
    const res = await this.repoManager.setupWorkspace();
    console.log(`\x1b[32m✔  ${res.message}\x1b[0m \x1b[90m(${Date.now() - start}ms)\x1b[0m\n`);
  }

  /**
   * Heals a red CI branch by reproducing the failure and iteratively fixing via LLM.
   *
   * Contract:
   * - Input: `HealContext` (branch, failingCommand, ciLogTail). All optional with defaults.
   * - Output: `HealResult.healed` true iff `failingCommand` exits 0 after ≤ maxAttempts.
   * - Error cases: Throws if Gemini auth missing; returns `healed:false` on unfixable (max attempts).
   * - Edge: Empty `ciLogTail` → LLM diagnoses from command stderr only; empty workspace → throws.
   */
  public async heal(context: HealContext = {}): Promise<HealResult> {
    const healId = generateHealId();
    const branch = context.branch || config.targetBranch;
    const failingCommand = context.failingCommand || 'npx tsc --noEmit';
    const maxAttempts = Math.min(context.maxAttempts ?? (config as unknown as { healerMaxAttempts?: number }).healerMaxAttempts ?? 3, HEALER_MAX_ATTEMPTS_CAP);
    const ciLog = (context.ciLogTail || '').slice(-LOG_TAIL_MAX_CHARS);
    const allowPush = context.allowPush ?? false;

    const metrics: HealerMetrics = {
      healId,
      branch,
      prNumber: context.prNumber,
      failingCommand,
      startTime: Date.now(),
      endTime: 0,
      totalDurationMs: 0,
      attempts: 0,
      totalTurns: 0,
      totalToolCalls: 0,
      toolCallCounts: {},
      healed: false,
    };
    this.currentMetrics = metrics;
    this.history = [];

    console.log(`\x1b[36m[Healer:${healId}]\x1b[0m Branch \x1b[1m${branch}\x1b[0m — healing \x1b[33m${failingCommand}\x1b[0m (max ${maxAttempts} attempts)`);

    const workspaceRoot = this.repoManager.getWorkspacePath();

    // 1. Checkout PR branch if specified (force to CI HEAD)
    if (context.branch) {
      console.log(`\x1b[36m[Healer]\x1b[0m Checking out \x1b[1m${branch}\x1b[0m...`);
      const checkout = await executeRunCommand(workspaceRoot, {
        command: `git fetch origin ${branch} && git checkout -B ${branch} origin/${branch} || git checkout ${branch}`,
      });
      if (!checkout.success) {
        console.warn(`\x1b[33m[Healer] Checkout warning: ${checkout.stderr.slice(0, 300)}\x1b[0m — continuing on current branch`);
      }
    }

    // 2. Reproduce failure
    const repro = await executeRunCommand(workspaceRoot, { command: failingCommand });
    if (repro.success) {
      metrics.endTime = Date.now();
      metrics.totalDurationMs = metrics.endTime - metrics.startTime;
      metrics.healed = true;
      const summary = `No fix needed — \`${failingCommand}\` already passes.`;
      console.log(`\x1b[32m[Healer:${healId}] ${summary}\x1b[0m`);
      return { healed: true, summary, attempts: 0, metrics };
    }

    console.log(`\x1b[31m[Healer] Repro confirmed: exit ${repro.exitCode}\x1b[0m — ${repro.stderr.slice(0, 400)}`);

    // 3. Iterative LLM healing loop (bounded)
    const systemInstruction = this.buildSystemInstruction(failingCommand, ciLog, repro.stderr);

    const initialPrompt = `Heal the red CI.

Branch: ${branch}
Failing command: \`${failingCommand}\`
CI log tail (last 8k):
\`\`\`
${ciLog || repro.stderr.slice(0, LOG_TAIL_MAX_CHARS)}
\`\`\`

Direct stderr from local repro:
\`\`\`
${repro.stderr.slice(0, LOG_TAIL_MAX_CHARS)}
\`\`\`

Steps:
1. Explore the failing file(s) with read_file / grep_search.
2. Fix the root cause with patch_file or write_file (surgical, not full rewrite).
3. Verify by calling run_command with \`${failingCommand}\` until it passes.
4. When green, stop — I will handle the commit.

You have ${maxAttempts} attempts. Work step by step and verify after each fix.`;

    this.history.push({ role: 'user', parts: [{ text: initialPrompt }] });

    const tools = [{ functionDeclarations: agentToolDeclarations }];

    let healTurns = 0;
    let attempts = 0;

    while (attempts < maxAttempts && healTurns < HEALER_MAX_TURNS) {
      healTurns++;
      attempts++;
      metrics.attempts = attempts;

      console.log(`\n\x1b[90m[Healer Turn ${healTurns}/${HEALER_MAX_TURNS} | Attempt ${attempts}/${maxAttempts}]\x1b[0m`);

      // Throttle for free tier
      const sinceLast = Date.now() - this.lastGeminiCallMs;
      if (this.lastGeminiCallMs !== 0 && sinceLast < HEALER_FREE_TIER_INTERVAL_MS) {
        const waitMs = HEALER_FREE_TIER_INTERVAL_MS - sinceLast;
        console.log(`\x1b[90m⏳ Throttle ${Math.ceil(waitMs / 1000)}s...\x1b[0m`);
        await sleepHealer(waitMs);
      }

      let response: { candidates?: Array<{ content?: { parts?: HealerPart[] } }>; text?: string } | undefined;
      let attempt = 0;
      while (true) {
        try {
          this.lastGeminiCallMs = Date.now();
          response = (await this.client.models.generateContent({
            model: this.model,
            contents: this.history as unknown as never,
            config: { systemInstruction, tools },
          })) as unknown as { candidates?: Array<{ content?: { parts?: HealerPart[] } }>; text?: string };
          break;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const status = (err as { status?: number })?.status;
          const is429 = status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
          const m = msg.match(/retryDelay.*?(\d+)s/i) || msg.match(/Please retry in (\d+)/i);
          const retrySec = m ? parseInt(m[1], 10) : 50;
          if (is429 && attempt < 2) {
            attempt++;
            const waitMs = (retrySec + 2) * 1000;
            console.warn(`\x1b[33m[Healer] 429 — wait ${retrySec}s (attempt ${attempt}/2)\x1b[0m`);
            await sleepHealer(waitMs);
            continue;
          }
          throw err;
        }
      }

      const candidate = response.candidates?.[0];
      if (!candidate?.content) throw new Error('No candidate content from Gemini (Healer)');

      this.history.push(candidate.content as HealerMessage);

      const textParts = candidate.content.parts?.filter((p) => p.text);
      if (textParts?.length) {
        for (const p of textParts) if (p.text?.trim()) console.log(`\x1b[37m${p.text}\x1b[0m`);
      }

      const functionCalls = candidate.content.parts?.filter((p) => p.functionCall);
      if (!functionCalls?.length) {
        console.log(`\x1b[33m[Healer] No tool calls this turn — checking if healed...\x1b[0m`);
      } else {
        const functionResponseParts: HealerPart[] = [];
        for (const part of functionCalls) {
          const call = part.functionCall!;
          const toolName = call.name || 'unknown_tool';
          const t0 = Date.now();
          console.log(`\x1b[36m⚙️ [Tool]\x1b[0m \x1b[1m${toolName}\x1b[0m(${JSON.stringify(call.args)})`);
          let toolResult: unknown;
          let toolError: string | undefined;
          try {
            toolResult = await executeAgentTool(toolName, call.args as unknown, workspaceRoot, this.repoManager);
            metrics.totalToolCalls++;
            metrics.toolCallCounts[toolName] = (metrics.toolCallCounts[toolName] || 0) + 1;
            console.log(`\x1b[32m✔ ${toolName}\x1b[0m ${JSON.stringify(toolResult).slice(0, 250)} \x1b[90m(${Date.now() - t0}ms)\x1b[0m`);
            functionResponseParts.push({ functionResponse: { name: toolName, response: toolResult } });
          } catch (err: unknown) {
            toolError = err instanceof Error ? err.message : String(err);
            metrics.totalToolCalls++;
            metrics.toolCallCounts[toolName] = (metrics.toolCallCounts[toolName] || 0) + 1;
            console.error(`\x1b[31m✖ ${toolName} ${toolError}\x1b[0m`);
            functionResponseParts.push({ functionResponse: { name: toolName, response: { error: toolError } } });
          }
        }
        this.history.push({ role: 'user', parts: functionResponseParts as HealerPart[] });
      }

      // 4. Verify after each attempt
      const verify = await executeRunCommand(workspaceRoot, { command: failingCommand });
      metrics.totalTurns = healTurns;

      if (verify.success) {
        console.log(`\x1b[32m[Healer:${healId}] ✔ Healed in ${attempts} attempt(s)!\x1b[0m`);

        let fixSha: string | undefined;
        if (allowPush) {
          const commitMsg = `fix(ci): Heal ${failingCommand} for ${branch}${context.prNumber ? ` (#${context.prNumber})` : ''}

Auto-fixed by PRism Healer (${healId}) after ${attempts} attempt(s).
Failing command: ${failingCommand}
${ciLog.slice(0, 300)}

Co-authored-by: PRism Healer <healer@prism.dev>`;

          // Escape commit message for shell — use heredoc via run_command would be safer, but we use file
          const pushRes = await this.commitAndPush(workspaceRoot, branch, commitMsg, allowPush);
          fixSha = pushRes.sha;
          if (pushRes.pushed) {
            console.log(`\x1b[32m[Healer] Pushed fix ${fixSha} to ${branch}\x1b[0m`);
            if (context.prNumber && config.githubToken) {
              await this.commentOnPr(context.prNumber, failingCommand, attempts, fixSha, allowPush);
            }
          }
        } else {
          console.log(`\x1b[33m[Healer] Dry-run — not pushing (set allowPush:true to push)\x1b[0m`);
        }

        metrics.endTime = Date.now();
        metrics.totalDurationMs = metrics.endTime - metrics.startTime;
        metrics.healed = true;

        return {
          healed: true,
          summary: `Healed \`${failingCommand}\` in ${attempts} attempt(s)${fixSha ? ` — ${fixSha.slice(0, 7)}` : ' (dry-run)'}.`,
          attempts,
          metrics,
          fixCommitSha: fixSha,
        };
      }

      console.log(`\x1b[31m[Healer] Still red after attempt ${attempts}: ${verify.stderr.slice(0, 300)}\x1b[0m`);
      // Feed verification failure back to LLM
      this.history.push({
        role: 'user',
        parts: [{ text: `Verification still failing for \`${failingCommand}\` (exit ${verify.exitCode}):\n\`\`\`\n${verify.stderr.slice(0, LOG_TAIL_MAX_CHARS)}\n\`\`\`\nFix and retry.` }],
      });
    }

    // Max attempts exhausted
    metrics.endTime = Date.now();
    metrics.totalDurationMs = metrics.endTime - metrics.startTime;
    metrics.healed = false;
    const summary = `Failed to heal \`${failingCommand}\` after ${attempts} attempt(s) / ${healTurns} turns.`;
    console.warn(`\x1b[33m[Healer:${healId}] ${summary}\x1b[0m`);
    return { healed: false, summary, attempts, metrics };
  }

  private buildSystemInstruction(failingCommand: string, ciLog: string, stderr: string): string {
    return `You are PRism Healer, an expert autonomous CI fixer.
Your job is to make the failing command pass by diagnosing and patching the minimal code.

Rules:
1. Workspace is at the cloned repo root. Never escape it (resolveWorkspacePath enforces sandbox).
2. Prefer surgical patch_file over full write_file. Provide exact targetContent.
3. After each patch, call run_command with "${failingCommand}" to verify — do not assume green.
4. Fix root cause: missing imports, type errors, eslint violations, stale snapshots, flaky mocks.
5. Do NOT edit .env, .git, or credentials. Do NOT run destructive commands (rm -rf /, sudo).
6. Keep commit small — one logical fix per heal.
7. If truly unfixable, explain why in text and stop tool calls.

Failing command: ${failingCommand}
Use write_file/patch_file/grep_search/read_file/run_command exactly as needed.`;
  }

  private async commitAndPush(
    workspaceRoot: string,
    branch: string,
    commitMsg: string,
    allowPush: boolean
  ): Promise<{ pushed: boolean; sha?: string }> {
    if (!allowPush) return { pushed: false };

    // Stage all changes (Healer may have touched multiple files)
    await executeRunCommand(workspaceRoot, { command: 'git add -A' });

    // Commit — escape message via file to avoid shell quoting issues
    const msgFile = '.git/healer_commit_msg.txt';
    const wsMsgPath = `${workspaceRoot}/${msgFile}`;
    try {
      const { writeFileSync } = await import('fs');
      writeFileSync(wsMsgPath, commitMsg, 'utf8');
    } catch {
      // Fallback to direct commit with single-line message
      const safeMsg = commitMsg.split('\n')[0].replace(/"/g, "'");
      const commit = await executeRunCommand(workspaceRoot, { command: `git commit -m "${safeMsg}"` });
      if (!commit.success) return { pushed: false };
      return this.pushBranch(workspaceRoot, branch);
    }

    const commit = await executeRunCommand(workspaceRoot, { command: `git commit -F ${msgFile}` });
    if (!commit.success) {
      // Nothing to commit?
      if (commit.stderr.includes('nothing to commit')) return { pushed: false };
      return { pushed: false };
    }

    return this.pushBranch(workspaceRoot, branch);
  }

  private async pushBranch(workspaceRoot: string, branch: string): Promise<{ pushed: boolean; sha?: string }> {
    const shaRes = await executeRunCommand(workspaceRoot, { command: 'git rev-parse HEAD' });
    const sha = shaRes.success ? shaRes.stdout.trim() : undefined;

    const push = await executeRunCommand(workspaceRoot, { command: `git push origin ${branch}` });
    return { pushed: push.success, sha };
  }

  private async commentOnPr(prNumber: number, failingCommand: string, attempts: number, sha: string | undefined, pushed: boolean): Promise<void> {
    if (!pushed || !sha) return;
    const { config } = await import('./config.js');
    const { parseGitHubRepoUrl } = await import('./config.js');
    try {
      const { owner, repo } = parseGitHubRepoUrl(config.targetRepoUrl);
      const token = config.githubToken;
      if (!token) return;

      const body = `### 🚑 Healed by PRism Healer

**Failing command:** \`${failingCommand}\`
**Attempts:** ${attempts}
**Fix commit:** \`${sha.slice(0, 7)}\`
**Status:** ${pushed ? 'Pushed to branch' : 'Dry-run (not pushed)'}

The build is now green locally. If CI is still red, reply \`@prism retry\`.

*Healer ID: \`${sha.slice(0, 7)}\`*`;

      await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      });
    } catch {
      // Best-effort — do not fail heal if comment fails
    }
  }
}
