/**
 * @fileoverview Git workspace management — clone, sync, branch, commit & push.
 *
 * **What this module does**
 * - Encapsulates all `git` CLI interactions behind {@link GitRepoManager}.
 * - Guarantees the local `./workspace/<repo>` mirror is always on the configured
 *   `targetBranch` and up-to-date before any agent turn runs.
 * - Handles PAT-injected auth URLs without ever logging the token.
 *
 * **When is it used?**
 * - `CoverageAgent.initWorkspace()` / `DailyCommitDigestAgent.initWorkspace()` → `setupWorkspace()`
 * - `create_pr` tool → `commitAndPush()` → GitHub REST PR creation
 *
 * @example
 * ```ts
 * import { GitRepoManager } from './tools/repo.js';
 * const mgr = new GitRepoManager();
 * await mgr.setupWorkspace();                 // clone or hard-reset to origin/main
 * console.log(mgr.getWorkspacePath());        // /home/user/PRism/workspace/fluent
 * await mgr.commitAndPush('prism/test-123', 'test: add coverage for utils');
 * ```
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const execAsync = promisify(exec);

// Perf: memoize authenticated URLs — O(1) Map lookup vs O(n) string replace per call
// GitRepoManager is instantiated per agent (2-3 times per mission) and getAuthenticatedUrl is called
// in setupWorkspace + commitAndPush (2-3 times). Cache avoids recomputing same token injection.
const authUrlMemo = new Map<string, string>();

/**
 * Optional overrides for {@link GitRepoManager}.
 * All fields fall back to global {@link config} when omitted — useful for tests
 * that need an isolated temp workspace.
 */
export interface GitRepoManagerOptions {
  /** Override clone URL (default: `config.targetRepoUrl`). */
  repoUrl?: string;
  /** Override PAT (default: `config.githubToken`). */
  githubToken?: string;
  /** Override base branch (default: `config.targetBranch`). */
  targetBranch?: string;
  /** Override local directory (default: `config.workspaceDir`). */
  workspaceDir?: string;
}

/**
 * Manages the local git working copy that all agents operate on.
 *
 * - One instance per agent; inexpensive to construct.
 * - `workspacePath` is always absolute (via `path.resolve`).
 * - All git commands run **inside** `workspacePath` (`cwd` option).
 *
 * **Lifecycle**
 * ```
 * new GitRepoManager() → setupWorkspace() → [agent tools] → commitAndPush()
 * ```
 *
 * @category Tools / Git Infrastructure
 */
export class GitRepoManager {
  private repoUrl: string;
  private token: string;
  private baseBranch: string;
  private workspacePath: string;

  /**
   * @param options - Partial overrides; any field left `undefined` reads from global {@link config}.
   *
   * @example Isolated test workspace
   * ```ts
   * const mgr = new GitRepoManager({ workspaceDir: '/tmp/prism-test-workspace' });
   * ```
   */
  constructor(options: GitRepoManagerOptions = {}) {
    this.repoUrl = options.repoUrl || config.targetRepoUrl;
    this.token = options.githubToken || config.githubToken;
    this.baseBranch = options.targetBranch || config.targetBranch;
    this.workspacePath = path.resolve(options.workspaceDir || config.workspaceDir);
  }

