/**
 * @fileoverview Daily Digest & security audit toolset for {@link DailyCommitDigestAgent}.
 *
 * **What this module does**
 * - Implements the four Gemini-callable tools that power the Sentinel agent:
 *   1. `get_recent_commits` — `git log` with time-window + file-list per commit
 *   2. `get_commit_diff`   — `git show` / `git diff` unified diffs for deep inspection
 *   3. `run_security_audit` — regex secret-scan + `npm audit` wrapper
 *   4. `send_digest_email` — render + send (and archive) the HTML/Markdown report
 * - Keeps all `git` / `fs` work inside `workspaceRoot` (via `execAsync` cwd).
 *
 * **Key configurations / parameters**
 *
 * | Tool                  | Param              | Type      | Default         | Notes |
 * |-----------------------|--------------------|-----------|-----------------|-------|
 * | `get_recent_commits`  | `since`            | `string`  | `"24 hours ago"`| Passed to `git log --since="…"`, accepts `"7 days ago"`, `"2026-09-01"` |
 * |                       | `maxCount`         | `number`  | `50`            | Hard cap on commits returned |
 * |                       | `branch`           | `string`  | `config.targetBranch` | |
 * | `get_commit_diff`     | `commitHash`       | `string`  | —               | Single commit `git show <hash>` |
 * |                       | `fromHash` + `toHash` | `string` | —            | Range `git diff from..to` |
 * |                       | `maxLines`         | `number`  | `500`           | Truncates with `…[Diff truncated]` |
 * | `run_security_audit`  | `includeNpmAudit`  | `boolean` | `true`          | Skip `npm audit` when `false` |
 * | `send_digest_email`   | `reportDate`       | `string`  | — (required)    | IST human date, e.g. `September 1, 2026` |
 * |                       | `securityVerdict`  | `enum`    | — (required)    | `CLEAN` · `WARNING` · `VULNERABLE` |
 * |                       | `vulnerabilities`  | `array`   | — (required)    | Each: `{ severity, title, description, recommendation, file?, commitHash? }` |
 * |                       | `authors`          | `array`   | — (required)    | Each: `{ name, email, commitCount, additions, deletions, summary }` |
 * |                       | `recipientOverride`| `string` | `config.emailRecipient` | |
 *
 * **Usage examples**
 * ```ts
 * // 1. Recent commits
 * const { commits, allFiles } = await executeGetRecentCommits(ws, { since: '7 days ago', maxCount: 20 });
 *
 * // 2. Inspect a suspicious commit
 * const { diff } = await executeGetCommitDiff(ws, { commitHash: 'a1b2c3d' });
 *
 * // 3. Security audit (no npm audit)
 * const { secretScanResults, status } = await executeRunSecurityAudit(ws, { includeNpmAudit: false });
 *
 * // 4. Final dispatch
 * await executeSendDigestEmail(ws, {
 *   reportDate: 'September 1, 2026', timeWindow: '24 hours ago',
 *   totalCommits: commits.length, totalFilesChanged: allFiles.length,
 *   executiveSummary: '…', securityVerdict: 'CLEAN', securitySummary: 'No issues',
 *   categorizedChanges: { features:[], fixes:[], security:[], refactoring:[], other:[] },
 *   vulnerabilities: [], authors: [...]
 * }, commits);
 * ```
 *
 * **Edge cases / gotchas**
 * - `get_recent_commits`: On **empty window**, falls back to the latest 10 commits and
 *   rewrites `timeWindow` to `Latest N commits (No commits in '…')`. A truly empty repo
 *   returns `{ commits: [], count: 0 }`.
 * - Shallow clones (`--depth 50` in `repo.ts`) can hide old commits — `since=30d` may
 *   silently return fewer than expected.
 * - Secret scan only inspects **`git diff HEAD~5 HEAD`** added lines (`+…`). Older leaks
 *   outside that 5-commit window are not flagged.
 * - `npm audit --json` writes to `stdout` **on failure** (non-zero exit) — handled via
 *   `.catch(err => err.stdout)` so audit data is still parsed.
 * - `send_digest_email` reuses `cachedCommits` from the earlier `get_recent_commits` call
 *   to render the full commits feed — ensure that tool was called first in the agent loop.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import type { FunctionDeclaration } from '@google/genai';
import { MailerService, DigestReportData, CommitSummaryItem } from '../services/mailer.js';
import { config } from '../config.js';

const execAsync = promisify(exec);

// ── Param interfaces ───────────────────────────────────────────────

/**
 * Parameters for `get_recent_commits`.
 * Uses `git log --since="…"` with a custom `||PRISM_COMMIT_SEP||` / `||FIELD_SEP||` format
 * to safely split hashes, authors, and multi-line bodies.
 */
