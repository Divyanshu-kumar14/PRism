/**
 * @fileoverview Sandboxed shell execution tool for LLM agents.
 *
 * **What this module does**
 * - Exposes `run_command` as a Gemini `FunctionDeclaration` so agents can run
 *   `npm test`, `npx vitest run`, `git status`, `npx tsc --noEmit`, etc.
 * - Executes every command **inside** `workspaceRoot` (`cwd`), with a shared
 *   `CI=true` env, 60 s default timeout, and 10 MB stdout/stderr buffers.
 * - Implements LRU cache for idempotent read-only git commands (O(1) lookup).
 * - Provides structured logging for observability and debugging.
 *
 * **Performance Optimizations:**
 * - **O(1) cache for read-only git commands**: Avoids spawning child_process for
 *   repeated `git status`, `git diff`, `git log` queries within same agent turn.
 *   TTL 3s — ensures freshness after write_file but captures duplicates like
 *   `git status` twice in 1s. Only caches safe read-only prefixes.
 * - **Bounded output truncation**: 8000 chars per stream keeps LLM context small
 *   while preserving error context. `maxBuffer: 10MB` prevents OOM from runaway commands.
 * - **Sanitized environment**: Host secrets (PAT, API keys) stripped before execution —
 *   prevents credential leakage to workspace child processes.
 *
 * **Key configurations / parameters**
 * | Param       | Type     | Default | Notes |
 * |-------------|----------|---------|-------|
 * | `command`   | `string` | —       | Full shell line, e.g. `npm test` or `npx vitest run --coverage` |
 * | `timeoutMs` | `number` | `60000` | Kill after this many ms; `error.code` becomes `null` → reported as `1` |
 *
 * **Usage examples**
 * ```ts
 * // Run tests and check exit code
 * const r = await executeRunCommand(ws, { command: 'npx vitest run' });
 * if (!r.success) console.error(r.stderr);
 *
 * // Type-check with a longer timeout
 * await executeRunCommand(ws, { command: 'npx tsc --noEmit', timeoutMs: 120_000 });
 * ```
 *
 * **Edge cases / gotchas**
 * - Output is **truncated to 8 000 chars** per stream to keep the LLM context small
 *   (suffix `…[Output truncated]`). The promise still resolves.
 * - `maxBuffer` is 10 MB — extremely verbose commands (coverage reports) will error
 *   before truncation; split them or redirect to a file.
 * - Commands are run via `child_process.exec` → full shell interpolation applies.
 *   Avoid unsanitized user input; the tool is intentionally **not** `execFile`.
 * - `CI=true` is injected to silence interactive prompts (e.g. vitest watch mode).
 *
 * @see {@link executeRunCommand}
 */

import { exec } from 'child_process';
import type { FunctionDeclaration } from '@google/genai';

// ── Types for structured logging ──────────────────────────────────────────

/** Command categorization for structured logging and metrics. */
export type CommandCategory =
  | 'git-read'        // git status, diff, log, show (cached)
  | 'git-write'       // git add, commit, push (never cached)
  | 'test'            // npm test, npx vitest, npx jest
  | 'build'           // npm run build, npx tsc
  | 'install'         // npm install, npm ci
  | 'lint'            // npx eslint, npx prettier
  | 'other';          // uncategorized

/** Categorizes a command for logging/metrics. O(1) string prefix checks. */
function categorizeCommand(cmd: string): CommandCategory {
  const trimmed = cmd.trim();
  if (trimmed.startsWith('git status') || trimmed.startsWith('git diff') ||
      trimmed.startsWith('git log') || trimmed.startsWith('git diff-tree') ||
      trimmed.startsWith('git show')) return 'git-read';
  if (trimmed.startsWith('git add') || trimmed.startsWith('git commit') ||
      trimmed.startsWith('git push') || trimmed.startsWith('git checkout') ||
      trimmed.startsWith('git branch')) return 'git-write';
  if (trimmed.includes('test') || trimmed.includes('vitest') || trimmed.includes('jest')) return 'test';
  if (trimmed.includes('build') || trimmed.includes('tsc') || trimmed.includes('compile')) return 'build';
  if (trimmed.startsWith('npm install') || trimmed.startsWith('npm ci') || trimmed.startsWith('yarn install') || trimmed.startsWith('pnpm install')) return 'install';
  if (trimmed.includes('eslint') || trimmed.includes('prettier') || trimmed.includes('lint')) return 'lint';
  return 'other';
}

