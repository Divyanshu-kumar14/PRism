/**
 * @fileoverview Cron daemon — fires the daily digest every day at 10:00 PM IST.
 *
 * **What this module does**
 * - Starts a `node‑cron` daemon that invokes {@link DailyCommitDigestAgent} on schedule.
 * - Validates the cron expression at boot so typos are caught before a long‑running silent failure.
 * - Supports `--run-now` / `-r` for immediate execution (useful for bootstrapping and health checks)
 *   before the first natural tick at 22:00.
 * - Each tick constructs a **fresh** {@link DailyCommitDigestAgent} instance so state never leaks
 *   between scheduled runs.
 *
 * **Key configurations / parameters**
 *
 * | Param / Env | Type | Default | Notes |
 * |-------------|------|---------|-------|
 * | `DIGEST_CRON_SCHEDULE` | cron string | `"0 22 * * *"` (daily 22:00) | 5‑field `node‑cron` — minute hour day month weekday. `0 9 * * 1` would be Mondays 09:00 |
 * | `DIGEST_TIMEZONE` | IANA string | `"Asia/Kolkata"` (IST) | Shared between filename/report + cron evaluation. Must be a `Intl`‑valid name |
 * | `--run-now` / `-r` | CLI flag | — | Run once on startup *and* then wait for the cron tick |
 *
 * **Usage examples**
 * ```bash
 * npm run schedule                        # daemon waits until 22:00 IST
 * npm run schedule -- --run-now           # immediate digest + then 22:00 daily
 * npm run schedule -- -r                  # shorthand
 *
 * # Changing the schedule without code edits:
 * DIGEST_CRON_SCHEDULE="0 9 * * 1" DIGEST_TIMEZONE="America/New_York" npm run schedule
 * ```
 *
 * **Edge cases / gotchas**
 * - `node‑cron` runs **inside** the Node process, not as a system crond. If the process exits
 *   (OOM, `Ctrl+C`, container restart), the schedule is lost — run in `pm2`, `systemd`, or Docker `restart: unless‑stopped`.
 * - `cron.validate()` is strict; a 6‑field seconds‑included expression like `"0 0 22 * * *"` is considered **invalid** and throws immediately.
 * - `getFormattedISTNow()` uses `Intl.DateTimeFormat` — a bad `DIGEST_TIMEZONE` like `"IST"` (not `"Asia/Kolkata"`)
 *   throws `RangeError`. Validate IANA names against https://en.wikipedia.org/wiki/List_of_tz_database_time_zones.
 * - Each cron tick catches its own errors and logs `✖ Scheduled Daily Digest …` rather than killing the daemon,
 *   so the next day's run will still fire.
 * - The daemon holds the event loop alive forever — the post‑`cron.schedule` `console.log` line is the last line
 *   that *must* complete before `npm run schedule` appears “hung” (intentionally).
 *
 * @see {@link DailyCommitDigestAgent#runDigest}
 * @see https://github.com/node-cron/node-cron
 */

import cron from 'node-cron';
import { DailyCommitDigestAgent } from './digest_agent.js';
import { config, parseGitHubRepoUrl } from './config.js';

/**
 * Returns the current instant formatted in the configured IST timezone.
 * Example: `"Monday, September 1, 2026 at 10:00:00 PM"`.
 * @private
 */
function getFormattedISTNow(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.cronTimezone,
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(new Date());
}

/**
 * Single scheduled invocation: fresh agent → `initWorkspace` → `runDigest(24h)`.
 * Errors are logged but **not** re‑thrown so the daemon survives.
 */
async function triggerDailyDigestJob() {
  console.log(`\n\x1b[35m============================================================\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m⏰ [10:00 PM IST Scheduled Trigger]\x1b[0m ${getFormattedISTNow()}`);
  console.log(`\x1b[35m============================================================\x1b[0m\n`);

  const agent = new DailyCommitDigestAgent();

  try {
    await agent.initWorkspace();
    const result = await agent.runDigest({
      since: '24 hours ago',
      recipient: config.emailRecipient,
    });
    console.log(`\n\x1b[32m✔ Scheduled Daily Digest finished successfully.\x1b[0m`);
  } catch (err: unknown) {
    console.error(`\x1b[31m✖ Scheduled Daily Digest encountered an error:\x1b[0m`, (err instanceof Error ? err.message : String(err)) || err);
  }
}

/**
 * Boots the daemon: banner → optional `--run-now` firing → validation → `cron.schedule` forever.
 * Process terminates only via unhandled exception or `Ctrl+C` (`SIGINT`).
 */
async function main() {
  console.log('\x1b[35m============================================================\x1b[0m');
  console.log('\x1b[1m\x1b[36m⏰ PRism Daily Digest Scheduler Daemon\x1b[0m');
  console.log('\x1b[35m============================================================\x1b[0m');

  let repoShort = config.targetRepoUrl;
  try {
    const { owner, repo } = parseGitHubRepoUrl(config.targetRepoUrl);
    repoShort = `${owner}/${repo}`;
  } catch {}

  console.log(`• Target Repo:      \x1b[32m${repoShort}\x1b[0m (branch: \x1b[33m${config.targetBranch}\x1b[0m)`);
  console.log(`• Recipient:        \x1b[36m${config.emailRecipient}\x1b[0m`);
  console.log(`• Cron Expression:  \x1b[33m${config.cronSchedule}\x1b[0m (10:00 PM daily)`);
  console.log(`• Timezone:         \x1b[34m${config.cronTimezone}\x1b[0m`);
  console.log(`• Current Time:     \x1b[37m${getFormattedISTNow()}\x1b[0m`);
  console.log('\x1b[35m------------------------------------------------------------\x1b[0m\n');

  const args = process.argv.slice(2);
  if (args.includes('--run-now') || args.includes('-r')) {
    console.log('\x1b[33m[Notice] Immediate execution triggered via --run-now...\x1b[0m');
    await triggerDailyDigestJob();
  }

  // Validate cron expression
  if (!cron.validate(config.cronSchedule)) {
    throw new Error(`Invalid cron schedule expression: "${config.cronSchedule}"`);
  }

  console.log(`\x1b[32m✔ Scheduler active!\x1b[0m Daemon is running and waiting for \x1b[1m10:00 PM IST\x1b[0m trigger daily.`);
  console.log(`(Press Ctrl+C to stop the daemon)\n`);

  cron.schedule(
    config.cronSchedule,
    async () => {
      await triggerDailyDigestJob();
    },
    {
      timezone: config.cronTimezone,
    }
  );
}

main().catch((err) => {
  console.error('\x1b[31mFatal scheduler error:\x1b[0m', err);
  process.exit(1);
});
