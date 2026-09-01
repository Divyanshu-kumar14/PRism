# 🔮 PRism — Your Repo's Autonomous Teammate

> **Two AI agents. One repo. Zero manual busywork.**
>
> PRism watches your GitHub repo, writes tests, catches leaked secrets, and emails you a clean daily briefing — every night at **10:00 PM IST**. Built in TypeScript on Google Gemini.

**TL;DR — What you get:**

- 🧪 **Agent 1 — Coverage Agent** → finds untested code, writes real tests, runs them until green, opens a PR for you.
- 🛡️ **Agent 2 — Sentinel (Digest) Agent** → reads last 24h commits, scans for secrets & vulnerabilities, emails a beautiful HTML report + saves `reports/*.html`.
- ⏰ **Scheduler** → runs Sentinel automatically every day. No cron setup.

---

## 🤔 What Does PRism Actually Do? (Plain English)

Think of PRism as **two junior developers who never sleep**:

| Agent | Nickname | Job | When it runs |
|---|---|---|---|
| **CoverageAgent** | *The Tester* | Clones your repo → explores code → writes missing tests → `npm test` until 100% pass → opens a GitHub PR | On demand: `npm run coverage-job` |
| **DailyCommitDigestAgent** | *Sentinel* | Clones your repo → reads commits → runs `npm audit` + secret scan → asks Gemini "is this safe?" → emails report to you + archives HTML | Daily at 10pm IST or `npm run digest` |

**Simple flow:**

```
Your GitHub Repo
      │
      ├─► [ PRism Tester ] ──► new branch + tests ──► GitHub Pull Request
      │
      └─► [ PRism Sentinel ] ──► security scan ──► Email to you (10 PM IST)
                                   + local report in ./reports/
```

**You’ll love PRism if you:**
- Forget to write tests and want coverage without nagging
- Want to know *what* changed, *who* did it, and *if it’s safe* — without reading 50 commits
- Care about leaked `AKIA…`, `ghp_…`, or `postgres://user:pass@` slipping into git

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

That’s it. The next step is just reading the email. ☕

---

## 🧩 The Two Agents — In Detail (But Still Human)

### 🛡️ Agent 1: Sentinel — Daily Digest & Security Audit

**Every night (or on demand) it does 8 steps so you don’t have to:**

1. `get_recent_commits` — pulls commits since `"24 hours ago"` (or your `--since`)
2. `get_commit_diff` — reads the actual code diffs
3. `run_security_audit` — regex scans added lines for secrets + runs `npm audit`
4. **Gemini analysis** — decides `🟢 CLEAN` / `🟡 WARNING` / `🔴 VULNERABLE` with file + line + fix
5. Categorizes changes → 🚀 Features / 🐛 Fixes / 🔒 Security / 🧹 Chores / 📝 Other
6. Summarizes **who did what** (commit counts per author)
7. `send_digest_email` — renders HTML + Markdown, saves to `reports/`, sends via Resend → SMTP → Ethereal
8. Prints a short executive summary to your terminal

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

1. `list_dir` + `read_file` — explores repo → reads `package.json`, source files
2. Finds untested modules (utils, hooks, business logic)
3. `write_file` — creates real tests (`*.test.ts` or `tests/`) — *no* `assert(true)` fakes
4. `run_command` — runs `npx vitest run` / `npm test` / `npx tsc --noEmit` until green (fixes failures itself)
5. `create_pr` — pushes `prism/coverage-<timestamp>` → opens PR with Markdown description

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

All knobs live in `src/config.ts` but you never edit it. Just set env vars.

### Essential vs. Optional

| You MUST set (to get value) | You CAN tweak (nice defaults) |
|---|---|
| `GEMINI_API_KEY` **or** Vertex (`GOOGLE_GENAI_USE_VERTEXAI`+`GOOGLE_CLOUD_PROJECT`) | `GEMINI_MODEL=gemini-2.5-flash` |
| `GITHUB_TOKEN` (for PRs / private clones) | `TARGET_REPO_BRANCH=main` |
| `TARGET_REPO_URL` (defaults to fluent demo) | `WORKSPACE_DIR=./workspace/fluent` |
| `ALERT_EMAIL_TO` (defaults to `divyanshukumar.dev@proton.me`) | `MAX_AGENT_TURNS=25` |
| Email: `SMTP_HOST`+`SMTP_USER` **or** `RESEND_API_KEY` (or archive-only is fine) | `DIGEST_CRON_SCHEDULE="0 22 * * *"` / `DIGEST_TIMEZONE="Asia/Kolkata"` |