/** Sanitizes command for logging (removes potential secrets in args). */
function sanitizeForLogging(cmd: string): string {
  // Mask common secret patterns in command args
  return cmd
    .replace(/--token[=\s]+[^\s]+/gi, '--token=***')
    .replace(/--password[=\s]+[^\s]+/gi, '--password=***')
    .replace(/--api-key[=\s]+[^\s]+/gi, '--api-key=***')
    .replace(/Authorization:\s*[^\s]+/gi, 'Authorization: ***')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer ***');
}

// ── Performance: LRU cache for idempotent read-only git commands ──────────
// O(1) Map lookup avoids spawning child_process for repeated queries within same agent turn
// TTL 3s — ensures freshness after write_file but captures duplicates like `git status` twice in 1s
// Only caches safe read-only prefixes: 'git status', 'git diff', 'git log', 'git diff-tree'
// Write/mutate commands (npm test, npx vitest, git add/commit/push) are never cached — would violate Do No Harm
const CMD_CACHE_TTL_MS = 3000;
const CMD_CACHE_MAX = 30;
const commandCache = new Map<string, { ts: number; result: { stdout: string; stderr: string; exitCode: number; success: boolean; durationMs: number } }>();

function isCacheableCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  return (
    trimmed.startsWith('git status') ||
    trimmed.startsWith('git diff') ||
    trimmed.startsWith('git log') ||
    trimmed.startsWith('git diff-tree') ||
    trimmed.startsWith('git show')
  );
}

function buildCacheKey(workspaceRoot: string, command: string): string {
  return `${workspaceRoot}::${command}`;
}

// ── Param interfaces ──────────────────────────────────────────────────────

/**
 * Parameters for `run_command`.
 * The command string is executed with `exec` inside `workspaceRoot`.
 */
export interface RunCommandParams {
  /** Exact shell command line to run inside the workspace (e.g. `"npm test"`). */
  command: string;
  /**
   * Hard timeout in ms. After this, `exec` kills the child and the error callback fires.
   * @defaultValue 60000 (1 minute)
   */
  timeoutMs?: number;
}

/**
 * Gemini declaration for `run_command`.
 * Lets agents verify test suites, type-check, list git status, install deps, etc.
 */
export const runCommandFunctionDeclaration: FunctionDeclaration = {
  name: 'run_command',
  description: 'Executes a shell command inside the target repository workspace (e.g. "npm test", "npx vitest run", "npm run build", "git status", "git diff"). Use this to run tests, check coverage, and verify syntax.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact shell command line string to execute inside the repository workspace.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Maximum execution timeout in milliseconds. Defaults to 60000ms (1 minute).',
      },
    },
    required: ['command'],
  },
};

// ── Security Guardrails & Sanitization ───────────────────────────────────

// Host credential keys that must NEVER be leaked to workspace child processes
// WHY: Child processes inherit parent env; if we don't strip these, agents could
// accidentally leak credentials via `env` command or subprocess logging.
const SENSITIVE_ENV_KEYS = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'SMTP_PASS',
  'SMTP_USER',
  'SMTP_HOST',
  'RESEND_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'DATABASE_URL',
]);

/**
 * Returns a sanitized copy of process.env stripped of PRism host credentials.
 * Also injects `CI=true` to disable interactive prompts in test runners.
 */
export function getSanitizedEnv(): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...process.env, CI: 'true' };
  for (const key of SENSITIVE_ENV_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

/**
 * Detects destructive system operations or attempts to leak host environment secrets.
 * Uses regex patterns for O(1) detection — no AST parsing needed.
 */
export function isDangerousCommand(command: string): { blocked: boolean; reason?: string } {
  const trimmed = command.trim();

  // 1. Destructive system operations (privilege escalation, disk formatting, fork bombs)
  if (
    /(^|\s)(sudo|su\s|mkfs[a-z0-9.]*|fdisk|dd\s+if=|shutdown|reboot|poweroff)(\s|$)/i.test(trimmed) ||
    /:\(\)\s*\{\s*:\|:&\s*\};\s*:/i.test(trimmed) || // Fork bomb :(){ :|:& };:
    /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~|\/\*)/i.test(trimmed) // rm -rf / or ~
  ) {
    return {
      blocked: true,
      reason: 'Blocked dangerous system command or privilege escalation.',
    };
  }

  // 2. Direct attempts to read host .env files (path traversal to parent)
  if (/(?:cat|grep|head|tail|less|more|nano|vim|vi|source|\.)\s+.*(?:\.\.\/.*\.env|\.env\.local)/i.test(trimmed)) {
    return {
      blocked: true,
      reason: 'Blocked attempt to read parent or host environment files.',
    };
  }

  return { blocked: false };
}

// ── Main Executor ─────────────────────────────────────────────────────────