export interface GetRecentCommitsParams {
  /**
   * Timeframe filter passed verbatim to `git log --since`.
   * @defaultValue "24 hours ago"
   * @example "24 hours ago" | "7 days ago" | "30 days ago" | "2026-09-01"
   */
  since?: string;
  /** Max commits to return. @defaultValue 50 */
  maxCount?: number;
  /** Branch to query. @defaultValue `config.targetBranch` */
  branch?: string;
}

/**
 * Parameters for `get_commit_diff`.
 * Exactly one of the following combos should be set:
 * - `commitHash` → `git show <hash>`
 * - `fromHash` + `toHash` → `git diff from..to`
 * - neither → `git show HEAD` (most recent commit)
 */
export interface GetCommitDiffParams {
  /** Single commit to inspect (e.g. `"a1b2c3d"`). */
  commitHash?: string;
  /** Start of a range comparison. */
  fromHash?: string;
  /** End of a range comparison. */
  toHash?: string;
  /**
   * Hard line cap to keep diffs inside the LLM context window.
   * @defaultValue 500
   */
  maxLines?: number;
}

/** Parameters for `run_security_audit`. */
export interface RunSecurityAuditParams {
  /**
   * Run `npm audit --json` when a `package.json` is present.
   * @defaultValue `true`
   */
  includeNpmAudit?: boolean;
}

/**
 * Parameters for `send_digest_email` — the structured report the LLM must produce.
 * All fields except `recipientOverride` are required; `cachedCommits` is injected
 * by the agent loop rather than the LLM.
 */
export interface SendDigestEmailParams {
  reportDate: string;
  timeWindow: string;
  totalCommits: number;
  totalFilesChanged: number;
  executiveSummary: string;
  securityVerdict: 'CLEAN' | 'WARNING' | 'VULNERABLE';
  securitySummary: string;
  categorizedChanges: {
    features: string[];
    fixes: string[];
    security: string[];
    refactoring: string[];
    other: string[];
  };
  vulnerabilities: Array<{
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
    title: string;
    file?: string;
    line?: number | string;
    commitHash?: string;
    description: string;
    recommendation: string;
  }>;
  authors: Array<{
    name: string;
    email: string;
    commitCount: number;
    additions: number;
    deletions: number;
    summary: string;
  }>;
  recipientOverride?: string;
}

// ── Gemini function declarations ───────────────────────────────────

/**
 * Gemini tool declaration for `get_recent_commits`.
 * Returns commit hashes, authors, timestamps, messages, and per-commit file lists.
 */
export const getRecentCommitsFunctionDeclaration: FunctionDeclaration = {
  name: 'get_recent_commits',
  description: 'Fetches recent git commits in the target repository workspace within a given timeframe (default: 24 hours). Returns commit hashes, authors, timestamps, commit messages, and list of changed files.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description: 'Timeframe filter for git log (e.g., "24 hours ago", "1 day ago", "7 days ago", "2026-09-01"). Defaults to "24 hours ago".',
      },
      maxCount: {
        type: 'integer',
        description: 'Maximum number of commits to retrieve. Defaults to 50.',
      },
      branch: {
        type: 'string',
        description: 'Branch name to query (defaults to configured target branch).',
      },
    },
  },
};

