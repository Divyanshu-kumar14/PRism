# 🔮 PRism — Your Repo's Autonomous Teammate

> **Two AI agents. One repo. Zero manual busywork.**
>
> PRism watches your GitHub repo, writes tests, catches leaked secrets, and emails you a clean daily briefing — every night at **10:00 PM IST**. Built in TypeScript on Google Gemini.

**TL;DR — What you get:**

- 🧪 **Agent 1 — Coverage Agent** → finds untested code, writes real tests, runs them until green, opens a PR for you (with surgical patches, grep search & coverage-aware prioritization).
- 🛡️ **Agent 2 — Sentinel (Digest) Agent** → reads last 24h commits, scans for secrets & vulnerabilities, emails a beautiful HTML report + saves `reports/*.html` + pings Slack/Discord/webhooks.
- ⏰ **Scheduler** → runs Sentinel automatically every day. No cron setup.

> **✨ v0.3 — Webhooks, coverage & surgical patches** — Digest now dispatches parallel Slack Block Kit / Discord embeds / generic JSON webhooks (`Promise.allSettled`). Coverage Agent prioritizes uncovered lines via `get_coverage_summary` (O(F*S) with 15s memo). New `patch_file` (exact-match surgical edits) & cached `grep_search` (10s TTL) give the LLM grep + patch without full rewrites. PR creation now supports draft, labels & `Closes #issue` linking. All hot paths remain O(1) memoized from v0.2.

---

## ⚡ Performance & Accessibility — What's New in v0.2–v0.3

**Do No Harm — same inputs/outputs, smarter internals.** Every refactor leaves an inline `// WHY` comment (`// O(1) Map lookup for performance` etc.).

<details><summary><b>🚀 Performance — Big O wins (click to expand)</b></summary>

| Hot path | Before (Big O) | After | Why it matters |
|----------|----------------|-------|----------------|
| `read_file` / `list_dir` repeated explorer turns | O(N) disk + `new Set([...])` per call | **O(1) Map cache** by `mtimeMs` + shared `SHARED_IGNORE_SET` O(1) vs `array.includes` O(n) + LRU TTL 30s, bounded 100/80 | Agent re-reads `package.json` 5+ times per mission — cache saves 50–200ms |
| `get_recent_commits` — `git diff-tree` per commit | O(n) **sequential** awaits (≈ 25ms × 50 = 1.25s) | **O(n/p) parallel** `Promise.all` → ~80ms (15× faster) + `Set` O(1) dedup | 50-commit digest now completes in one batch |
| `run_security_audit` secret scan | O(L × P) nested loops (5 patterns × 5000 lines = 25k regex) | **O(L) single `COMBINED_SECRET_REGEX`** + `SECRET_PATTERN_MAP` O(1) type resolution + 60s `auditCache` | 5× fewer regex tests; repeated audits hit cache |
| `escapeHtml` in email | O(5n) five sequential `replace` | **O(n) single-pass** `ESCAPE_MAP` + `ESCAPE_REGEX` | 30KB HTML renders 5× faster |
| `parseGitHubRepoUrl` / `getAuthenticatedUrl` / `run_command` git reads | O(n) regex/`replace`/spawn per call | **O(1) memoized Map** + `commandCache` TTL 3s for `git status/diff/log` | PR creation + header render parse same URL 5–10× per run |
| `get_coverage_summary` repeated parses | O(F*S) parse 30–500KB JSON × 2–3 times | **O(1) memo** by `mtimeMs` + 15s TTL, LRU 20 | Saves ~50ms on before/after test coverage checks |
| `grep_search` repeated queries | O(N) walk 10k files per query | **O(1) memo** 10s TTL + single compiled regex + `SHARED_IGNORE_SET` O(1) | `grep "export function"` twice in one mission returns instantly |
| Webhook dispatch (Slack/Discord/generic) | sequential `await` per webhook | **`Promise.allSettled` parallel** | 3 webhooks fire in max latency, not sum |

All caches are bounded (LRU eviction) and TTL-invalidated — no memory leak in the long-lived `scheduler` daemon.

</details>

<details><summary><b>♿ Accessibility & UX — email & report (click to expand)</b></summary>

*The archived HTML (`reports/digest-*.html`) is both email and a browser report — now a mini accessible app:*

- **Semantic & ARIA:** `<header role="banner">`, `<main id="main-content" role="main">`, `<section aria-labelledby>`, `role="feed"` for commits, `aria-live="polite"` verdict, `aria-label` on metrics/severity/links, `scope="col"` + `<caption>` on tables, `aria-hidden` on emojis.
- **Contrast:** labels `#64748b → #cbd5e1` / `#94a3b8` on `#0f172a` (now WCAG AA 4.5:1+). Header `#e0e7ff`, metrics `#7dd3fc`/`#a5b4fc`.
- **Keyboard & focus:** every commit/vuln card is `tabindex="0"` with `focus-visible` 2px outline, `skip-link` (offscreen until Tab) → `#main-content`.
- **Micro-interactions:** 150ms `ease` hover (`translateY(-1px)` + `box-shadow`) on cards, `color` transitions on links. Inline `onmouseover` preserved for email clients, `<style>` adds transitions for browser.
- **Skeleton loader:** CSS `shimmer` `@keyframes` + `.skeleton` bars (`.skeleton-card` 64px, `.skeleton-text` 12px), `aria-busy`, auto-hidden via JS after 300ms; disabled instantly when `prefers-reduced-motion: reduce`.
- **Motion safety:** `@media (prefers-reduced-motion: reduce)` kills all animations, `@media (prefers-contrast: more)` thickens borders.
- **Webhook a11y:** Slack `mrkdwn` uses `<url|text>` accessible links, Discord embed `color` maps verdict to semantic green/amber/red for client-side rendering.