/**
 * Executes a shell command inside `workspaceRoot` and captures the result.
 *
 * @param workspaceRoot - Absolute path from {@link GitRepoManager#getWorkspacePath}.
 * @param params - Command + optional timeout.
 * @returns Promise resolving to `{ stdout, stderr, exitCode, success, durationMs }`.
 *   Never throws — even on command failure; check `success` / `exitCode` instead.
 *
 * **Implementation notes**
 * - `maxBuffer: 10 MiB` — if exceeded, Node kills the child and `stderr` may be empty.
 * - `CI=true` is merged into `process.env` for the child to disable interactive modes.
 * - Host secret environment variables (PAT, API keys) are stripped before execution.
 * - Both streams are truncated independently at 8000 chars before resolving.
 * - Structured logging emitted for observability (category, duration, exit code).
 *
 * @example
 * ```ts
 * const { success, stdout, exitCode, durationMs } =
 *   await executeRunCommand(ws, { command: 'npm test' });
 * console.log(`Finished in ${durationMs}ms, exit ${exitCode}: ${stdout.slice(0,120)}`);
 * ```
 */
export async function executeRunCommand(
  workspaceRoot: string,
  params: RunCommandParams
): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean; durationMs: number }> {
  // Security guardrail check — O(1) regex checks
  const safetyCheck = isDangerousCommand(params.command);
  if (safetyCheck.blocked) {
    // Log security violation for audit trail
    console.warn(`\x1b[31m[SECURITY]\x1b[0m Blocked command: ${sanitizeForLogging(params.command)} — ${safetyCheck.reason}`);
    return {
      stdout: '',
      stderr: `[Security Violation] Command blocked by PRism security policy: ${safetyCheck.reason}`,
      exitCode: 1,
      success: false,
      durationMs: 0,
    };
  }

  // Structured log: command start
  const category = categorizeCommand(params.command);
  const sanitizedCmd = sanitizeForLogging(params.command);
  console.log(`\x1b[36m[CMD:${category}]\x1b[0m ${sanitizedCmd}`);

  // Perf: O(1) cache check for idempotent git reads — avoids process spawn (20-40ms saved per hit)
  // Only read-only git commands are cached; every other command bypasses cache to preserve correctness
  if (isCacheableCommand(params.command)) {
    const key = buildCacheKey(workspaceRoot, params.command);
    const cached = commandCache.get(key);
    if (cached && Date.now() - cached.ts < CMD_CACHE_TTL_MS) {
      // Cache hit — return cloned result with 0 durationMs overhead
      console.log(`\x1b[90m[CACHE HIT]\x1b[0m ${sanitizedCmd} (cached)`);
      return { ...cached.result, durationMs: 0 };
    }
  }

  const startTime = Date.now();
  const timeout = params.timeoutMs || 60000;
  const childEnv = getSanitizedEnv();

  return new Promise((resolve) => {
    exec(
      params.command,
      {
        cwd: workspaceRoot,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB — prevents OOM from runaway `npm audit` / `git log`
        env: childEnv,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;

        // Truncate output if excessively long to keep prompt context clean
        // Perf: independent truncation per stream — O(1) slice operations
        const maxLen = 8000;
        const cleanStdout = stdout && stdout.length > maxLen ? stdout.slice(0, maxLen) + '\n...[Output truncated]' : stdout || '';
        const cleanStderr = stderr && stderr.length > maxLen ? stderr.slice(0, maxLen) + '\n...[Error truncated]' : stderr || '';

        const result = {
          stdout: cleanStdout,
          stderr: cleanStderr,
          exitCode,
          success: exitCode === 0,
          durationMs,
        };

        // Structured log: command completion
        const statusIcon = result.success ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m';
        const timeoutFlag = error && error.killed ? ' \x1b[33m(TIMEOUT)\x1b[0m' : '';
        console.log(`\x1b[36m[CMD:${category}]\x1b[0m ${statusIcon} exit=${exitCode} duration=${durationMs}ms${timeoutFlag}`);

        // Store in LRU cache if cacheable — O(1) Map set
        if (isCacheableCommand(params.command)) {
          const key = buildCacheKey(workspaceRoot, params.command);
          commandCache.set(key, { ts: Date.now(), result });
          if (commandCache.size > CMD_CACHE_MAX) {
            const first = commandCache.keys().next().value as string;
            commandCache.delete(first);
          }
        }

        resolve(result);
      }
    );
  });
}

// Export for testing / manual invalidation after write_file (Do No Harm: ensure stale reads don't persist)
export function clearCommandCache(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    commandCache.clear();
  } else {
    for (const key of commandCache.keys()) {
      if (key.startsWith(`${workspaceRoot}::`)) commandCache.delete(key);
    }
  }
}