/**
 * Gemini tool declaration for `get_commit_diff`.
 * Essential for the security audit — returns unified diffs line-capped at `maxLines`.
 */
export const getCommitDiffFunctionDeclaration: FunctionDeclaration = {
  name: 'get_commit_diff',
  description: 'Retrieves the unified git diff of a specific commit or a range of commits. Essential for deep security and vulnerability inspection.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      commitHash: {
        type: 'string',
        description: 'Specific commit hash to inspect (e.g. "a1b2c3d").',
      },
      fromHash: {
        type: 'string',
        description: 'Starting commit hash for a range comparison.',
      },
      toHash: {
        type: 'string',
        description: 'Ending commit hash for a range comparison.',
      },
      maxLines: {
        type: 'integer',
        description: 'Maximum lines of diff to return to prevent prompt overflow. Defaults to 500.',
      },
    },
  },
};

/**
 * Gemini tool declaration for `run_security_audit`.
 * Runs regex secret scans on `HEAD~5..HEAD` added lines plus optional `npm audit`.
 */
export const runSecurityAuditFunctionDeclaration: FunctionDeclaration = {
  name: 'run_security_audit',
  description: 'Runs automated local security checks inside the workspace (e.g. npm audit for vulnerable dependencies, regex patterns for leaked secrets, tokens, or credentials).',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      includeNpmAudit: {
        type: 'boolean',
        description: 'Whether to run npm audit in the workspace if package.json is present. Defaults to true.',
      },
    },
  },
};

/** Gemini tool declaration for `send_digest_email` — final dispatch + local archive. */
export const sendDigestEmailFunctionDeclaration: FunctionDeclaration = {
  name: 'send_digest_email',
  description: 'Renders and sends the finalized daily commit digest and security vulnerability report to the user (divyanshukumar.dev@proton.me). Also saves a local archive.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      reportDate: {
        type: 'string',
        description: 'Human readable date in IST timezone (e.g., "September 1, 2026").',
      },
      timeWindow: {
        type: 'string',
        description: 'Time window covered (e.g. "Last 24 Hours").',
      },
      totalCommits: {
        type: 'integer',
        description: 'Total number of commits analyzed.',
      },
      totalFilesChanged: {
        type: 'integer',
        description: 'Total number of distinct files changed.',
      },
      executiveSummary: {
        type: 'string',
        description: 'Comprehensive high-level summary of all commits, major architectural modifications, features, and fixes.',
      },
      securityVerdict: {
        type: 'string',
        enum: ['CLEAN', 'WARNING', 'VULNERABLE'],
        description: 'Overall security verdict: CLEAN (no issues), WARNING (minor concerns), or VULNERABLE (critical issues/breaking regressions).',
      },
      securitySummary: {
        type: 'string',
        description: 'Summary of the security vulnerability analysis and breaking change audit.',
      },
      categorizedChanges: {
        type: 'object',
        properties: {
          features: { type: 'array', items: { type: 'string' } },
          fixes: { type: 'array', items: { type: 'string' } },
          security: { type: 'array', items: { type: 'string' } },
          refactoring: { type: 'array', items: { type: 'string' } },
          other: { type: 'array', items: { type: 'string' } },
        },
        required: ['features', 'fixes', 'security', 'refactoring', 'other'],
      },
      vulnerabilities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
            title: { type: 'string' },
            file: { type: 'string' },
            line: { type: 'string' },
            commitHash: { type: 'string' },
            description: { type: 'string' },
            recommendation: { type: 'string' },
          },
          required: ['severity', 'title', 'description', 'recommendation'],
        },
      },
      authors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
            commitCount: { type: 'integer' },
            additions: { type: 'integer' },
            deletions: { type: 'integer' },
            summary: { type: 'string' },
          },
          required: ['name', 'email', 'commitCount', 'summary'],
        },
      },
      recipientOverride: {
        type: 'string',
        description: 'Optional email address override. Defaults to divyanshukumar.dev@proton.me.',
      },
    },
    required: [
      'reportDate',
      'timeWindow',
      'totalCommits',
      'totalFilesChanged',
      'executiveSummary',
      'securityVerdict',
      'securitySummary',
      'categorizedChanges',
      'vulnerabilities',
      'authors',
    ],
  },
};

