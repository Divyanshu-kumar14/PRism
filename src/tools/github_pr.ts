/**
 * @fileoverview GitHub Pull Request creation tool for {@link CoverageAgent}.
 *
 * **What this module does**
 * - Declares `create_pr` as a Gemini function so the agent can open a PR
 *   without ever crafting raw `git` / REST calls itself.
 * - Orchestrates: `GitRepoManager.commitAndPush()` → `POST /repos/:owner/:repo/pulls`.
 * - Appends a `*Created automatically by PRism…*` footer to every PR body.
 *
 * **Key configurations / parameters**
 * | Param          | Type     | Required | Default                           | Notes |
 * |----------------|----------|----------|-----------------------------------|-------|
 * | `title`        | `string` | ✅        | —                                 | Conventional-commit style encouraged |
 * | `body`         | `string` | ✅        | —                                 | Markdown, rendered on GitHub |
 * | `branchName`   | `string` | —        | `prism/test-coverage-<timestamp>` | Must be a valid ref name |
 * | `commitMessage`| `string` | —        | `title`                             | Double-quote escaped in `repo.ts` |
 *
 * **Usage examples**
 * ```ts
 * // Minimal — agent picks branch name + commit message
 * await executeCreatePr(mgr, {
 *   title: 'test: increase coverage for src/lib/utils',
 *   body: '## Tests added\n- utils: 18 cases...',
 * });
 *
 * // Explicit branch
 * await executeCreatePr(mgr, {
 *   title: 'test: add TRPC router tests',
 *   body: 'Covers 4 routers…',
 *   branchName: 'prism/trpc-router-tests',
 *   commitMessage: 'test: add TRPC router tests'
 * });
 * ```
 *
 * **Edge cases / gotchas**
 * - Requires `GITHUB_TOKEN` with `repo` scope — returns `{ success:false }` otherwise (never throws).
 * - `branchName` collisions use `--force` push (see `repo.ts`) — overwrites prior agent branch.
 * - If the workspace has **no changes**, `commitAndPush` throws `nothing to commit` → caught → `{ success:false }`.
 * - Protected branches (`main`) are `base`, not `head` — the PR is always `head → base`.
 * - API errors surface `data.errors` when present, otherwise `data.message` / `statusText`.
 *
 * @see {@link GitRepoManager#commitAndPush}
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
 */

import type { FunctionDeclaration } from '@google/genai';
import { GitRepoManager } from './repo.js';
import { config, parseGitHubRepoUrl } from '../config.js';

/**
 * Parameters for `create_pr`.
 * `branchName`/`commitMessage` are optional because the agent usually lets the tool
 * invent a timestamped branch and reuse `title`.
 */
export interface CreatePrParams {
  /** PR title — shown in GitHub list & commit message fallback. */
  title: string;
  /** PR body (Markdown) — tests added, motivation, coverage impact. The tool appends an attribution footer. */
  body: string;
  /** Custom head branch name. Defaults to `prism/test-coverage-<Date.now()>`. */
  branchName?: string;
  /** Custom git commit message. Defaults to `title`. */
  commitMessage?: string;
  /** Whether to create the Pull Request as a Draft. Defaults to false. */
  draft?: boolean;
  /** Optional array of GitHub label names to attach to the PR (e.g. `["tests", "automated-pr"]`). */
  labels?: string[];
  /** Optional GitHub Issue number to link (e.g. `42` -> appends `Closes #42` to body). */
  linkedIssueNumber?: number;
}

/**
 * Gemini declaration for `create_pr`.
 * The agent must call this **only after** tests pass (`run_command`) — enforced via system prompt.
 */
export const createPrFunctionDeclaration: FunctionDeclaration = {
  name: 'create_pr',
  description: 'Stages all local changes, commits them to a new Git branch, pushes to GitHub, and opens a Pull Request on the target repository.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'The title of the Pull Request (e.g., "test: increase test coverage for audio utilities and hooks").',
      },
      body: {
        type: 'string',
        description: 'Comprehensive Pull Request body in Markdown explaining the tests added, motivation, and coverage impact.',
      },
      branchName: {
        type: 'string',
        description: 'Optional custom branch name. Defaults to "prism/test-coverage-<timestamp>".',
      },
      commitMessage: {
        type: 'string',
        description: 'Optional git commit message. Defaults to the PR title.',
      },
      draft: {
        type: 'boolean',
        description: 'Whether to open the PR as a draft. Defaults to false.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of label names to attach to the PR (e.g. ["automated-pr", "test-coverage"]).',
      },
      linkedIssueNumber: {
        type: 'integer',
        description: 'Optional GitHub Issue number to link and close automatically upon PR merge.',
      },
    },
    required: ['title', 'body'],
  },
};