### Full Reference Table

| Variable | Required? | Default | Purpose | Accepted values |
|----------|-----------|---------|---------|-----------------|
| `GOOGLE_GENAI_USE_VERTEXAI` | — | `false` | Vertex AI toggle | `true` / unset. Legacy: `GOOGLE_GENAI_USE_ENTERPRISE` |
| `GOOGLE_CLOUD_PROJECT` | Vertex only | — | GCP project id | Any project id. Fallbacks: `GCP_PROJECT`, `GCLOUD_PROJECT` |
| `GOOGLE_CLOUD_LOCATION` | — | `us-central1` | Vertex region | `us-central1`, `europe-west1` … |
| `GEMINI_API_KEY` | AI Studio mode | — | Google AI Studio key | `AIza…` (alias: `GOOGLE_API_KEY`) |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | Gemini model | `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-pro` |
| `MAX_AGENT_TURNS` | — | `25` | Max LLM↔tool loops | Any positive int |
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
| `DIGEST_CRON_SCHEDULE` | — | `0 22 * * *` | `node-cron` expr | 5-field cron (no seconds) |
| `DIGEST_TIMEZONE` | — | `Asia/Kolkata` | IANA tz | `Asia/Kolkata`, `UTC`, `America/New_York` … |

### Auth Priority (inside `createGenAIClient`)

```
1. Vertex AI ADC  (useEnterprise && project) → { enterprise:true, project, location }
2. API key       (GEMINI_API_KEY / GOOGLE_API_KEY) → { apiKey }
3. Vertex fallback (project only, even without flag)
4. Empty init    (SDK ADC discovery) — fails on first call if unauthenticated
```

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

# --- Dev / Checks ---
npm run typecheck                              # tsc --noEmit
npm run build                                  # tsc → dist/
```

---

## 🏗️ Architecture & Tech Stack

**Stack:** TypeScript · `@google/genai` (Gemini 2.5/2.0/1.5) · `node-cron` (Asia/Kolkata) · `nodemailer` + Resend · `zod` · `tsx`

**Project layout:**

```
PRism/
├── .env.example              # copy to .env — all tunables
├── package.json              # scripts: digest / schedule / coverage-job / interactive
├── tsconfig.json
├── reports/                  # auto-created — digest-*.html + digest-*.md
├── workspace/fluent/         # ephemeral clone (reset --hard every run)
└── src/
    ├── config.ts             # single typed config + createGenAIClient + parseGitHubRepoUrl
    ├── agent.ts              # CoverageAgent loop (explore → test → verify → PR)
    ├── digest_agent.ts       # Sentinel loop (commits → diff → audit → email)
    ├── digest_cli.ts         # `npm run digest` flag parsing + one-shot runner
    ├── scheduler.ts          # `npm run schedule` cron daemon + --run-now
    ├── index.ts              # `npm run coverage-job` / --focus / --interactive
    ├── services/mailer.ts    # HTML email (inline CSS) + Markdown + provider cascade
    └── tools/
        ├── index.ts          # two Gemini toolsets + dispatchers
        ├── repo.ts           # GitRepoManager (clone / reset / push)
        ├── file_ops.ts       # read_file / write_file / list_dir (sandboxed)
        ├── command_runner.ts # run_command (exec in workspace, 8k trunc)
        ├── git_digest.ts     # get_recent_commits / get_commit_diff / run_security_audit / send_digest_email
        └── github_pr.ts      # create_pr (git push --force + POST /pulls)