// ── Executors ──────────────────────────────────────────────────────

/**
 * Fetches commits in the workspace within `since`, enriches each with `git diff-tree --name-only`.
 *
 * @param workspaceRoot - Absolute workspace path.
 * @param params - Time window, count cap, branch.
 * @returns `{ commits, count, timeWindow, allFiles }`.
 *   - `allFiles` is the deduped union of every commit's file list.
 *   - `timeWindow` echoes `since` or, on empty-window fallback, `Latest N commits (…)`.
 * @throws If `git log` fails irrecoverably (bad branch name, corrupt repo).
 *
 * **Edge cases**
 * - Empty window → fallback to latest 10 (not 0) — see module gotchas.
 * - Each commit's file list is best-effort (`catch` → `[]` if `diff-tree` fails).
 * - Delimiter `||PRISM_COMMIT_SEP||` is assumed never to appear in commit messages.
 *
 * @example
 * ```ts
 * const { commits } = await executeGetRecentCommits(ws, { since: '24 hours ago' });
 * console.log(commits[0].hash, commits[0].filesChanged);
 * ```
 */
export async function executeGetRecentCommits(
  workspaceRoot: string,
  params: GetRecentCommitsParams
): Promise<{ commits: CommitSummaryItem[]; count: number; timeWindow: string; allFiles: string[] }> {
  const since = params.since || '24 hours ago';
  const maxCount = params.maxCount || 50;
  const branch = params.branch || config.targetBranch;

  // Format: HASH%x1fSHORTHASH%x1fAUTHOR%x1fEMAIL%x1fDATE%x1fSUBJECT%x1fBODY%x1e
  const delimiter = '||PRISM_COMMIT_SEP||';
  const fieldSep = '||FIELD_SEP||';
  const format = `${delimiter}%H${fieldSep}%h${fieldSep}%an${fieldSep}%ae${fieldSep}%ad${fieldSep}%s${fieldSep}%b`;

  try {
    // 1. Fetch commits
    let cmd = `git log --date=format:"%Y-%m-%d %H:%M:%S" --since="${since}" -n ${maxCount} --pretty=format:"${format}" ${branch}`;
    let { stdout } = await execAsync(cmd, { cwd: workspaceRoot });

    // If no commits in window, fallback to last 10 commits with a notice
    let isFallback = false;
    if (!stdout.trim()) {
      isFallback = true;
      const fallbackCmd = `git log --date=format:"%Y-%m-%d %H:%M:%S" -n 10 --pretty=format:"${format}" ${branch}`;
      const fallbackRes = await execAsync(fallbackCmd, { cwd: workspaceRoot });
      stdout = fallbackRes.stdout;
    }

    if (!stdout.trim()) {
      return {
        commits: [],
        count: 0,
        timeWindow: since,
        allFiles: [],
      };
    }

    const rawCommits = stdout.split(delimiter).filter((c) => c.trim().length > 0);
    const commits: CommitSummaryItem[] = [];
    const allFilesSet = new Set<string>();

    for (const raw of rawCommits) {
      const parts = raw.split(fieldSep);
      if (parts.length < 6) continue;

      const [hash, shortHash, author, email, date, subject, body] = parts.map((p) => p.trim());
      const fullMessage = body ? `${subject}\n\n${body}` : subject;

      // Get files changed for this commit
      let filesChanged: string[] = [];
      try {
        const fileListRes = await execAsync(`git diff-tree --no-commit-id --name-only -r ${hash}`, {
          cwd: workspaceRoot,
        });
        filesChanged = fileListRes.stdout
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean);
        for (const f of filesChanged) allFilesSet.add(f);
      } catch {
        // Ignore file listing errors on individual commit
      }

      commits.push({
        hash,
        shortHash,
        author,
        email,
        date,
        message: fullMessage,
        filesChanged,
      });
    }

    return {
      commits,
      count: commits.length,
      timeWindow: isFallback ? `Latest ${commits.length} commits (No commits in '${since}')` : since,
      allFiles: Array.from(allFilesSet),
    };
  } catch (err: any) {
    throw new Error(`Failed to get recent commits: ${err.message}`);
  }
}