  /**
   * Returns the absolute path of the local clone.
   * All other tools (`read_file`, `run_command`, …) are scoped to this directory.
   */
  public getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Builds a PAT-authenticated clone/push URL.
   *
   * - When no token is set, returns the raw `repoUrl` (public clone).
   * - Otherwise injects `x-access-token:<PAT>` as the userinfo.
   * - Never log the returned value — it contains the secret!
   *
   * @returns `https://x-access-token:<token>@github.com/owner/repo.git` or the plain URL.
   * @private
   *
   * **Gotcha:** Only `https://` URLs are supported. SSH remotes (`git@…`) are
   * not converted and will be returned verbatim (clone will then fail if auth is needed).
   */
  private getAuthenticatedUrl(): string {
    // O(1) memo lookup — key is token::url, avoids repeated regex replace
    const memoKey = `${this.token}::${this.repoUrl}`;
    const cached = authUrlMemo.get(memoKey);
    if (cached !== undefined) return cached;

    let result: string;
    if (!this.token) {
      result = this.repoUrl;
    } else {
      // Convert https://github.com/owner/repo.git to https://x-access-token:TOKEN@github.com/owner/repo.git
      const cleanUrl = this.repoUrl.replace(/^https?:\/\//, '');
      result = `https://x-access-token:${this.token}@${cleanUrl}`;
    }
    // Bounded memo — keep last 20 auth URLs (agent + test workspaces)
    authUrlMemo.set(memoKey, result);
    if (authUrlMemo.size > 20) {
      const first = authUrlMemo.keys().next().value as string;
      authUrlMemo.delete(first);
    }
    return result;
  }

  /**
   * Ensures the local workspace exists and is on the latest `origin/<baseBranch>`.
   *
   * **Strategy**
   * 1. `mkdir -p <parent>` if needed.
   * 2. If `<workspace>/.git` exists → `checkout <branch>` → `fetch` → `reset --hard origin/<branch>`.
   * 3. On failure (corrupt repo, branch missing) → `rm -rf <workspace>` and fall through.
   * 4. Fresh `git clone --branch <branch> --depth 50 <authUrl> <workspace>` + set `user.name`/`user.email`.
   *
   * @returns `{ success, message }` — always `success: true` on completion, throws on clone failure.
   * @throws If `git clone` or `git fetch` fails for an irrecoverable reason.
   *
   * **Edge cases / gotchas**
   * - Shallow clone (`--depth 50`) keeps history small but `get_recent_commits` may not see commits beyond 50 deep.
   *   Agents requesting `since=30d` on a high-velocity repo may silently fallback to last 10.
   * - `reset --hard` discards **all** local changes in the workspace — by design; the workspace is ephemeral.
   * - Token is **never** printed; logs show only the plain `repoUrl`.
   *
   * @example
   * ```ts
   * const mgr = new GitRepoManager();
   * const { message } = await mgr.setupWorkspace();
   * console.log(message); // "Repository cloned into ... successfully."
   * ```
   */
  public async setupWorkspace(): Promise<{ success: boolean; message: string }> {
    const authUrl = this.getAuthenticatedUrl();
    const parentDir = path.dirname(this.workspacePath);

    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const gitDir = path.join(this.workspacePath, '.git');

    if (fs.existsSync(gitDir)) {
      console.log(`\x1b[34m[Git]\x1b[0m Workspace already exists at ${this.workspacePath}. Resetting and pulling latest ${this.baseBranch}...`);
      try {
        await execAsync(`git checkout ${this.baseBranch}`, { cwd: this.workspacePath });
        await execAsync(`git fetch origin ${this.baseBranch}`, { cwd: this.workspacePath });
        await execAsync(`git reset --hard origin/${this.baseBranch}`, { cwd: this.workspacePath });
        return {
          success: true,
          message: `Workspace updated successfully to latest origin/${this.baseBranch}`,
        };
      } catch (err: unknown) {
        console.warn(`\x1b[33m[Git Warning]\x1b[0m Failed to update existing repo (${err instanceof Error ? err.message : String(err)}). Re-cloning fresh workspace...`);
        fs.rmSync(this.workspacePath, { recursive: true, force: true });
      }
    }

    console.log(`\x1b[34m[Git]\x1b[0m Cloning repository into ${this.workspacePath}...`);
    // Mask token from log
    const maskedUrl = this.repoUrl;
    console.log(`\x1b[34m[Git]\x1b[0m Target: ${maskedUrl} (branch: ${this.baseBranch})`);

    const cloneCmd = `git clone --branch ${this.baseBranch} --depth 50 ${authUrl} "${this.workspacePath}"`;
    await execAsync(cloneCmd);

    // Configure local git committer info
    await execAsync('git config user.name "PRism Agent"', { cwd: this.workspacePath });
    await execAsync('git config user.email "prism-agent@users.noreply.github.com"', { cwd: this.workspacePath });

    return {
      success: true,
      message: `Repository cloned into ${this.workspacePath} successfully.`,
    };
  }

  /**
   * Commits **all** workspace changes ( `git add -A` ) to a new branch and pushes it.
   *
   * Steps: `checkout -B <branch>` → `add -A` → `commit -m "<msg>"` → `push --force -u <authUrl> <branch>`
   *
   * @param branchName - New (or overwritten) branch name, e.g. `prism/test-coverage-123`.
   * @param commitMessage - Commit message; double-quotes are escaped automatically.
   * @returns `{ branchName, pushed: true }` on success.
   * @throws If nothing to commit (`git commit` exits 1) or push fails (auth / protection).
   *
   * **Gotchas**
   * - Uses `--force` push — safe because the branch is agent-owned, but will overwrite
   *   manual pushes to the same branch.
   * - Empty workspaces (no diff) will cause `git commit` to throw — caller should check
   *   `git status` beforehand or catch the error.
   * - Commit message is shell-quoted only for `"`; other special chars are passed through.
   *
   * @example
   * ```ts
   * await mgr.commitAndPush('prism/fix-42', 'fix: guard utils against null');
   * // → branch pushed to origin/prism/fix-42
   * ```
   */
  public async commitAndPush(
    branchName: string,
    commitMessage: string
  ): Promise<{ branchName: string; pushed: boolean }> {
    const authUrl = this.getAuthenticatedUrl();

    // 1. Checkout new branch
    await execAsync(`git checkout -B ${branchName}`, { cwd: this.workspacePath });

    // 2. Stage all changes
    await execAsync('git add -A', { cwd: this.workspacePath });

    // 3. Commit
    const safeCommitMsg = commitMessage.replace(/"/g, '\\"');
    await execAsync(`git commit -m "${safeCommitMsg}"`, { cwd: this.workspacePath });

    // 4. Push to remote
    await execAsync(`git push --force -u "${authUrl}" ${branchName}`, { cwd: this.workspacePath });

    return { branchName, pushed: true };
  }

  /**
   * Returns `git status --short` output (porcelain short format).
   * Empty string means a clean workspace.
   */
  public async getStatus(): Promise<string> {
    const { stdout } = await execAsync('git status --short', { cwd: this.workspacePath });
    return stdout;
  }

  /**
   * Returns unstaged + staged `git diff` (unified diff) for the workspace.
   * Useful for debugging what the agent changed before `commitAndPush`.
   */
  public async getDiff(): Promise<string> {
    const { stdout } = await execAsync('git diff', { cwd: this.workspacePath });
    return stdout;
  }
}