```

---

## 🧰 Tool Reference (What the AI Can Actually Do)

<details><summary><b>CoverageAgent tools</b> (Tester) — click to expand</summary>

| Tool | Key params | What it does |
|------|-----------|--------------|
| `list_dir` | `dirPath="."`, `recursive=true`, `maxDepth=5`, `extension?` | Sandboxed walk; hides `.git`/`node_modules`; capped at 150 entries (but `count` tells full total) |
| `read_file` | `filePath` (relative), `startLine?`, `endLine?` | UTF‑8 slice annotated `12: code`; detects directories |
| `write_file` | `filePath`, `content` | Overwrite with `mkdir -p` parent creation; returns `bytesWritten` |
| `run_command` | `command`, `timeoutMs=60000` | `exec` inside workspace (`CI=true`), 8 000-char trunc per stream, 10 MB buffer |
| `create_pr` | `title`, `body`, `branchName?`, `commitMessage?` | `git checkout -B` → `add -A` → `commit` → `push --force` → REST `POST /pulls` + attribution footer |

</details>

<details><summary><b>Sentinel tools</b> (Digest) — click to expand</summary>

| Tool | Key params | What it does |
|------|-----------|--------------|
| `get_recent_commits` | `since="24 hours ago"`, `maxCount=50`, `branch=targetBranch` | `git log --since` + per-commit `diff-tree --name-only`; empty window → fallback last 10, rewrites `timeWindow` |
| `get_commit_diff` | `commitHash?` / `fromHash+toHash` / `maxLines=500` | `git show` or `git diff from..to`; truncates at `maxLines` with sentinel |
| `run_security_audit` | `includeNpmAudit=true` | Regex secret scan over `git diff HEAD~5 HEAD` added lines (`+` only) + `npm audit --json` (parsed even on non-zero exit) |
| `send_digest_email` | `reportDate`, `timeWindow`, `securityVerdict`, `categorizedChanges`, `vulnerabilities`, `authors` … | Delegates to `MailerService`: render HTML/Markdown → archive → Resend→SMTP→Ethereal cascade |
| `read_file` / `list_dir` | (same as above) | Shared for repo exploration |

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

## ⚠️ Gotchas & Edge Cases (Read Once, Save Hours)

> All of these are already handled — you just need to know they exist.

<details><summary><b>Workspace & Git</b></summary>

- **Ephemeral workspace** — every `initWorkspace()` does `reset --hard origin/<branch>`. Manual edits in `workspace/` are intentionally wiped. Keep experiments elsewhere.
- **Shallow clone (`--depth 50`)** — `get_recent_commits --since 30d` on a busy repo may return fewer than expected. Increase depth in `src/tools/repo.ts` if long windows are critical.
- **Empty commit window** — not an error: falls back to latest **10 commits** and rewrites `timeWindow` to `Latest N commits (No commits in '…')`.
- **Token never logged** — only plain `repoUrl` is printed; PAT lives only in method locals (`getAuthenticatedUrl()`).

</details>

<details><summary><b>File Tools & Commands</b></summary>

- **Path traversal blocked** — `resolveWorkspacePath` throws if `../../etc/passwd` would escape the workspace.
- **`list_dir` ignores** `.git`, `node_modules`, `.next`, `dist`, `.turbo`, `build`, `.cache` at every depth.
- **Output caps** — `list_dir` slices at 150 entries (check `count` for full total), `run_command` truncates each stream at **8 000 chars** (`…[Output truncated]`), `get_commit_diff` caps at `maxLines=500`. Split large logs by narrowing the query.
- **`run_command` buffer** — 10 MB `maxBuffer`; redirect huge coverage logs to a file (`npx vitest run > out.txt`).

</details>

<details><summary><b>Security Audit</b></summary>

- **Secret scan window is 5 commits only** (`git diff HEAD~5 HEAD`). Older leaks beyond 5 commits but inside `--since` are invisible to the regex pass — the AI’s `get_commit_diff` visual loop is expected to catch them as `VULNERABLE`.
- **`npm audit`** is parsed via `.catch(e => e.stdout)` so vulnerabilities on non-zero exit are NOT swallowed.
- Snippet logging truncates at **100 chars** to avoid dumping secrets to `reports/` or email.

</details>

<details><summary><b>Scheduler</b></summary>

- Runs **inside Node** (`node-cron`), not system `crond`. If the process dies, the trigger dies — supervise with `pm2`, `systemd`, or Docker `restart: unless-stopped`.
- `cron.validate()` rejects **6-field** seconds-included expressions. `"0 0 22 * * *"` will throw at boot — use **5-field** `"0 22 * * *"`.
- `--run-now` fires **before** validation, so a bad cron string still lets the immediate digest succeed, but the daemon then exits `1`.
- Per-tick errors are **caught** — a failed Tuesday doesn’t kill Wednesday’s run.

</details>

<details><summary><b>LLM Loop</b></summary>

- `config.maxTurns` is the only infinite-loop guard. Budget accordingly (each turn = one Gemini call). Raise via `MAX_AGENT_TURNS` for big repos, lower for cost control.
- `history` grows without pruning — reuse an instance across many `chat()` calls only if you also call `agent.resetHistory()` (digest variant clears `cachedCommits` too).
- Tool results are truncated to 250 chars in your console but **full** (8 000-char) payload is sent back to the LLM.

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
| Email not received but console says `✔ Daily Digest Completed` | Provider failed, but archive succeeded | Check `reports/*.html` — that file IS the report. Then fix `SMTP_*` or add `RESEND_API_KEY` |
| `No commits in '30d'` but you expected many | Shallow clone hid them | Raise `--depth 50` in `src/tools/repo.ts` or use shorter `--since` |
| `Maximum turns limit without completion` | Repo too large or LLM stuck | Raise `MAX_AGENT_TURNS=40` or narrow with `--focus` |

---

## 📝 Useful Commands

```bash
npm run digest -- --help          # flags: --since / --to / --model
npm run digest -- --since 24h     # 24h shorthand → "24 hours ago"
npm run schedule -- --run-now     # instant + nightly 22:00
npm run coverage-job              # alias for coverage-agent full mission
npm run dev -- --focus "src/lib"  # Tester, focused
npm run interactive               # REPL chat
npm run typecheck                 # tsc --noEmit
npm run build                     # tsc → dist/
npm start                         # node dist/index.js (after build)
```

---

## 📚 In‑Place Code Documentation (Latest Advancement)

Every module under `src/` now carries comprehensive TSDoc file headers covering overview, key configs/params, usage examples, and edge-case tables — so your editor hover already documents the system. Highlights:

| Module | Header emphasis |
|--------|-----------------|
| `src/config.ts` | Full `AppConfig` field docs, `parseGitHubRepoUrl` contract, `createGenAIClient` cascade |
| `src/agent.ts` | 5‑step mission template, `RunMissionOptions` examples, `maxTurns` failure mode |
| `src/digest_agent.ts` | 8‑step Sentinel procedure, `cachedCommits` lifecycle, timezone validity |
| `src/tools/repo.ts` | Auth‑URL injection, `setupWorkspace` vs shallow clone, force‑push safety |
| `src/tools/file_ops.ts` | Traversal guard, slice annotation, ignore‑list, 150‑entry cap |
| `src/tools/command_runner.ts` | Timeout, 8 000‑char truncation, `CI=true`, maxBuffer |
| `src/tools/git_digest.ts` | 4‑tool matrix, fallback semantics, secret‑pattern catalog |
| `src/tools/github_pr.ts` | Branch naming, PAT setup, PR footer attribution |
| `src/tools/index.ts` | Two dispatchers, `cachedCommits` thread‑through, unknown‑tool recovery |
| `src/services/mailer.ts` | HTML section order, Markdown sibling, provider cascade, archive naming |
| `src/index.ts` / `src/digest_cli.ts` | Flag parsing tables, `customPrompt` vs `focusArea` precedence |
| `src/scheduler.ts` | Cron validation, `--run-now` boot ordering, daemon supervision |

Run `npx tsc --noEmit` (or `npm run typecheck`) to surface all TSDoc diagnostics. No `process.env` reads outside `config.ts` — add a field there instead.

---

## 📄 License

MIT — see [`LICENSE`](./LICENSE). Generated autonomously by PRism (`@google/genai`) and documented for human operators.