/**
 * Retrieves a unified diff for a single commit, a range, or HEAD.
 *
 * @param workspaceRoot - Absolute workspace path.
 * @param params - Commit selector + line cap.
 * @returns `{ diff, truncated, lines }`. `truncated` is true when `lines > maxLines`.
 * @throws If the commit hash does not exist or `git show` fails.
 *
 * **Gotcha:** large diffs are **hard-truncated** at `maxLines` with a sentinel line
 * (`…[Diff truncated at N lines]`). Do not rely on a trailing context being present.
 *
 * @example
 * ```ts
 * const { diff } = await executeGetCommitDiff(ws, { commitHash: 'abc123', maxLines: 300 });
 * ```
 */
export async function executeGetCommitDiff(
  workspaceRoot: string,
  params: GetCommitDiffParams
): Promise<{ diff: string; truncated: boolean; lines: number }> {
  const maxLines = params.maxLines || 500;
  let cmd = '';

  if (params.fromHash && params.toHash) {
    cmd = `git diff ${params.fromHash}..${params.toHash}`;
  } else if (params.commitHash) {
    cmd = `git show ${params.commitHash}`;
  } else {
    cmd = `git show HEAD`;
  }

  try {
    const { stdout } = await execAsync(cmd, { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 });
    const lines = stdout.split('\n');
    const truncated = lines.length > maxLines;
    const cleanDiff = truncated ? lines.slice(0, maxLines).join('\n') + `\n\n... [Diff truncated at ${maxLines} lines for brevity]` : stdout;

    return {
      diff: cleanDiff,
      truncated,
      lines: lines.length,
    };
  } catch (err: any) {
    throw new Error(`Failed to retrieve commit diff: ${err.message}`);
  }
}

/**
 * Scans `HEAD~5..HEAD` added lines for leaked secrets and optionally runs `npm audit`.
 *
 * **Secret patterns checked** (added `+` lines only, `+++` excluded):
 * - `-----BEGIN … PRIVATE KEY-----`
 * - `AKIA…` (AWS Access Key)
 * - `ghp_…` / `github_pat_…` (GitHub PAT)
 * - `api_key|apikey|secret_key|… = "…"` (generic secrets)
 * - `postgres://user:pass@…` (DB URL with credentials)
 *
 * @param workspaceRoot - Absolute workspace path.
 * @param params - `includeNpmAudit` toggle.
 * @returns `{ npmAudit?, secretScanResults, status }`.
 *   `status` is `"SECRETS_FOUND"` or `"CLEAN"`. `npmAudit` is `null` when `package.json` is absent.
 *   Never throws for scan errors — falls back to `CLEAN`.
 *
 * **Gotchas**
 * - Only the diff of the last **5 commits** is scanned. Older leaks in the 24 h window but beyond 5 commits are invisible here;
 *   the agent's `get_commit_diff` loop is expected to catch them visually.
 * - Snippets are truncated at 100 chars (no secret material logged fully).
 *
 * @example
 * ```ts
 * const r = await executeRunSecurityAudit(ws, {});
 * if (r.status === 'SECRETS_FOUND') console.warn(r.secretScanResults);
 * ```
 */
