/**
 * @fileoverview Daily Commit & Vulnerability Digest agent — the `DailyCommitDigestAgent` reasoning loop.
 *
 * **What this module does**
 * - Implements the Sentinel tool‑calling loop: `get_recent_commits → get_commit_diff → run_security_audit → send_digest_email`.
 * - Caches the `get_recent_commits` payload in `this.cachedCommits` so `send_digest_email`
 *   can render the full commit feed without relying on the LLM to paste SHAs.
 * - Keeps the same `history` / `maxTurns` / `generateContent` loop shape as {@link CoverageAgent}
 *   so behavior under token/time pressure is identical.
 *
 * **Key configurations / parameters**
 *
 * | Param / Env | Type | Default | Notes |
 * |-------------|------|---------|-------|
 * | `RunDigestOptions.since` | `string` | `"24 hours ago"` | Anything `git log --since` accepts (`"7 days ago"`, `"2026-09-01"`). Normalised by CLI (`7d`→`7 days ago`) before arriving here |
 * | `RunDigestOptions.recipient` | `string` | `config.emailRecipient` | `To:` override; also baked into the `missionPrompt` + `systemInstruction` |
 * | `RunDigestOptions.forceAll` | `boolean` | `false` | Reserved — not yet consumed (future: include already‑mailed commits) |
 * | `config.cronTimezone` | `string` | `"Asia/Kolkata"` | Controls `reportDate` IST string **and** scheduler evaluation |
 * | `config.model` / `config.maxTurns` | `string`/`number` | `gemini-2.5-flash`/`25` | Same semantics as {@link CoverageAgent} |
 *
 * **Usage examples**
 * ```ts
 * import { DailyCommitDigestAgent } from './digest_agent.js';
 *
 * // 24 h window, default recipient
 * const a = new DailyCommitDigestAgent();
 * await a.initWorkspace();
 * const report = await a.runDigest(); // → "24 hours ago", config.emailRecipient
 *
 * // Weekly audit for a different lead
 * const w = await a.runDigest({ since: '7 days ago', recipient: 'lead@example.com' });
 *
 * // Explicit model for quality eval
 * const pro = new DailyCommitDigestAgent('gemini-1.5-pro');
 * await pro.runDigest({ since: '30 days ago' });
 *
 * // Reset between independent windows
 * a.resetHistory(); // clears history AND cachedCommits
 * ```
 *
 * **Edge cases / gotchas**
 * - `cachedCommits` is only populated when the LLM actually calls `get_recent_commits`.
 *   A run that skips it (prompt injection, maxTurns) will send `commits: []` — the email
 *   still renders but the footer “All Commits” list will be empty.
 * - `resetHistory()` clears **both** `history` and `cachedCommits` — essential when re‑using
 *   an instance for two time windows in the same process (scheduler’s `--run-now` → nightly).
 * - `systemInstruction` forces `send_digest_email` as the final step — if the LLM ignores it,
 *   the loop will exit on “no functionCall” and the caller will still get `response.text`,
 *   but no email will have been sent (caller must check the report archival manually).
 * - `todayIST` uses `Intl.DateTimeFormat` — a bad `cronTimezone` value will throw `RangeError`.
 *   Keep `DIGEST_TIMEZONE` to a valid IANA name (`Asia/Kolkata`, `UTC`, `America/New_York`).
 *
 * @see {@link MailerService} for the downstream rendering / delivery cascade.
 * @see {@link executeGetRecentCommits} for the git‑log fallback (empty window → last 10).
 */

import { GoogleGenAI } from '@google/genai';
import { createGenAIClient, config } from './config.js';
import {
  digestToolDeclarations,
  executeDigestTool,
  GitRepoManager,
} from './tools/index.js';
import { MailerService, CommitSummaryItem } from './services/mailer.js';

/** Gemini‑style content block (kept loose as `any[]` to track SDK changes without churn). */
export interface DigestAgentMessage {
  role: 'user' | 'model';
  parts: any[];
}

/**
 * Controls for {@link DailyCommitDigestAgent#runDigest}.
 */
export interface RunDigestOptions {
  /**
   * Git‑log time window — anything `git log --since="…"` accepts.
   * @defaultValue "24 hours ago"
   * @example "24 hours ago" | "7 days ago" | "30 days ago" | "2026-09-01"
   */
  since?: string;
  /**
   * `To:` address. Overrides `config.emailRecipient` for this run only.
   * Useful for `--to` CLI flag and ad‑hoc investigations.
   */
  recipient?: string;
  /** Reserved — when `true` include commits already summarized outside this window (not yet implemented). */
  forceAll?: boolean;
}

/**
 * Sentinel — analyzes commits, audits security, and dispatches the rich digest email.
 *
 * @category Agents
 * @example
 * ```ts
 * const agent = new DailyCommitDigestAgent();
 * await agent.initWorkspace();
 * console.log(await agent.runDigest({ since: '24 hours ago' }));
 * ```
 */
