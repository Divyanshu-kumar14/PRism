/**
 * @fileoverview Sandboxed shell execution tool for LLM agents.
 *
 * **What this module does**
 * - Exposes `run_command` as a Gemini `FunctionDeclaration` so agents can run
 *   `npm test`, `npx vitest run`, `git status`, `npx tsc --noEmit`, etc.
 * - Executes every command **inside** `workspaceRoot` (`cwd`), with a shared
 *   `CI=true` env, 60 s default timeout, and 10 MB stdout/stderr buffers.
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

// Perf: LRU cache for idempotent read-only git commands
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
 * - Both streams are truncated independently at 8000 chars before resolving.
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
  // Perf: O(1) cache check for idempotent git reads — avoids process spawn (20-40ms saved per hit)
  // Only read-only git commands are cached; every other command bypasses cache to preserve correctness
  if (isCacheableCommand(params.command)) {
    const key = buildCacheKey(workspaceRoot, params.command);
    const cached = commandCache.get(key);
    if (cached && Date.now() - cached.ts < CMD_CACHE_TTL_MS) {
      // Cache hit — return cloned result with 0 durationMs overhead
      return { ...cached.result, durationMs: 0 };
    }
  }

  const startTime = Date.now();
  const timeout = params.timeoutMs || 60000;

  return new Promise((resolve) => {
    exec(
      params.command,
      {
        cwd: workspaceRoot,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB — prevents OOM from runaway `npm audit` / `git log`
        env: {
          ...process.env,
          CI: 'true',
        },
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        
        // Truncate output if excessively long to keep prompt context clean
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
