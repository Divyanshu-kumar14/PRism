/**
 * @fileoverview Unified tool registry and dispatchers — the single import surface for all agents.
 *
 * **What this module does**
 * - Re-exports every tool declaration + executor so `src/agent.ts` and
 *   `src/digest_agent.ts` can stay agnostic of the underlying tool files.
 * - Declares two Gemini toolsets:
 *   - `agentToolDeclarations` → used by {@link CoverageAgent} (coverage + PR workflow)
 *   - `digestToolDeclarations` → used by {@link DailyCommitDigestAgent} (digest + security)
 * - Provides two dispatchers (`executeAgentTool` / `executeDigestTool`) that
 *   route a `functionCall.name` from the LLM to the concrete executor.
 *
 * **Tool matrix**
 *
 * | Declaration set | Tool | Executor | Source |
 * |-----------------|------|----------|--------|
 * | `agentToolDeclarations` | `list_dir` | `executeListDir` | `file_ops.ts` |
 * | | `read_file` | `executeReadFile` | `file_ops.ts` |
 * | | `write_file` | `executeWriteFile` | `file_ops.ts` |
 * | | `run_command` | `executeRunCommand` | `command_runner.ts` |
 * | | `create_pr` | `executeCreatePr` | `github_pr.ts` |
 * | `digestToolDeclarations` | `get_recent_commits` | `executeGetRecentCommits` | `git_digest.ts` |
 * | | `get_commit_diff` | `executeGetCommitDiff` | `git_digest.ts` |
 * | | `run_security_audit` | `executeRunSecurityAudit` | `git_digest.ts` |
 * | | `send_digest_email` | `executeSendDigestEmail` | `git_digest.ts` |
 * | | `read_file` | `executeReadFile` | `file_ops.ts` |
 * | | `list_dir` | `executeListDir` | `file_ops.ts` |
 *
 * **Usage examples**
 * ```ts
 * import { agentToolDeclarations, executeAgentTool } from './tools/index.js';
 * // Pass to Gemini:
 * const tools = [{ functionDeclarations: agentToolDeclarations }];
 *
 * // Dispatch a tool call returned by the model:
 * const result = await executeAgentTool('read_file', { filePath: 'package.json' }, ws, mgr);
 * ```
 *
 * **Gotchas**
 * - Dispatchers are **case-sensitive** — an LLM typo like `Read_File` returns `{ error: "Unrecognized tool…" }`
 *   rather than throwing, so the agent can self-correct on the next turn.
 * - `executeDigestTool` alone threads `cachedCommits` through — `executeAgentTool` does not.
 * - `export *` at the bottom is intentional — callers that already import from `./tools/index.js`
 *   get all param interfaces (`ReadFileParams`, etc.) without extra paths.
 */

import {
  readFileFunctionDeclaration,
  writeFileFunctionDeclaration,
  listDirFunctionDeclaration,
  executeReadFile,
  executeWriteFile,
  executeListDir,
  ReadFileParams,
  WriteFileParams,
  ListDirParams,
} from './file_ops.js';
import {
  runCommandFunctionDeclaration,
  executeRunCommand,
  RunCommandParams,
} from './command_runner.js';
import {
  createPrFunctionDeclaration,
  executeCreatePr,
  CreatePrParams,
} from './github_pr.js';
import {
  getRecentCommitsFunctionDeclaration,
  getCommitDiffFunctionDeclaration,
  runSecurityAuditFunctionDeclaration,
  sendDigestEmailFunctionDeclaration,
  executeGetRecentCommits,
  executeGetCommitDiff,
  executeRunSecurityAudit,
  executeSendDigestEmail,
  GetRecentCommitsParams,
  GetCommitDiffParams,
  RunSecurityAuditParams,
  SendDigestEmailParams,
} from './git_digest.js';
import { GitRepoManager } from './repo.js';

/**
 * Tool declarations available to {@link CoverageAgent}.
 * Passed verbatim as `tools: [{ functionDeclarations: agentToolDeclarations }]` to `generateContent`.
 */
