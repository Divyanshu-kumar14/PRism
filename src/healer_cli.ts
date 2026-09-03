#!/usr/bin/env node
/**
 * @fileoverview CLI for the Healer Agent — `npm run healer`
 *
 * **What this module does**
 * - Parses CLI flags (`--pr`, `--branch`, `--command`, `--log`, `--allow-push`)
 * - Instantiates {@link HealerAgent}, calls `initWorkspace()` + `heal()`
 * - Prints a concise human summary and exits with 0 (healed or already green) or 1 (failed)
 *
 * **Usage examples**
 * ```bash
 * # Heal typecheck on current branch (dry-run)
 * npm run healer -- --command "npx tsc --noEmit"
 *
 * # Heal PR #42 branch that failed `npm test`, with CI log tail
 * npm run healer -- --pr 42 --branch feat/add-checkout --command "npm test" --log /tmp/ci.log
 *
 * # Heal and push fix to remote (requires GITHUB_TOKEN)
 * npm run healer -- --pr 42 --branch feat/add-checkout --command "npm test" --allow-push
 *
 * # Heal eslint
 * npm run healer -- --command "npx eslint . --max-warnings 0"
 * ```
 *
 * @see {@link HealerAgent}
 */

import fs from 'fs';
import { HealerAgent } from './healer_agent.js';
import { config } from './config.js';

function parseArgs(argv: string[]): {
  prNumber?: number;
  branch?: string;
  failingCommand?: string;
  ciLogTail?: string;
  allowPush?: boolean;
  help?: boolean;
} {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr' && argv[i + 1]) out.prNumber = parseInt(argv[++i], 10);
    else if (a === '--branch' && argv[i + 1]) out.branch = argv[++i];
    else if (a === '--command' && argv[i + 1]) out.failingCommand = argv[++i];
    else if (a === '--log' && argv[i + 1]) {
      const p = argv[++i];
      try {
        out.ciLogTail = fs.readFileSync(p, 'utf8');
      } catch {
        console.warn(`\x1b[33m[Healer CLI] Could not read log file ${p}, continuing without log tail\x1b[0m`);
      }
    } else if (a === '--allow-push') out.allowPush = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out as never;
}

function printHelp(): void {
  console.log(`
\x1b[1mPRism Healer CLI\x1b[0m — Fix a red CI branch locally and optionally push.

\x1b[36mUsage:\x1b[0m
  npm run healer -- [options]
  npx tsx src/healer_cli.ts [options]

\x1b[36mOptions:\x1b[0m
  --pr <number>       PR number for commit message / comment (e.g. --pr 42)
  --branch <name>     PR branch to checkout (e.g. --branch feat/add-checkout)
  --command <cmd>     Failing command to heal (default: "npx tsc --noEmit")
  --log <path>        Path to CI log file (last 8k sent to LLM)
  --allow-push        Push fix commit to remote (requires GITHUB_TOKEN, default: dry-run)
  --help, -h          Show this help

\x1b[36mExamples:\x1b[0m
  npm run healer -- --command "npx tsc --noEmit"
  npm run healer -- --pr 42 --branch feat/add-checkout --command "npm test" --log /tmp/ci.log --allow-push

\x1b[36mEnv:\x1b[0m
  HEALER_ENABLED=true  HEALER_MAX_ATTEMPTS=3  HEALER_ALLOW_PUSH=true  GEMINI_API_KEY=...
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const failingCommand = args.failingCommand || 'npx tsc --noEmit';
  const branch = args.branch || config.targetBranch;

  console.log(`\x1b[36m[Healer CLI]\x1b[0m Branch: \x1b[1m${branch}\x1b[0m | Command: \x1b[33m${failingCommand}\x1b[0m${args.prNumber ? ` | PR #${args.prNumber}` : ''}${args.allowPush ? ' | \x1b[32mallowPush\x1b[0m' : ' | dry-run'}`);

  const healer = new HealerAgent();
  await healer.initWorkspace();

  const result = await healer.heal({
    prNumber: args.prNumber,
    branch: args.branch,
    failingCommand,
    ciLogTail: args.ciLogTail,
    allowPush: args.allowPush ?? config.healerAllowPush,
  });

  console.log('\n' + (result.healed ? '\x1b[32m✔ Healed\x1b[0m' : '\x1b[31m✖ Not healed\x1b[0m') + ` — ${result.summary}`);
  console.log(`\x1b[90mMetrics: ${result.metrics.totalTurns} turns, ${result.metrics.totalToolCalls} tool calls, ${result.metrics.totalDurationMs}ms\x1b[0m`);
  if (result.fixCommitSha) console.log(`\x1b[90mFix SHA: ${result.fixCommitSha}\x1b[0m`);

  process.exit(result.healed ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\n\x1b[31m[Healer CLI Error]:\x1b[0m', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