export async function executeRunSecurityAudit(
  workspaceRoot: string,
  params: RunSecurityAuditParams
): Promise<{
  npmAudit?: any;
  secretScanResults: Array<{ file: string; matchType: string; snippet: string }>;
  status: string;
}> {
  const secretScanResults: Array<{ file: string; matchType: string; snippet: string }> = [];

  // 1. Scan for leaked secrets, tokens, and private keys in recently modified files
  const secretPatterns = [
    { type: 'Private Key', regex: /-----BEGIN (RSA|EC|PGP|OPENSSH|DSA)? ?PRIVATE KEY-----/i },
    { type: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
    { type: 'GitHub Personal Access Token', regex: /ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82}/ },
    { type: 'Generic API Key / Secret String', regex: /(?:api_key|apikey|secret_key|api_secret|access_token|bearer)\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i },
    { type: 'Database Connection String with Credentials', regex: /postgres(?:ql)?:\/\/[a-zA-Z0-9_-]+:[^@]+@/i },
  ];

  try {
    const gitDiffRes = await execAsync('git diff HEAD~5 HEAD', { cwd: workspaceRoot }).catch(() => ({ stdout: '' }));
    if (gitDiffRes.stdout) {
      const lines = gitDiffRes.stdout.split('\n');
      let currentFile = 'unknown';
      for (const line of lines) {
        if (line.startsWith('+++ b/')) {
          currentFile = line.replace('+++ b/', '').trim();
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
          for (const p of secretPatterns) {
            if (p.regex.test(line)) {
              secretScanResults.push({
                file: currentFile,
                matchType: p.type,
                snippet: line.trim().slice(0, 100),
              });
            }
          }
        }
      }
    }
  } catch {
    // Diff scan error tolerated
  }

  // 2. Run npm audit if package.json exists
  let npmAudit: any = null;
  const packageJsonPath = path.join(workspaceRoot, 'package.json');
  if (params.includeNpmAudit !== false && fs.existsSync(packageJsonPath)) {
    try {
      const { stdout } = await execAsync('npm audit --json', { cwd: workspaceRoot }).catch((err) => ({
        stdout: err.stdout || '',
      }));
      if (stdout) {
        const parsed = JSON.parse(stdout);
        npmAudit = {
          vulnerabilitiesCount: parsed.metadata?.vulnerabilities || {},
          totalDependencies: parsed.metadata?.dependencies?.total || 0,
        };
      }
    } catch {
      npmAudit = { note: 'npm audit completed without parsable JSON.' };
    }
  }

  return {
    npmAudit,
    secretScanResults,
    status: secretScanResults.length > 0 ? 'SECRETS_FOUND' : 'CLEAN',
  };
}

/**
 * Builds the final report from the LLM's structured data + the cached commit list,
 * then delegates to {@link MailerService#sendDigestEmail} (archive + Resend/SMTP/Ethereal).
 *
 * @param workspaceRoot - Unused for FS directly but keeps tool signature uniform.
 * @param params - Structured report fields produced by the LLM.
 * @param cachedCommits - Full commit list captured from the earlier `get_recent_commits` call.
 * @returns `{ success, message, previewUrl?, savedHtml? }`.
 *
 * **Gotcha:** `cachedCommits` is **not** validated against `totalCommits` — a mismatch
 * is tolerated (the LLM counts vs git history may differ by a commit or two).
 *
 * @example See module header example.
 */
export async function executeSendDigestEmail(
  workspaceRoot: string,
  params: SendDigestEmailParams,
  cachedCommits: CommitSummaryItem[] = []
): Promise<{ success: boolean; message: string; previewUrl?: string; savedHtml?: string }> {
  const mailer = new MailerService();

  const reportData: DigestReportData = {
    reportDate: params.reportDate,
    targetRepoUrl: config.targetRepoUrl,
    targetBranch: config.targetBranch,
    timeWindow: params.timeWindow,
    totalCommits: params.totalCommits,
    totalFilesChanged: params.totalFilesChanged,
    executiveSummary: params.executiveSummary,
    securityVerdict: params.securityVerdict,
    securitySummary: params.securitySummary,
    categorizedChanges: params.categorizedChanges,
    vulnerabilities: params.vulnerabilities,
    authors: params.authors,
    commits: cachedCommits,
  };

  const sendResult = await mailer.sendDigestEmail(reportData, params.recipientOverride);

  return {
    success: sendResult.success,
    message: sendResult.message,
    previewUrl: sendResult.previewUrl,
    savedHtml: sendResult.savedFiles?.htmlPath,
  };
}