export const agentToolDeclarations = [
  listDirFunctionDeclaration,
  readFileFunctionDeclaration,
  writeFileFunctionDeclaration,
  runCommandFunctionDeclaration,
  createPrFunctionDeclaration,
];

/**
 * Tool declarations available to {@link DailyCommitDigestAgent}.
 * Shares `read_file` / `list_dir` for repo exploration but swaps code‑generation
 * tools for the four git‑digest tools.
 */
export const digestToolDeclarations = [
  getRecentCommitsFunctionDeclaration,
  getCommitDiffFunctionDeclaration,
  runSecurityAuditFunctionDeclaration,
  sendDigestEmailFunctionDeclaration,
  readFileFunctionDeclaration,
  listDirFunctionDeclaration,
];

/**
 * Dispatches a single {@link CoverageAgent} tool call from the LLM.
 *
 * @param toolName - Function name as returned by Gemini (e.g. `"read_file"`).
 * @param args - Validated args matching the declaration's `parametersJsonSchema`.
 * @param workspaceRoot - Absolute workspace path (all file/commands are sandboxed here).
 * @param repoManager - Needed only by `create_pr` (holds auth + branch logic).
 * @returns Executor return value, or `{ error: "Unrecognized tool: …" }` for typos.
 *
 * **Note:** not responsible for validating `toolName` against `agentToolDeclarations` —
 * mismatch surfaces as an `error` payload so the LLM can recover on the next turn.
 */
export async function executeAgentTool(
  toolName: string,
  args: any,
  workspaceRoot: string,
  repoManager: GitRepoManager
): Promise<any> {
  switch (toolName) {
    case 'list_dir':
      return executeListDir(workspaceRoot, args as ListDirParams);

    case 'read_file':
      return executeReadFile(workspaceRoot, args as ReadFileParams);

    case 'write_file':
      return executeWriteFile(workspaceRoot, args as WriteFileParams);

    case 'run_command':
      return await executeRunCommand(workspaceRoot, args as RunCommandParams);

    case 'create_pr':
      return await executeCreatePr(repoManager, args as CreatePrParams);

    default:
      return { error: `Unrecognized tool: ${toolName}` };
  }
}

/**
 * Dispatches a single {@link DailyCommitDigestAgent} tool call.
 *
 * @param toolName - Function name from the LLM (e.g. `"get_recent_commits"`).
 * @param args - Args matching the declaration schema.
 * @param workspaceRoot - Absolute workspace path.
 * @param cachedCommits - Commit list captured from a prior `get_recent_commits` call —
 *   threaded into `send_digest_email` so the HTML renderer can list every commit.
 * @returns Executor result or `{ error: "Unrecognized digest tool: …" }`.
 *
 * @example
 * ```ts
 * const commits = await executeDigestTool('get_recent_commits', { since: '24 hours ago' }, ws);
 * await executeDigestTool('send_digest_email', { reportDate: '…', … }, ws, commits.commits);
 * ```
 */
export async function executeDigestTool(
  toolName: string,
  args: any,
  workspaceRoot: string,
  cachedCommits: any[] = []
): Promise<any> {
  switch (toolName) {
    case 'get_recent_commits':
      return await executeGetRecentCommits(workspaceRoot, args as GetRecentCommitsParams);

    case 'get_commit_diff':
      return await executeGetCommitDiff(workspaceRoot, args as GetCommitDiffParams);

    case 'run_security_audit':
      return await executeRunSecurityAudit(workspaceRoot, args as RunSecurityAuditParams);

    case 'send_digest_email':
      return await executeSendDigestEmail(workspaceRoot, args as SendDigestEmailParams, cachedCommits);

    case 'read_file':
      return executeReadFile(workspaceRoot, args as ReadFileParams);

    case 'list_dir':
      return executeListDir(workspaceRoot, args as ListDirParams);

    default:
      return { error: `Unrecognized digest tool: ${toolName}` };
  }
}

export * from './file_ops.js';
export * from './command_runner.js';
export * from './github_pr.js';
export * from './git_digest.js';
export * from './repo.js';