/**
 * Commits, pushes, and opens a GitHub Pull Request.
 *
 * @param repoManager - Workspace manager that performs `checkout -B` / `add -A` / `commit` / `push`.
 * @param params - Title, body, optional branch/commit overrides, draft mode, and labels.
 * @returns `{ success, prUrl?, prNumber?, branch?, message }`.
 *   On failure `success` is `false` and `message` explains the cause (never throws to the agent unhandled,
 *   but transport errors are caught and wrapped).
 *
 * @example
 * ```ts
 * const res = await executeCreatePr(mgr, {
 *   title: 'test: coverage',
 *   body: '...',
 *   labels: ['automated-pr', 'tests'],
 *   draft: false,
 * });
 * if (res.success) console.log(`→ ${res.prUrl}`);
 * else console.error(res.message);
 * ```
 */
export function buildPrBody(body: string, linkedIssueNumber?: number): string {
  let finalBody = body;
  if (linkedIssueNumber && typeof linkedIssueNumber === 'number') {
    finalBody += `\n\nCloses #${linkedIssueNumber}`;
  }
  finalBody += '\n\n---\n*Created automatically by [PRism](https://github.com/Divyanshu-kumar14/PRism) AI Test Coverage Agent.*';
  return finalBody;
}

export async function executeCreatePr(
  repoManager: GitRepoManager,
  params: CreatePrParams
): Promise<{ success: boolean; prUrl?: string; prNumber?: number; branch?: string; message: string }> {
  try {
    const token = config.githubToken;
    if (!token) {
      return {
        success: false,
        message: 'GITHUB_TOKEN is not configured. Please set GITHUB_TOKEN in your .env file.',
      };
    }

    const { owner, repo } = parseGitHubRepoUrl(config.targetRepoUrl);
    const branchName = params.branchName || `prism/test-coverage-${Date.now()}`;
    const commitMsg = params.commitMessage || params.title;

    console.log(`\x1b[35m[GitHub PR]\x1b[0m Committing and pushing changes to branch: \x1b[36m${branchName}\x1b[0m...`);
    await repoManager.commitAndPush(branchName, commitMsg);

    console.log(`\x1b[35m[GitHub PR]\x1b[0m Creating Pull Request against \x1b[32m${owner}/${repo}:${config.targetBranch}\x1b[0m...`);

    const prPayload: Record<string, any> = {
      title: params.title,
      body: buildPrBody(params.body, params.linkedIssueNumber),
      head: branchName,
      base: config.targetBranch,
    };

    if (params.draft !== undefined) {
      prPayload.draft = params.draft;
    }

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'PRism-Agent/1.0',
      },
      body: JSON.stringify(prPayload),
    });

    const data = (await response.json()) as any;

    if (!response.ok) {
      const errorDetail = data.errors ? JSON.stringify(data.errors) : (data.message || response.statusText);
      return {
        success: false,
        message: `GitHub API error (${response.status}): ${errorDetail}`,
      };
    }

    const prNumber = data.number;
    console.log(`\x1b[32m[GitHub PR Success]\x1b[0m Pull Request #${prNumber} created: ${data.html_url}`);

    // If labels were requested, apply them via the issues/labels API endpoint
    if (params.labels && Array.isArray(params.labels) && params.labels.length > 0) {
      try {
        await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'PRism-Agent/1.0',
          },
          body: JSON.stringify({ labels: params.labels }),
        });
      } catch (labelErr: any) {
        console.warn(`\x1b[33m[GitHub PR Warning]\x1b[0m Failed to attach labels to PR #${prNumber}: ${labelErr.message}`);
      }
    }

    return {
      success: true,
      prUrl: data.html_url,
      prNumber: data.number,
      branch: branchName,
      message: `Pull Request #${data.number} created successfully: ${data.html_url}`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to create Pull Request: ${err.message}`,
    };
  }
}
