/**
 * @fileoverview On‑demand CLI runner for the **Daily Commit & Vulnerability Digest** agent.
 *
 * **What this file does**
 * - Prints a banner with resolved config (`repo`, `recipient`, `timezone`, `model`, auth mode).
 * - Parses CLI flags, normalises short‑hands, constructs one {@link DailyCommitDigestAgent},
 *   syncs the workspace, and runs a **single** digest (`runDigest`).
 * - Exits `0` on success (email sent + archive written) or `1` on fatal error.
 *
 * **Key configurations / parameters (CLI flags)**
 *
 * | Flag | Type | Default | Normalized | Notes |
 * |------|------|---------|------------|-------|
 * | `--since <window>` | `string` | `"24 hours ago"` | `24h`/`1d` → `"24 hours ago"`, `7d`/`1w` → `"7 days ago"`, `30d`/`1m` → `"30 days ago"` | Free‑form values like `"2026-09-01"` pass through untouched to `git log --since` |
 * | `--to <email>` | `string` | `config.emailRecipient` | — | Recipient override, great for ad‑hoc leads |
 * | `--model <id>` | `string` | `config.model` | — | Per‑run model swap, e.g. `gemini‑1.5‑pro` |
 *
 * **Usage examples**
 * ```bash
 * npm run digest                                 # last 24 h → default recipient
 * npm run digest -- --since 7d                    # last 7 days
 * npm run digest -- --since 30d --to lead@co.com  # 30 d → custom recipient
 * npm run digest -- --since "2026-08-01"           # ISO / absolute date
 * npm run digest -- --since 7d --model gemini-1.5-pro  # experiment with a larger model
 * ```
 *
 * **Edge cases / gotchas**
 * - Flag values are taken as **the very next token** — `--since 7d extra` leaves `extra` unused.
 * - Missing flag value (trailing `--since`) falls back to `"24 hours ago"` rather than erroring.
 * - Normalisation is **exact‑match only**; `7D` (uppercase) or `7 days` (space) will not be rewritten
 *   but typically still accepted by `git log --since`.
 * - The digest always **archives locally** even when the email provider fails (see `MailerService`),
 *   so a `✔ Daily Digest Completed` log does not guarantee the SMTP/Resend call succeeded — check
 *   the console lines for `[Email]` / `[Report Archive]` and `reports/` for the `.html` file.
 * - `initWorkspace()` does a shallow clone (`--depth 50`) — very old commit windows may truncate silently.
 *
 * @see {@link DailyCommitDigestAgent#runDigest}
 * @see {@link MailerService#sendDigestEmail} for the downstream provider cascade.
 */

import { DailyCommitDigestAgent } from './digest_agent.js';
import { config, parseGitHubRepoUrl } from './config.js';

/**
 * Parses `process.argv`, boots the Sentinel agent, and executes a one‑shot digest.
 * Not exported — side‑effect only when invoked directly via `npm run digest`.
 */
async function main() {
  console.log('\x1b[35m============================================================\x1b[0m');
  console.log('\x1b[1m\x1b[36m🛡️  PRism - Daily Commit & Vulnerability Digest Agent\x1b[0m');
  console.log('\x1b[35m============================================================\x1b[0m');

  let repoShort = config.targetRepoUrl;
  try {
    const { owner, repo } = parseGitHubRepoUrl(config.targetRepoUrl);
    repoShort = `${owner}/${repo}`;
  } catch {}

  console.log(`• Target Repo:    \x1b[32m${repoShort}\x1b[0m (branch: \x1b[33m${config.targetBranch}\x1b[0m)`);
  console.log(`• Recipient:      \x1b[36m${config.emailRecipient}\x1b[0m`);
  console.log(`• Timezone:       \x1b[34m${config.cronTimezone} (10:00 PM IST Digest)\x1b[0m`);
  console.log(`• Gemini Model:   \x1b[32m${config.model}\x1b[0m`);
  console.log(`• Auth Mode:      \x1b[32m${config.useEnterprise ? 'Google Cloud Vertex AI (ADC)' : 'Google AI Studio API Key'}\x1b[0m`);
  console.log('\x1b[35m------------------------------------------------------------\x1b[0m\n');

  // Parse CLI args
  const args = process.argv.slice(2);
  const sinceIndex = args.indexOf('--since');
  let since = sinceIndex !== -1 && args[sinceIndex + 1] ? args[sinceIndex + 1] : '24 hours ago';

  // Normalize shorthand flags like 24h, 7d, 30d
  if (since === '24h' || since === '1d') since = '24 hours ago';
  if (since === '7d' || since === '1w') since = '7 days ago';
  if (since === '30d' || since === '1m') since = '30 days ago';

  const toIndex = args.indexOf('--to');
  const recipient = toIndex !== -1 && args[toIndex + 1] ? args[toIndex + 1] : config.emailRecipient;

  const modelIndex = args.indexOf('--model');
  const customModel = modelIndex !== -1 && args[modelIndex + 1] ? args[modelIndex + 1] : undefined;

  const agent = new DailyCommitDigestAgent(customModel);

  // Initialize workspace
  await agent.initWorkspace();

  console.log(`\x1b[1m\x1b[36m⚡ Running Daily Digest & Security Audit (Timeframe: ${since})...\x1b[0m\n`);

  try {
    const report = await agent.runDigest({
      since,
      recipient,
    });

    console.log('\n\x1b[35m============================================================\x1b[0m');
    console.log('\x1b[1m\x1b[32m✔ Daily Digest Completed & Dispatched\x1b[0m');
    console.log('\x1b[35m============================================================\x1b[0m');
    console.log(`\n${report}\n`);
  } catch (err: any) {
    console.error('\n\x1b[31m[Digest Error]:\x1b[0m', err.message || err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\x1b[31mFatal error:\x1b[0m', err);
  process.exit(1);
});
