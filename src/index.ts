/**
 * @fileoverview CLI entry point for the **CoverageAgent** (Agent 1).
 *
 * **What this file does**
 * - Prints a banner with resolved config (`targetRepo`, `workspace`, `model`, auth mode, PAT presence).
 * - Parses three CLI modes:
 *   1. **Default daily job** → `npm run coverage-job` → `runMission()` (full coverage ⇒ PR)
 *   2. **Focused job** → `npm run dev -- --focus "src/lib/utils"` → coverage only under that path
 *   3. **Interactive chat** → `npm run interactive` / `--interactive` → REPL that forwards every line to `agent.chat()`
 * - Falls back to `customPrompt` when non‑flag text is supplied (`npm run dev -- "Only test routers"`).
 * - Always calls `initWorkspace()` first so commands run on the latest `origin/<branch>`.
 *
 * **Key configurations / parameters (CLI flags)**
 *
 * | Flag / Arg | Type | Example | Behavior |
 * |------------|------|---------|----------|
 * | `--interactive` / `-i` | flag | `npm run interactive` | Starts `readline` REPL; ignores other flags |
 * | `--focus <path>` | `string` | `--focus "src/features/audio"` | Passed as `runMission({ focusArea })` — LLM focuses tests under that path |
 * | `<free text>` | `string[]` | `npm run dev -- "Add tests for TRPC routers"` | Joined as `customPrompt` (only when `--focus` absent and not interactive) |
 * | (no flags) | — | `npm run coverage-job` | Full‑codebase mission with the default 5‑step prompt |
 * | REPL: `exit` / `quit` | — | | Ends the process |
 * | REPL: `clear` / `reset` | — | | `agent.resetHistory()` |
 *
 * **Usage examples**
 * ```bash
 * npm run coverage-job                              # full codebase → PR
 * npm run dev -- --focus "src/lib/utils"            # narrow to one dir
 * npm run dev -- "Only add tests for src/trpc/*"    # custom prompt
 * npm run interactive                               # chat mode
 * # Inside REPL:
 * # You > Write tests for src/lib/currency.ts and verify they pass
 * # You > clear        # forget prior context
 * ```
 *
 * **Edge cases / gotchas**
 * - `--focus` consumes exactly **one** next token; quoting is required for paths,
 *   but `--focus src/lib/utils --another` still treats only `src/lib/utils` as the value.
 * - Free‑text `customPrompt = args.join(' ')` will swallow typos like `—focus` (em‑dash)
 *   instead of flag‑parsing them — the LLM will just see it as ambiguous instructions.
 * - REPL uses `readline.question` recursion — `Ctrl+C` kills the process (no graceful history dump).
 * - If `initWorkspace()` fails (bad PAT, no network, shallow‑clone break), the process exits `1`.
 * - All scripts are invoked with `tsx src/index.ts`, so the file must stay CommonJS‑free (ESM only).
 */

import readline from 'readline';
import { CoverageAgent } from './agent.js';
import { config, parseGitHubRepoUrl } from './config.js';

/**
 * Parses `process.argv`, boots the agent, and runs the chosen mode.
 * Pure side‑effects; not exported for reuse.
 *
 * @see {@link CoverageAgent#runMission}
 * @see {@link CoverageAgent#chat}
 */
async function main() {
  console.log('\x1b[35m============================================================\x1b[0m');
  console.log('\x1b[1m\x1b[36m🚀 PRism - Autonomous Codebase Coverage & PR Agent\x1b[0m');
  console.log('\x1b[35m============================================================\x1b[0m');
  console.log(`• Target Repo:    \x1b[32m${config.targetRepoUrl}\x1b[0m (branch: \x1b[33m${config.targetBranch}\x1b[0m)`);
  console.log(`• Workspace:      \x1b[34m${config.workspaceDir}\x1b[0m`);
  console.log(`• Gemini Model:   \x1b[32m${config.model}\x1b[0m`);
  console.log(`• Auth Mode:      \x1b[32m${config.useEnterprise ? 'Google Cloud Vertex AI (ADC / gcloud)' : 'Google AI Studio API Key'}\x1b[0m`);
  console.log(`• GitHub Token:   \x1b[32m${config.githubToken ? 'Configured (PAT Active)' : '\x1b[31mNot Set (Set GITHUB_TOKEN in .env)\x1b[0m'}\x1b[0m`);
  console.log('\x1b[35m------------------------------------------------------------\x1b[0m\n');

  const agent = new CoverageAgent();

  // Parse command line arguments
  const args = process.argv.slice(2);
  const isInteractive = args.includes('--interactive') || args.includes('-i');
  const focusIndex = args.indexOf('--focus');
  const focusArea = focusIndex !== -1 && args[focusIndex + 1] ? args[focusIndex + 1] : undefined;
  const customPrompt = args.length > 0 && !isInteractive && focusIndex === -1 ? args.join(' ') : undefined;

  // Initialize workspace (clone / pull repo)
  await agent.initWorkspace();

  if (isInteractive) {
    // Interactive Chat Mode
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('Interactive Mode activated. Type your instruction or question (or "exit" / "quit"):');
    console.log('Examples:');
    console.log('  - "Write unit tests for src/lib/utils.ts and verify they pass"');
    console.log('  - "Increase test coverage for TRPC routers and submit a PR"\n');

    const promptUser = () => {
      rl.question('\x1b[1m\x1b[34mYou > \x1b[0m', async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          promptUser();
          return;
        }

        if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
          console.log('\nGoodbye! 👋\n');
          rl.close();
          process.exit(0);
        }

        if (trimmed.toLowerCase() === 'clear' || trimmed.toLowerCase() === 'reset') {
          agent.resetHistory();
          console.log('\x1b[33m[Conversation history cleared]\x1b[0m\n');
          promptUser();
          return;
        }

        try {
          const response = await agent.chat(trimmed);
          console.log(`\n\x1b[1m\x1b[32mPRism Agent >\x1b[0m\n${response}\n`);
        } catch (error: any) {
          console.error(`\x1b[31m[Error]:\x1b[0m ${error.message || error}\n`);
        }

        promptUser();
      });
    };

    promptUser();
    return;
  }

  // Automated Coverage Mission Mode (Daily Job)
  console.log('\x1b[1m\x1b[36m⚡ Starting Autonomous Test Coverage Mission...\x1b[0m\n');
  if (focusArea) {
    console.log(`\x1b[33mFocus Area:\x1b[0m ${focusArea}`);
  } else if (customPrompt) {
    console.log(`\x1b[33mCustom Task:\x1b[0m ${customPrompt}`);
  }

  try {
    const finalReport = await agent.runMission({
      focusArea,
      customPrompt,
    });

    console.log('\n\x1b[35m============================================================\x1b[0m');
    console.log('\x1b[1m\x1b[32m✔ Mission Completed Successfully\x1b[0m');
    console.log('\x1b[35m============================================================\x1b[0m');
    console.log(`\n${finalReport}\n`);
  } catch (error: any) {
    console.error('\n\x1b[31m[Mission Error]:\x1b[0m', error.message || error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\x1b[31mFatal error:\x1b[0m', err);
  process.exit(1);
});