// Free-tier throttling: 5 RPM → 60/5 = 12s min interval; use 13s to stay safe
// WHY: PRism Sentinel makes 7-10 rapid Gemini calls/digest → free tier 429 after 5.
// Throttling to 13s keeps <5 RPM (≈130s for 10 turns) — no billing needed, just slower.
const FREE_TIER_MIN_INTERVAL_MS = 13_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DailyCommitDigestAgent {
  private client: GoogleGenAI;
  private model: string;
  private repoManager: GitRepoManager;
  private history: DigestAgentMessage[] = [];
  private cachedCommits: CommitSummaryItem[] = [];
  private lastGeminiCallMs = 0;

  /**
   * @param customModel - Gemini model id overriding `config.model` for this instance.
   */
  constructor(customModel?: string) {
    this.client = createGenAIClient();
    this.model = customModel || config.model;
    this.repoManager = new GitRepoManager();
  }

  /** Exposes the workspace manager (clone path, manual git ops). */
  public getRepoManager(): GitRepoManager {
    return this.repoManager;
  }

  /**
   * Clears both `history` and the `cachedCommits` buffer.
   * Required when re‑using an instance across two digest windows.
   */
  public resetHistory(): void {
    this.history = [];
    this.cachedCommits = [];
  }

  /**
   * Ensures the workspace clone exists and is on `origin/<targetBranch>`.
   * Thin wrapper around {@link GitRepoManager#setupWorkspace} with Sentinel‑specific logging.
   */
  public async initWorkspace(): Promise<void> {
    console.log('\n\x1b[36m⚙️  Syncing repository for Daily Digest & Security Audit...\x1b[0m');
    const result = await this.repoManager.setupWorkspace();
    console.log(`\x1b[32m✔  ${result.message}\x1b[0m\n`);
  }

  /**
   * Runs the 8‑step daily‑digest mission end‑to‑end.
   *
   * **Preset LLM procedure (injected as `missionPrompt`):**
   * 1. `get_recent_commits(since)` → fill `cachedCommits`
   * 2. `get_commit_diff` for each commit (deep inspection)
   * 3. `run_security_audit` (regex + `npm audit`)
   * 4. Security analysis → verdict `CLEAN`/`WARNING`/`VULNERABLE`
   * 5. Categorize changes (5 buckets)
   * 6. Summarize authors
   * 7. `send_digest_email(reportDate, timeWindow, … , cachedCommits)`
   * 8. Return executive summary text for the CLI console
   *
   * @param options - Time window + optional recipient override.
   * @returns LLM's final summary text, or a max‑turns sentinel if the loop was cut short.
   * @throws If Gemini returns no candidates/candidate.content.
   */
  public async runDigest(options: RunDigestOptions = {}): Promise<string> {
    const workspaceRoot = this.repoManager.getWorkspacePath();
    const timeframe = options.since || '24 hours ago';
    const recipient = options.recipient || config.emailRecipient;

    const todayIST = new Intl.DateTimeFormat('en-US', {
      timeZone: config.cronTimezone || 'Asia/Kolkata',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date());

    const missionPrompt = `Your mission is to generate the comprehensive Daily Repository Commit & Vulnerability Digest for today (${todayIST}) and email it to "${recipient}".

Follow this exact procedure:
1. Call "get_recent_commits" with since="${timeframe}" to retrieve all recent commits, authors, commit messages, and changed files.
2. For the commits retrieved, call "get_commit_diff" to inspect the actual unified code diffs of the changes.
3. Call "run_security_audit" to check for hardcoded secrets/credentials and package vulnerability status.
4. Perform an expert security & integrity analysis:
   - Secret Leaks: Detect any API keys, tokens, passwords, private keys, database URLs.
   - Code Vulnerabilities: Detect SQLi, Command Injection, XSS, Path Traversal, unhandled exceptions, memory leaks, auth bypass.
   - Breaking Changes: Detect broken public interfaces, missing type checks, or runtime regressions.
   - Provide a clear verdict: "CLEAN", "WARNING", or "VULNERABLE".
5. Group and summarize all changes into categories:
   - 🚀 Features & Enhancements
   - 🐛 Bug Fixes & Patches
   - 🔒 Security & Performance
   - 🧹 Refactoring & Chores
   - 📝 Other modifications
6. Summarize individual author contributions (who did what, commit counts, highlights).
7. Call "send_digest_email" with all structured parameters (reportDate="${todayIST}", timeWindow="${timeframe}", recipientOverride="${recipient}", executiveSummary, securityVerdict, securitySummary, categorizedChanges, vulnerabilities, authors).
8. Once send_digest_email is completed, return a concise executive summary to the console.`;

    const systemInstruction = `You are PRism Sentinel, an expert AI Security Officer and Repository Intelligence Agent.
Your mission is to analyze repository commits, detect security vulnerabilities, secret leaks, and breaking code changes, and dispatch an executive digest to "${recipient}".

Guidelines:
1. Thoroughness: Always review the diffs of commits using get_commit_diff to verify the actual code changes.
2. Security Rigor: Be precise when checking for vulnerabilities. If no issues exist, state that the codebase changes are CLEAN. If vulnerabilities are discovered, specify exact file names, severity (CRITICAL, HIGH, MEDIUM, LOW), and actionable recommendations.
3. Quality Summaries: Make summaries clear, categorized, and informative for engineering leads and developers.
4. Final Dispatch: You MUST call "send_digest_email" to deliver the digest report to the user before completing your mission.`;

    const tools = [
      {
        functionDeclarations: digestToolDeclarations,
      },
    ];

    this.history.push({
      role: 'user',
      parts: [{ text: missionPrompt }],
    });

    let turns = 0;
    const maxTurns = config.maxTurns;

    while (turns < maxTurns) {
      turns++;
      console.log(`\n\x1b[90m[Sentinel Turn ${turns}/${maxTurns}] Analyzing repository changes...\x1b[0m`);

      // Free-tier throttle: ensure <5 RPM (13s gap) — sleep if last call was recent
      // WHY: Free tier quota is 5 req/min per model; without throttle, 7-10 turns hit 429 RESOURCE_EXHAUSTED.
      const sinceLast = Date.now() - this.lastGeminiCallMs;
      if (this.lastGeminiCallMs !== 0 && sinceLast < FREE_TIER_MIN_INTERVAL_MS) {
        const waitMs = FREE_TIER_MIN_INTERVAL_MS - sinceLast;
        console.log(`\x1b[90m⏳ Free-tier throttle: waiting ${Math.ceil(waitMs / 1000)}s to stay <5 RPM...\x1b[0m`);
        await sleep(waitMs);
      }

      // Retry wrapper for 429 RESOURCE_EXHAUSTED — free tier may still spike
      // WHY: Even with throttle, concurrent scheduler + manual digest can exceed 5 RPM; retry after RetryInfo delay.
      let response: any;
      let attempt = 0;
      while (true) {
        try {
          this.lastGeminiCallMs = Date.now();
          response = await this.client.models.generateContent({
            model: this.model,
            contents: this.history,
            config: {
              systemInstruction,
              tools,
            },
          });
          break; // success
        } catch (err: any) {
          const msg = err?.message || '';
          const is429 = err?.status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded');
          const retryMatch = msg.match(/retryDelay.*?(\d+)s/i) || msg.match(/Please retry in (\d+)/i);
          const retrySec = retryMatch ? parseInt(retryMatch[1], 10) : 50;
          if (is429 && attempt < 2) {
            attempt++;
            const waitMs = (retrySec + 2) * 1000;
            console.warn(`\x1b[33m⚠️  Gemini 429 quota hit (attempt ${attempt}/2) — waiting ${retrySec}s then retrying...\x1b[0m`);
            await sleep(waitMs);
            continue;
          }
          throw err;
        }
      }

      const candidate = response.candidates?.[0];
      if (!candidate || !candidate.content) {
        throw new Error('No response received from Gemini Sentinel model.');
      }

      const modelContent = candidate.content;
      this.history.push(modelContent as DigestAgentMessage);

      // Print any model reasoning
      const textParts = candidate.content.parts?.filter((p: any) => p.text);
      if (textParts && textParts.length > 0) {
        for (const p of textParts) {
          if (p.text && typeof p.text === 'string' && p.text.trim()) {
            console.log(`\x1b[37m${p.text}\x1b[0m`);
          }
        }
      }

      // Check function calls
      const functionCalls = candidate.content.parts?.filter((p: any) => p.functionCall);
      if (!functionCalls || functionCalls.length === 0) {
        return response.text || '(Daily Digest Mission concluded)';
      }

      const functionResponseParts = [];

      for (const part of functionCalls) {
        const call = part.functionCall!;
        const toolName = call.name || 'unknown_tool';
        console.log(`\x1b[36m⚙️ [Tool Call]\x1b[0m \x1b[1m${toolName}\x1b[0m(${JSON.stringify(call.args)})`);

        try {
          const toolResult = await executeDigestTool(
            toolName,
            call.args,
            workspaceRoot,
            this.cachedCommits
          );

          // If commits were fetched, cache them for email rendering
          if (toolName === 'get_recent_commits' && toolResult.commits) {
            this.cachedCommits = toolResult.commits;
          }

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

      this.history.push({
        role: 'user',
        parts: functionResponseParts,
      });
    }

    return `Agent reached maximum turn limit (${maxTurns}) while compiling daily digest.`;
  }
}