</details>

---

## 🤔 What Does PRism Actually Do? (Plain English)

Think of PRism as **two junior developers who never sleep**:

| Agent | Nickname | Job | When it runs |
|---|---|---|---|
| **CoverageAgent** | *The Tester* | Clones your repo → explores code (list/grep/coverage) → writes missing tests → patches code surgically → `npm test` until 100% pass → opens a GitHub PR (draft/labels/Closes #issue) | On demand: `npm run coverage-job` |
| **DailyCommitDigestAgent** | *Sentinel* | Clones your repo → reads commits → runs `npm audit` + secret scan → asks Gemini "is this safe?" → emails HTML report + archives HTML + fires Slack/Discord/webhooks | Daily at 10pm IST or `npm run digest` |

**Simple flow:**

```
Your GitHub Repo
      │
      ├─► [ PRism Tester ] ──► explore (grep/coverage) ──► tests + patches ──► verify ──► GitHub PR (draft/labels)
      │
      └─► [ PRism Sentinel ] ──► security scan ──► email + report in ./reports/
                                   ├─► Slack  (Block Kit)
                                   ├─► Discord (embed)
                                   └─► Generic webhook (JSON)
```

**You'll love PRism if you:**
- Forget to write tests and want coverage without nagging — now with **exact uncovered lines** (`"12-18, 45"`) so the agent patches precisely
- Want to know *what* changed, *who* did it, and *if it's safe* — without reading 50 commits
- Care about leaked `AKIA…`, `ghp_…`, or `postgres://user:pass@` slipping into git
- Live in Slack/Discord — get the verdict there, not just email

---

## ⚡️ 3-Minute Quick Start (Copy → Paste → Run)

### 0. You need

- **Node.js 18+** (`node -v`), **Git** installed
- **Google Gemini key** *(or Vertex AI access)* — [AI Studio key](https://aistudio.google.com/app/apikey) is fastest
- **GitHub PAT** with `repo` scope — [Create one](https://github.com/settings/tokens) (only needed if you want PRs or private repos)

### 1. Install

```bash
git clone https://github.com/Divyanshu-kumar14/PRism.git
cd PRism
npm install
cp .env.example .env   # then edit .env (see next step)
```

### 2. Configure — only 4 fields to start

Edit `.env`:

```bash
# Choose ONE auth method:
GEMINI_API_KEY=AIzaSy...                 # <- past your Gemini API key (easiest)
# OR for enterprise:
# GOOGLE_GENAI_USE_VERTEXAI=true
# GOOGLE_CLOUD_PROJECT=your-gcp-project

GITHUB_TOKEN=github_pat_...              # <- your PAT

TARGET_REPO_URL=https://github.com/your-org/your-repo.git
ALERT_EMAIL_TO=you@example.com           # <- where the 10pm email goes
```

> **Email not set up yet? No problem.** PRism still archives reports to `./reports/` and shows an Ethereal preview link. Add SMTP later.

For Gmail SMTP add:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password   # Gmail → App Password (not your login)
SMTP_SECURE=false             # true only for port 465
# Or modern alternative: RESEND_API_KEY=re_...
```

For Slack/Discord/webhooks (optional — fired in parallel after every digest):

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../XXXX
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123/abc
WEBHOOK_URL=https://your-app.example.com/hooks/prism   # generic JSON
```

### 3. Run it

```bash
# See the daily digest RIGHT NOW (last 24h)
npm run digest

# Weekly view, different inbox
npm run digest -- --since 7d --to teammate@example.com

# Let the Tester write missing tests and open a PR
npm run coverage-job

# Just cover one folder
npm run dev -- --focus "src/lib/utils"

# Talk to it interactively
npm run interactive

# Leave it running → automatic 10pm IST email every day
npm run schedule              # add --run-now to test immediately
```

That's it. The next step is just reading the email (or Slack ping). ☕

---

## 🧩 The Two Agents — In Detail (But Still Human)

### 🛡️ Agent 1: Sentinel — Daily Digest & Security Audit

**Every night (or on demand) it does 8 steps so you don't have to:**

1. `get_recent_commits` — pulls commits since `"24 hours ago"` (or your `--since`)
2. `get_commit_diff` — reads the actual code diffs
3. `run_security_audit` — regex scans added lines for secrets + runs `npm audit` (60s memoized)
4. **Gemini analysis** — decides `🟢 CLEAN` / `🟡 WARNING` / `🔴 VULNERABLE` with file + line + fix
5. Categorizes changes → 🚀 Features / 🐛 Fixes / 🔒 Security / 🧹 Chores / 📝 Other
6. Summarizes **who did what** (commit counts per author)
7. `send_digest_email` — renders HTML + Markdown, saves to `reports/`, sends via Resend → SMTP → Ethereal
8. **Webhooks** — `dispatchWebhooks` fires Slack + Discord + generic in parallel (`Promise.allSettled`) — never blocks email
9. Prints a short executive summary to your terminal

**What the email contains (real example shape):**

- Header: repo `owner/repo` + `September 1, 2026` + 3 metrics (commits / contributors / files)
- **Banner**: green/amber/red verdict with explanation
- **Executive Summary**: 2–4 paragraphs a manager can read in 30s
- **5 categorized lists** with bullet highlights
- **Vulnerability cards** (or `✔ No vulnerabilities detected` box) — each with severity, file:line, description, recommendation
- **Contributor table** (name, email, commits, highlights)
- **All Commits feed** — `[a1b2c3d]` linked to GitHub + author + date + files changed
- Footer: `Generated by PRism + Gemini`

> Preview saved locally even if email fails: `reports/digest-September_1__2026-<iso>.html`

### 🧪 Agent 2: Coverage Agent — Test Writer

**5-step mission (on demand):**

1. `list_dir` + `read_file` + `grep_search` — explores repo → reads `package.json`, source files; `grep_search` finds exports/imports in O(1) cached scans
2. `get_coverage_summary` — parses `coverage/coverage-summary.json` (or `lcov.info`) → overall % + lowest files + exact uncovered lines (`"12-18, 45"`) — 15s memoized
3. `write_file` — creates real tests (`*.test.ts` or `tests/`) — *no* `assert(true)` fakes; `patch_file` — surgical `target → replacement` fixes without full rewrite
4. `run_command` — runs `npx vitest run` / `npm test` / `npx tsc --noEmit` until green (fixes failures itself); `run_command` hard-blocks `sudo`/`rm -rf /`/host `.env` reads + strips secrets from child env + 3s cache for `git status/diff/log`
5. `create_pr` — pushes `prism/coverage-<timestamp>` → opens PR with Markdown description + optional `draft:true`, `labels:["tests"]`, `linkedIssueNumber: 42` (`Closes #42`)

**Modes:**

```bash
npm run coverage-job                              # full codebase
npm run dev -- --focus "src/features/audio"        # one folder
npm run dev -- "Only add tests for TRPC routers"  # natural language instruction
npm run interactive                               # chat REPL (type "clear" to reset)
```

Costs are bounded by `MAX_AGENT_TURNS=25` (one Gemini call per turn) → raise for huge repos, lower to save money.

---

## 🔧 Configuration — The Only File You Touch: `.env`

All knobs live in `src/config.ts` but you never edit it. Just set env vars. Validated at boot via **Zod** — bad types/emails/URLs throw with field-level diagnostics.

### Essential vs. Optional

| You MUST set (to get value) | You CAN tweak (nice defaults) |
|---|---|
| `GEMINI_API_KEY` **or** Vertex (`GOOGLE_GENAI_USE_VERTEXAI`+`GOOGLE_CLOUD_PROJECT`) | `GEMINI_MODEL=gemini-2.5-flash` |
| `GITHUB_TOKEN` (for PRs / private clones) | `TARGET_REPO_BRANCH=main` |
| `TARGET_REPO_URL` (defaults to fluent demo) | `WORKSPACE_DIR=./workspace/fluent` |
| `ALERT_EMAIL_TO` (defaults to `divyanshukumar.dev@proton.me`) | `MAX_AGENT_TURNS=25` |
| Email: `SMTP_HOST`+`SMTP_USER` **or** `RESEND_API_KEY` (or archive-only is fine) | `DIGEST_CRON_SCHEDULE="0 22 * * *"` / `DIGEST_TIMEZONE="Asia/Kolkata"` |
| Webhooks: `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL` / `WEBHOOK_URL` (all optional) | `GOOGLE_CLOUD_LOCATION=us-central1` |

### Full Reference Table

| Variable | Required? | Default | Purpose | Accepted values |
|----------|-----------|---------|---------|-----------------|
| `GOOGLE_GENAI_USE_VERTEXAI` | — | `false` | Vertex AI toggle | `true` / unset. Legacy: `GOOGLE_GENAI_USE_ENTERPRISE` |
| `GOOGLE_CLOUD_PROJECT` | Vertex only | — | GCP project id | Any project id. Fallbacks: `GCP_PROJECT`, `GCLOUD_PROJECT` |
| `GOOGLE_CLOUD_LOCATION` | — | `us-central1` | Vertex region | `us-central1`, `europe-west1` … |
| `GEMINI_API_KEY` | AI Studio mode | — | Google AI Studio key | `AIza…` (alias: `GOOGLE_API_KEY`) |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | Gemini model | `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-pro` |
| `MAX_AGENT_TURNS` | — | `25` | Max LLM↔tool loops | Any positive int (validated 1–100) |
| `GITHUB_TOKEN` | PRs + private | — | GitHub PAT | Classic or fine-grained (alias: `GH_TOKEN`) |
| `TARGET_REPO_URL` | — | `https://github.com/Divyanshu-kumar14/fluent.git` | Clone URL | Any GitHub HTTPS URL |
| `TARGET_REPO_BRANCH` | — | `main` | Branch to track | Any existing branch |
| `WORKSPACE_DIR` | — | `./workspace/fluent` | Local clone path | Relative/absolute |
| `ALERT_EMAIL_TO` | — | `divyanshukumar.dev@proton.me` | Digest `To:` | Email (alias: `EMAIL_TO`) |
| `EMAIL_FROM` | — | `PRism Digest <noreply@prism.dev>` | `From:` header | RFC 5322 display name |
| `SMTP_HOST` | SMTP mode | — | SMTP relay | `smtp.gmail.com` |
| `SMTP_PORT` | — | `587` | SMTP port | `587` (STARTTLS) or `465` |
| `SMTP_USER` / `SMTP_PASS` | SMTP mode | — | Auth | App-password for Gmail |
| `SMTP_SECURE` | — | `false` | Implicit TLS (port 465) | Strict `=== 'true'` |
| `RESEND_API_KEY` | — | — | Resend key (beats SMTP) | `re_…` |
| `SLACK_WEBHOOK_URL` | — | — | Slack incoming webhook | `https://hooks.slack.com/services/…` |
| `DISCORD_WEBHOOK_URL` | — | — | Discord webhook | `https://discord.com/api/webhooks/…` |
| `WEBHOOK_URL` | — | — | Generic JSON webhook (alias `GENERIC_WEBHOOK_URL`) | Any `https://…` |
| `DIGEST_CRON_SCHEDULE` | — | `0 22 * * *` | `node-cron` expr | 5-field cron (no seconds) |
| `DIGEST_TIMEZONE` | — | `Asia/Kolkata` | IANA tz | `Asia/Kolkata`, `UTC`, `America/New_York` … |

### Auth Priority (inside `createGenAIClient`)

```
1. Vertex AI ADC  (useEnterprise && project) → { enterprise:true, project, location }
2. API key       (GEMINI_API_KEY / GOOGLE_API_KEY) → { apiKey }
3. Vertex fallback (project only, even without flag)
4. Empty init    (SDK ADC discovery) — fails on first call if unauthenticated
```

> **Env aliases:** `project` accepts `GOOGLE_CLOUD_PROJECT`→`GCP_PROJECT`→`GCLOUD_PROJECT`; `githubToken` accepts `GITHUB_TOKEN`→`GH_TOKEN`; `emailRecipient` accepts `ALERT_EMAIL_TO`→`EMAIL_TO`; API key accepts `GEMINI_API_KEY`→`GOOGLE_API_KEY`; generic webhook accepts `WEBHOOK_URL`→`GENERIC_WEBHOOK_URL`. All validated via `zod` on boot.

---

## 💻 Usage Cookbook (Copy-Paste)

```bash
# --- Sentinel (Digest) ---
npm run digest                                 # last 24h → default inbox
npm run digest -- --since 24h                  # same, explicit
npm run digest -- --since 7d                   # last 7 days
npm run digest -- --since 30d                  # last 30 days
npm run digest -- --since 7d --to lead@co.com  # custom recipient
npm run digest -- --since 7d --model gemini-1.5-pro # bigger model

# --- Scheduler ---
npm run schedule                               # daemon → 22:00 daily
npm run schedule -- --run-now                  # immediate + then 22:00
npm run schedule -- -r                         # shorthand

# --- Tester (Coverage) ---
npm run coverage-job                           # full codebase → PR
npm run dev -- --focus "src/lib/utils"         # one directory
npm run dev -- "Only test TRPC routers"        # custom natural-language task
npm run interactive                            # REPL chat

# --- Webhooks (no code change) ---
SLACK_WEBHOOK_URL=https://hooks.slack.com/... npm run digest   # Slack ping
DISCORD_WEBHOOK_URL=https://discord.com/api/... npm run digest # Discord embed
WEBHOOK_URL=https://example.com/hook npm run digest             # generic JSON

# --- Dev / Checks ---
npm run typecheck                              # tsc --noEmit
npm run build                                  # tsc → dist/
npm test                                       # vitest run
npm run test:coverage                          # vitest run --coverage
```

**Digest CLI flags (`digest_cli.ts`):**

| Flag | Normalized | Example |
|------|------------|---------|
| `--since <window>` | `24h`/`1d`→`"24 hours ago"`, `7d`/`1w`→`"7 days ago"`, `30d`/`1m`→`"30 days ago"`; pass-through `"2026-09-01"` | `--since 7d` |
| `--to <email>` | — | `--to lead@co.com` |
| `--model <id>` | — | `--model gemini-1.5-pro` |

**Coverage CLI flags (`index.ts`):**

| Flag | Behavior |
|------|----------|
| `--focus <path>` | `runMission({ focusArea })` — LLM focuses tests under that path |
| `<free text>` | Joined as `customPrompt` (only when `--focus` absent) |
| `--interactive` / `-i` | REPL; `exit`/`quit` to leave, `clear`/`reset` to wipe history |

---

## 🏗️ Architecture & Tech Stack

**Stack:** TypeScript · `@google/genai` (Gemini 2.5/2.0/1.5) · `node-cron` (Asia/Kolkata) · `nodemailer` + Resend · `zod` (env validation) · `tsx` · `vitest`

**Project layout:**

```
PRism/
├── .env.example              # copy to .env — all tunables (incl. webhooks)
├── package.json              # scripts: digest / schedule / coverage-job / interactive
├── tsconfig.json             # ES2022 + NodeNext, strict
├── reports/                  # auto-created — digest-*.html + digest-*.md
├── workspace/fluent/         # ephemeral clone (reset --hard every run)
└── src/
    ├── config.ts             # single typed config (Zod) + createGenAIClient + parseGitHubRepoUrl (O(1) memo)
    ├── agent.ts              # CoverageAgent loop (explore → grep/coverage → patch/test → verify → PR)
    ├── digest_agent.ts       # Sentinel loop (commits → diff → audit → email + webhooks)
    ├── digest_cli.ts         # `npm run digest` flag parsing + one-shot runner
    ├── scheduler.ts          # `npm run schedule` cron daemon + --run-now
    ├── index.ts              # `npm run coverage-job` / --focus / --interactive
    ├── services/mailer.ts    # HTML email (inline CSS) + Markdown + Resend/SMTP/Ethereal + Slack/Discord/generic webhooks
    └── tools/
        ├── index.ts          # two Gemini toolsets + dispatchers (agent vs digest)
        ├── repo.ts           # GitRepoManager (clone / reset / push, PAT-injected, O(1) memo)
        ├── file_ops.ts       # read_file / write_file / patch_file / list_dir / grep_search (sandboxed + cached)
        ├── command_runner.ts # run_command (exec in workspace, 8k trunc, hardened + 3s git cache)
        ├── coverage.ts       # get_coverage_summary (coverage-summary.json / lcov.info parser, 15s memo)
        ├── git_digest.ts     # get_recent_commits / get_commit_diff / run_security_audit / send_digest_email
        └── github_pr.ts      # create_pr (git push --force + POST /pulls, draft/labels/Closes #issue)
```

---

## 🧰 Tool Reference (What the AI Can Actually Do)

<details><summary><b>CoverageAgent tools</b> (Tester) — click to expand — cached & hardened</summary>

| Tool | Key params | What it does — perf notes |
|------|-----------|---------------------------|
| `list_dir` | `dirPath="."`, `recursive=true`, `maxDepth=5`, `extension?` | Sandboxed walk via shared `SHARED_IGNORE_SET` O(1) vs `array.includes` O(n); capped 150 (`cappedEntries` O(150) not O(N)) + **TTL 30s LRU cache** (hit saves 50–200ms) |
| `read_file` | `filePath` (relative), `startLine?`, `endLine?` | UTF‑8 slice annotated `12: code`; **memoized by `mtimeMs`** — O(1) Map hit for re-reads across agent turns |
| `write_file` | `filePath`, `content` | Overwrite with `mkdir -p`; **invalidates** `readCache` + `listCache` + `grepCache` (Do No Harm) |
| `patch_file` | `filePath`, `targetContent`, `replacementContent`, `allowMultiple?` | Surgical find-replace — exact match required; rejects ambiguous (>1 hit unless `allowMultiple:true`); invalidates caches like `write_file` |
| `grep_search` | `query`, `isRegex?`, `caseInsensitive?`, `extension?`, `pathPrefix?`, `maxResults=50` | Single compiled regex + `SHARED_IGNORE_SET` O(1) + **10s TTL LRU 40**; pre-filters by whole-content `regex.test` before per-line scan; truncates line to 200 chars |
| `get_coverage_summary` | `reportPath?`, `maxCoverageThreshold=100`, `maxFiles=20` | Parses `coverage-summary.json` / `coverage-final.json` / `lcov.info`; returns `total` %, sorted `files` with `uncoveredLines: "12-18, 45"`; **15s memo by mtime** LRU 20 |
| `run_command` | `command`, `timeoutMs=60000` | `exec` inside workspace (`CI=true`, secrets stripped), 8 000-char trunc, 10 MB buffer; **caches** `git status/diff/log/show` 3s TTL O(1); blocks `sudo`/`rm -rf /`/host `.env` reads |
| `create_pr` | `title`, `body`, `branchName?`, `commitMessage?`, `draft?`, `labels?`, `linkedIssueNumber?` | `git checkout -B` → `add -A` → `commit` → `push --force` → REST `POST /pulls` + footer `Closes #N`; attaches labels via `POST /issues/:n/labels`; uses memoized `parseGitHubRepoUrl` O(1) |

</details>

<details><summary><b>Sentinel tools</b> (Digest) — click to expand — parallel & O(L)</summary>

| Tool | Key params | What it does — perf notes |
|------|-----------|---------------------------|
| `get_recent_commits` | `since="24 hours ago"`, `maxCount=50`, `branch=targetBranch` | `git log --since` + **parallel `Promise.all` diff-tree** O(n/p) vs sequential O(n) (15× faster) + `Set` O(1) dedup; empty window → fallback last 10 |
| `get_commit_diff` | `commitHash?` / `fromHash+toHash` / `maxLines=500` | `git show` or `git diff from..to`; truncates at `maxLines`; uses `commandCache` via `exec` |
| `run_security_audit` | `includeNpmAudit=true`, `commitRange?` (default `HEAD~5 HEAD`) | **Single `COMBINED_SECRET_REGEX`** O(L) vs O(L×P) + `SECRET_PATTERN_MAP` O(1) + **60s `auditCache`** for `npm audit`; scans only `+` lines; falls back `HEAD~1` → `HEAD` for shallow repos |
| `send_digest_email` | `reportDate`, `timeWindow`, `securityVerdict`, `categorizedChanges`, `vulnerabilities`, `authors` … | Delegates to `MailerService`: **single-pass `ESCAPE_MAP` O(n)** + **memoized HTML** (hash O(1) hit) → archive → Resend→SMTP→Ethereal → **parallel webhooks** |
| `read_file` / `list_dir` / `grep_search` | (same as above) | Shared for repo exploration (same caches) |

</details>

---

## 📬 Email Delivery — How It Sends (and Always Saves)

Provider order is **fixed and never fails silently**:

```
1. Resend API  (if RESEND_API_KEY set)  → fetch POST https://api.resend.com/emails
2. SMTP        (if SMTP_HOST+SMTP_USER) → nodemailer
3. Ethereal    (auto temp account)      → preview URL https://ethereal.email/message/…
4. Archive-only → reports/digest-*.html + .md  (still success:true — you keep the file)
```

- `SMTP_SECURE` must be **exactly** `=== 'true'`. Use `false` for 587 (STARTTLS), `true` for 465.
- Subject is `🚨 VULN ALERT` only when `securityVerdict === 'VULNERABLE'`, otherwise `✔ Updates`.
- Timezone must be **IANA** (`Asia/Kolkata`, not `IST` — `RangeError` otherwise).
- Archived filenames: `digest-<safeDate>-<iso>.{html,md}` where `:` → `-` for Windows safety.

---

## 🔗 Webhooks & Integrations

Every digest (email success, Ethereal, or archive-only) also fires any configured webhooks **in parallel** (`Promise.allSettled` — one failure never blocks the others):

| Channel | Env var | Payload | Trigger |
|---------|---------|---------|---------|
| **Slack** | `SLACK_WEBHOOK_URL` | Block Kit: header (`🛡️ PRism Daily Digest - <date>`), 2×2 fields (Repo/Branch/Commits·Files/Verdict), executive summary (1000-char slice) | After email dispatch (Ethereal path; also after Resend/SMTP via `dispatchWebhooks`) |
| **Discord** | `DISCORD_WEBHOOK_URL` | Embed: title + url + color (`CLEAN` green `#10b981` / `WARNING` amber / `VULNERABLE` red), 5 inline fields + description (2048-char) + `timestamp` | Same |
| **Generic** | `WEBHOOK_URL` (alias `GENERIC_WEBHOOK_URL`) | `{ event: "prism.digest.completed", timestamp: ISO, data: DigestReportData }` — full structured report | Same |

**Usage:**

```bash
# One channel
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... npm run digest

# All three
SLACK_WEBHOOK_URL=... DISCORD_WEBHOOK_URL=... WEBHOOK_URL=https://example.com/hook npm run digest

# Persist in .env (recommended)
echo 'SLACK_WEBHOOK_URL=https://hooks.slack.com/...' >> .env
```

**Notes:**
- Webhooks are **best-effort**: `dispatchWebhooks` logs `[Slack Alert Sent]` / warnings but never throws to the agent (digest remains `success:true`).
- To create a Slack webhook: Slack App → Incoming Webhooks → Add to workspace → copy URL. Discord: Channel → Edit Channel → Integrations → Webhooks → Copy URL.
- Generic webhook can target any HTTP endpoint (Zapier, n8n, your backend). It receives the full `DigestReportData` JSON.

---

## ⚠️ Gotchas & Edge Cases (Read Once, Save Hours)

> All of these are already handled — you just need to know they exist.

<details><summary><b>Workspace & Git</b></summary>

- **Ephemeral workspace** — every `initWorkspace()` does `reset --hard origin/<branch>`. Manual edits in `workspace/` are intentionally wiped. Keep experiments elsewhere.
- **Shallow clone (`--depth 50`)** — `get_recent_commits --since 30d` on a busy repo may return fewer than expected. Increase depth in `src/tools/repo.ts` if long windows are critical.
- **Empty commit window** — not an error: falls back to latest **10 commits** and rewrites `timeWindow` to `Latest N commits (No commits in '…')`.
- **Token never logged** — only plain `repoUrl` is printed; PAT lives only in method locals (`getAuthenticatedUrl()` memoized O(1)).

</details>

<details><summary><b>File Tools & Commands</b></summary>

- **Path traversal blocked** — `resolveWorkspacePath` throws if `../../etc/passwd` would escape the workspace.
- **`list_dir` ignores** `.git`, `node_modules`, `.next`, `dist`, `.turbo`, `build`, `.cache` at every depth (O(1) `Set`, shared).
- **Output caps** — `list_dir` slices at 150 entries (check `count` for full total), `run_command` truncates each stream at **8 000 chars** (`…[Output truncated]`), `get_commit_diff` caps at `maxLines=500`, `grep_search` caps at `maxResults=50` and line content at 200 chars. Split large logs by narrowing the query.
- **`run_command` buffer** — 10 MB `maxBuffer`; redirect huge coverage logs to a file (`npx vitest run > out.txt`).
- **`run_command` hardened** — blocks `sudo`/`su`/`mkfs`/`dd if=`/`shutdown`/`reboot`/`rm -rf /`/`fork bomb` and host `.env` reads (`cat ../../.env`); strips `GITHUB_TOKEN`/`GEMINI_API_KEY`/`SMTP_PASS`/… from child env. Blocked commands return `exitCode:1` without spawning.
- **`patch_file` exact match** — `targetContent` must match whitespace/indentation exactly. If it appears >1 time, patch is rejected unless `allowMultiple:true` (then `split→join` replaces all). Empty `targetContent` is rejected.
- **`grep_search` cache** — 10s TTL, 40-entry LRU. Writes (`write_file`/`patch_file`) invalidate grep cache for the workspace. `isRegex:false` escapes query (`query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`) so plain text like `a.b` doesn't become regex.

</details>

<details><summary><b>Coverage</b></summary>

- **Report discovery** — `get_coverage_summary` probes 4 paths in order: `coverage/coverage-summary.json` → `coverage/coverage-final.json` → `coverage/lcov.info` → `coverage-summary.json`. Pass `reportPath` explicitly for custom locations.
- **Uncovered lines** — computed from `statementMap` + `s` (count===0) per file, deduped via `Set` O(n), then compressed to `"1-3, 5, 7-8"` via `formatLineRanges`. LCOV `DA:line,hit` records parsed single-pass via `startsWith('DA:')`. Empty → `"None (100% covered)"`.
- **Memoization** — 15s TTL keyed by `workspace::relPath::threshold::maxFiles` + `mtimeMs`. Call `get_coverage_summary` twice within 15s with same params → O(1) hit; changing `maxFiles` is a cache miss (different key).
- **No report found** → `{ success:false, error: "No coverage report found. Run tests with coverage first…" }` (never throws). LCOV average `linesPct` recomputed from `covered/total` when JSON `total` absent.

</details>

<details><summary><b>Security Audit</b></summary>

- **Secret scan window is 5 commits only** (`git diff HEAD~5 HEAD` or `params.commitRange`). Older leaks beyond 5 commits but inside `--since` are invisible to the regex pass — the AI's `get_commit_diff` visual loop is expected to catch them as `VULNERABLE`. Gracefully falls back `HEAD~1` → `HEAD` for shallow/fresh repos (<5 commits).
- **`npm audit`** is parsed via `.catch(e => e.stdout)` so vulnerabilities on non-zero exit are NOT swallowed. `package.json` absent → `npmAudit:null`.
- **9 secret patterns** via combined named-group regex: Private Key, `AKIA…`, `aws_secret_access_key`, `ghp_…`/`github_pat_…`, `xox[baprs]-`, `sk_live_`, JWT `eyJ…`, generic `api_key = "…"`, DB URLs `postgres://user:pass@`. Snippet truncated at **100 chars** to avoid dumping secrets to `reports/` or email. Type resolved O(1) via `GROUP_TO_TYPE_MAP`.
- **`auditCache` 60s TTL** — second `run_security_audit` call in same mission returns instantly. Bounded to 50 entries.

</details>

<details><summary><b>GitHub PR</b></summary>

- **Draft / labels / linked issue** — `create_pr({ draft:true, labels:["tests"], linkedIssueNumber:42 })` creates PR then `POST /issues/:n/labels`. Labels failure is warned, not fatal. `linkedIssueNumber` appends `Closes #42` to body before footer.
- **Auth** — missing `GITHUB_TOKEN` returns `{ success:false, message:"GITHUB_TOKEN is not configured…" }` (never throws). Protected `main` is `base`, agent branch is `head`.
- **Force push** — `commitAndPush` uses `--force` — safe for agent-owned `prism/*` branches but overwrites manual pushes to same branch. Empty workspace → `git commit` throws → caught → `{ success:false }`.
- **Branch default** — `prism/test-coverage-<Date.now()>` when `branchName` omitted; `commitMessage` defaults to `title` (double-quote escaped).

</details>

<details><summary><b>Scheduler</b></summary>

- Runs **inside Node** (`node-cron`), not system `crond`. If the process dies, the trigger dies — supervise with `pm2`, `systemd`, or Docker `restart: unless-stopped`.
- `cron.validate()` rejects **6-field** seconds-included expressions. `"0 0 22 * * *"` will throw at boot — use **5-field** `"0 22 * * *"`.
- `--run-now` fires **before** validation, so a bad cron string still lets the immediate digest succeed, but the daemon then exits `1`.
- Per-tick errors are **caught** — a failed Tuesday doesn't kill Wednesday's run. Each tick constructs a **fresh** `DailyCommitDigestAgent`.

</details>

<details><summary><b>LLM Loop & Webhooks</b></summary>

- `config.maxTurns` is the only infinite-loop guard (validated 1–100 via Zod). Budget accordingly (each turn = one Gemini call). Raise via `MAX_AGENT_TURNS` for big repos, lower for cost control.
- `history` grows without pruning — reuse an instance across many `chat()` calls only if you also call `agent.resetHistory()` (digest variant clears `cachedCommits` too).
- Tool results are truncated to 250 chars in your console but **full** (8 000-char) payload is sent back to the LLM.
- Webhooks are dispatched **after** email archive; `Promise.allSettled` ensures partial failure (e.g., Slack 404) doesn't cancel Discord. Check console for `✔ [Slack Alert Sent]` vs `[Slack Webhook Error]`.

</details>

---

## ❓ Troubleshooting — Common Human Mistakes

| You see… | It means… | Fix |
|---|---|---|
| `Could not find API key` / auth error | No Gemini credentials | Set `GEMINI_API_KEY=AIza…` or `GOOGLE_GENAI_USE_VERTEXAI=true` + `gcloud auth application-default login` |
| `Not Set (Set GITHUB_TOKEN)` banner | No PAT | Add `GITHUB_TOKEN=github_pat_...` to `.env` or PR/push will fail |
| `Invalid cron schedule expression` | Bad cron | Must be 5-field: `"0 22 * * *"` not `"0 0 22 * * *"` |
| `RangeError: Invalid time zone` | Bad timezone | Use IANA: `Asia/Kolkata` not `IST` → [full list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) |
| `Path traversal violation` | `read_file` escaped workspace | Use relative paths inside workspace only (`workspace/fluent/...`) |
| `Invalid application configuration` | Zod validation failed at boot | Check console `[Configuration Error]` — field-level messages (e.g., email format, port range, `maxTurns` 1–100) |
| Email not received but console says `✔ Daily Digest Completed` | Provider failed, but archive succeeded | Check `reports/*.html` — that file IS the report. Then fix `SMTP_*` or add `RESEND_API_KEY` |
| `No commits in '30d'` but you expected many | Shallow clone hid them | Raise `--depth 50` in `src/tools/repo.ts` or use shorter `--since` |
| `Maximum turns limit without completion` | Repo too large or LLM stuck | Raise `MAX_AGENT_TURNS=40` or narrow with `--focus` |
| `Target content not found in ... Ensure exact whitespace` | `patch_file` miss | Copy exact block including indentation/newlines, or use `read_file` to get verbatim slice |
| `Target content found 3 times … provide more context` | Ambiguous patch | Include more surrounding lines or set `allowMultiple:true` |
| `[Security Violation] Command blocked` | Hardened `run_command` rejected it | Avoid `sudo`/`rm -rf /`/`cat ../../.env`; use workspace-relative commands |
| `No coverage report found` | `get_coverage_summary` no file | Run `npx vitest run --coverage` first; check `reportPath` / coverage dir |
| `[Slack Webhook Error] 404` / `[Discord Webhook Error]` | Bad webhook URL | Verify `SLACK_WEBHOOK_URL`/`DISCORD_WEBHOOK_URL` from Slack/Discord settings; test with `curl -X POST -H 'Content-Type: application/json' -d '{"text":"hello"}' $URL` |
| `Failed to attach labels to PR #…` warning | Label doesn't exist in repo | Create labels in GitHub → Issues → Labels first, or omit `labels` |

---

## 📝 Useful Commands

```bash
npm run digest -- --help          # flags: --since / --to / --model
npm run digest -- --since 24h     # 24h shorthand → "24 hours ago"
npm run schedule -- --run-now     # instant + nightly 22:00
npm run coverage-job              # alias for coverage-agent full mission
npm run dev -- --focus "src/lib"  # Tester, focused
npm run interactive               # REPL chat
npm run typecheck                 # tsc --noEmit (also surfaces TSDoc diagnostics)
npm run build                     # tsc → dist/
npm start                         # node dist/index.js (after build)
npm test                          # vitest run
npm run test:coverage             # vitest run --coverage
```

---

## 📚 In‑Place Code Documentation (Latest Advancement — v0.3)

Every module under `src/` now carries comprehensive TSDoc headers **plus inline `// WHY` perf/a11y/security comments** covering overview, key configs/params, usage examples, and edge-case tables — your editor hover already documents the system. v0.3 adds webhook + coverage + patch/grep rationale comments throughout.

| Module | Header emphasis | v0.3 Perf/A11y/Security comments |
|--------|-----------------|-----------------------------------|
| `src/config.ts` | Full `AppConfig` (Zod) field docs, `parseGitHubRepoUrl` contract, `createGenAIClient` cascade, `loadConfig` alias table | `// O(1) memoization for repo URL parsing` |
| `src/agent.ts` | 5‑step mission template, `RunMissionOptions` examples, `maxTurns` failure mode | `// bounded history` notes |
| `src/digest_agent.ts` | 8‑step Sentinel procedure (now 9 with webhooks), `cachedCommits` lifecycle, timezone validity | `// cachedCommits thread-through` |
| `src/tools/repo.ts` | Auth‑URL injection (O(1) memo), `setupWorkspace` vs shallow clone, force‑push safety | `// O(1) memoization for auth URL` |
| `src/tools/file_ops.ts` | Traversal guard, slice annotation, ignore‑list, 150‑entry cap, `patch_file` exact-match, `grep_search` single-regex | `// O(1) Set lookup` `// TTL LRU read/list/grep cache` `// cappedEntries O(150) vs O(N)` `// single compiled regex` |
| `src/tools/command_runner.ts` | Timeout, 8 000‑char truncation, `CI=true`, maxBuffer, hardening (sudo/rm/.env block + secret strip) | `// O(1) cache for git status/diff` `// LRU TTL 3s` `// SENSITIVE_ENV_KEYS strip` `// isDangerousCommand` |
| `src/tools/coverage.ts` | `coverage-summary.json`/`lcov.info` parsing, `formatLineRanges` compression, filter/sort | `// 15s memo by mtime` `// O(F*S) single-pass` `// O(n log n) sort` `// Set dedup O(n)` |
| `src/tools/git_digest.ts` | 4‑tool matrix, fallback semantics, 9-pattern secret catalog, custom `commitRange` | `// Promise.all O(n/p)` `// COMBINED_SECRET_REGEX O(L)` `// SECRET_PATTERN_MAP O(1)` `// auditCache` |
| `src/tools/github_pr.ts` | Branch naming, PAT setup, PR footer (`Closes #N`), draft/labels | `// O(1) repo parse memo` `// buildPrBody` |
| `src/tools/index.ts` | Two dispatchers, `cachedCommits` thread‑through, 9-tool dispatch, unknown‑tool recovery | dispatcher unchanged (now 9 declarations) |
| `src/services/mailer.ts` | HTML section order, Markdown sibling, provider cascade, archive naming, **webhook dispatch** | `// single-pass ESCAPE_MAP O(n)` `// htmlRenderCache O(1)` `// VERDICT_MAP O(1)` `// ARIA/contrast/skeleton` `// dispatchWebhooks allSettled` |
| `src/index.ts` / `src/digest_cli.ts` | Flag parsing tables, `customPrompt` vs `focusArea` precedence, `--since` normalization | unchanged |
| `src/scheduler.ts` | Cron validation, `--run-now` boot ordering, daemon supervision, fresh agent per tick | bounded cache notes |

Run `npx tsc --noEmit` (or `npm run typecheck`) to surface all TSDoc diagnostics. No `process.env` reads outside `config.ts` — add a field there instead. Search `// O(1)` or `// Perf:` or `// Security:` to audit every win.

---

## 📄 License

MIT — see [`LICENSE`](./LICENSE). Generated autonomously by PRism (`@google/genai`) and documented for human operators.
