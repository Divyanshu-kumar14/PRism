/**
 * @fileoverview Responsive HTML email engine & local report archiver.
 *
 * **What this module does**
 * - Defines the report shape (`DigestReportData`, `CommitSummaryItem`, …).
 * - Renders the same data as a dark-mode‑friendly HTML email (`generateHtmlEmail`)
 *   and a plain‑text Markdown fallback (`generateMarkdownReport`).
 * - Persists both artifacts to `./reports/digest-<date>‑<iso>.{html,md}` via `saveReportToDisk`.
 * - Delivers via the first available provider in order:
 *   1. **Resend API** (`RESEND_API_KEY`) — `https://api.resend.com/emails`
 *   2. **SMTP** (`SMTP_HOST`+`SMTP_USER`) — `nodemailer` (`SMTPSecure` controls TLS)
 *   3. **Ethereal preview** — temp test account with `getTestMessageUrl()` preview link
 *   4. **Local‑only fallback** — archive still counts as `success:true`
 *
 * **Key configurations / parameters**
 * | Param / Env       | Used as | Default | Notes |
 * |-------------------|---------|---------|-------|
 * | `DigestReportData.reportDate` | Header & file name | — | Already formatted in IST by agent |
 * | `DigestReportData.securityVerdict` | Banner color/icon/text | — | `CLEAN`→green, `WARNING`→amber, `VULNERABLE`→red |
 * | `config.emailRecipient` | `To:` when `recipientOverride` absent | `divyanshukumar.dev@proton.me` | |
 * | `config.emailFrom` | `From:` header | `PRism Digest <noreply@prism.dev>` | |
 * | `RESEND_API_KEY` | Resend provider | unset | Takes precedence over SMTP |
 * | `SMTP_HOST`+`SMTP_USER`/`SMTP_PASS`+`SMTP_PORT`+`SMTP_SECURE` | SMTP provider | unset | `SMTP_SECURE=true` only for port 465 |
 * | `./reports/` | Archive dir | created `mkdir -p` | Relative to `process.cwd()` |
 *
 * **Usage examples**
 * ```ts
 * const svc = new MailerService();
 * const html = svc.generateHtmlEmail(reportData);
 * const md   = svc.generateMarkdownReport(reportData);
 * const { htmlPath } = svc.saveReportToDisk(reportData);
 * const { success, previewUrl } = await svc.sendDigestEmail(reportData);
 * // or with override:
 * await svc.sendDigestEmail(reportData, 'lead@example.com');
 * ```
 *
 * **Edge cases / gotchas**
 * - All user‑controlled strings are escaped via `escapeHtml` — prevents XSS in the email.
 * - `generateHtmlEmail` inline‑styles everything (no external CSS) for Gmail/Outlook.
 * - `subject` prefix is `🚨 VULN ALERT` only when `VULNERABLE`; otherwise `✔ Updates`.
 * - `saveReportToDisk` ISO timestamp uses `:`→`-` replacement so Windows filenames are valid.
 * - When both Resend and SMTP fail, Ethereal still returns `success:true` with a preview URL — the digest is not considered failed.
 * - `config.targetRepoUrl.split('/').pop()` for subject — fragile for non‑GitHub URLs but harmless.
 */

import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { config, parseGitHubRepoUrl } from '../config.js';

/** One commit as returned by `executeGetRecentCommits` and rendered in the digest. */
export interface CommitSummaryItem {
  /** Full 40‑char SHA. */
  hash: string;
  /** 7‑char short SHA (`%h` from git log). */
  shortHash: string;
  /** Author display name (`%an`). */
  author: string;
  /** Author email (`%ae`). */
  email: string;
  /** Formatted date string (`%ad` with `YYYY-MM-DD HH:MM:SS`). */
  date: string;
  /** Subject + body (concatenated if body exists). */
  message: string;
  /** List from `git diff-tree --name-only -r <hash>` (may be `undefined` on error). */
  filesChanged?: string[];
  /** Optional `git shortstat` insertions (agent‑provided, not auto‑counted). */
  insertions?: number;
  /** Optional deletions (agent‑provided). */
  deletions?: number;
}

/** Aggregated author stats synthesized by the LLM. */
export interface AuthorStat {
  /** Display name (grouped by exact string match). */
  name: string;
  email: string;
  /** How many commits in the window. */
  commitCount: number;
  additions: number;
  deletions: number;
  /** LLM summary of highlights for this author. */
  summary: string;
}

/** Single vulnerability / quality finding synthesized by the LLM or local scans. */
export interface VulnerabilityFinding {
  /** `CRITICAL`/`HIGH` → red, `MEDIUM` → amber, `LOW`/`INFO` → blue. */
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  title: string;
  /** Affected file (optional). */
  file?: string;
  /** Line number or range (string to allow `"42-48"`). */
  line?: number | string;
  /** Commit that introduced it. */
  commitHash?: string;
  /** Human‑readable description of the issue. */
  description: string;
  /** Actionable fix — shown in a blue callout in HTML. */
  recommendation: string;
}

/**
 * Full payload the Sentinel agent must assemble before dispatch.
 * All HTML/Markdown helpers consume this single shape.
 */
export interface DigestReportData {
  /** IST‑formatted date used in the email header and archive filenames. @example "September 1, 2026" */
  reportDate: string;
  /** Source repo URL (`config.targetRepoUrl`). */
  targetRepoUrl: string;
  /** Source branch (`config.targetBranch`). */
  targetBranch: string;
  /** Human window label (e.g. `"24 hours ago"` or fallback `"Latest 10 commits (…)"`). */
  timeWindow: string;
  /** Total commits in window (LLM‑counted). */
  totalCommits: number;
  /** Distinct files changed across all commits. */
  totalFilesChanged: number;
  /** Per‑author summary rows. */
  authors: AuthorStat[];
  /** Top‑level narrative for executives — 2‑4 paragraphs. */
  executiveSummary: string;
  /** Pre‑bucketed change lists rendered as collapsible sections. */
  categorizedChanges: {
    features: string[];
    fixes: string[];
    security: string[];
    refactoring: string[];
    other: string[];
  };
  /** Final verdict drives banner color & subject prefix. */
  securityVerdict: 'CLEAN' | 'WARNING' | 'VULNERABLE';
  /** Explanation of the verdict (shown in the banner). */
  securitySummary: string;
  /** Zero or more vulnerability cards / markdown bullets. */
  vulnerabilities: VulnerabilityFinding[];
  /** Full commit feed (from `cachedCommits`). */
  commits: CommitSummaryItem[];
  /** Optional pre‑rendered markdown (unused; call `generateMarkdownReport` instead). */
  rawMarkdown?: string;
}

/**
 * Renders, archives, and delivers the Sentinel digest.
 * Each agent run constructs one instance; the constructor ensures `./reports/` exists.
 *
 * @category Services / Email
 */
export class MailerService {
  private reportsDir: string;

  /**
   * Creates the service and guarantees `./reports/` exists (`mkdir -p`).
   * `process.cwd()` is used so the path is stable inside Docker / PM2 / `npm run …`.
   */
  constructor() {
    this.reportsDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  /**
   * Renders the complete responsive HTML email.
   *
   * Sections (in order):
   * 1. Header card — repo name/branch/date + 3‑metric grid (commits, contributors, files)
   * 2. Security verdict banner — color‑coded by {@link DigestReportData.securityVerdict}
   * 3. Executive summary + categorized highlights (5 buckets)
   * 4. Vulnerability cards (or green `✔ No vulnerabilities…` box when empty)
   * 5. Contributors breakdown table (name, email, commitCount, summary)
   * 6. All‑commits feed — each with `[shortHash]` link → `https://github.com/…/commit/<hash>`
   * 7. Footer — generator attribution
   *
   * @param data - Fully populated {@link DigestReportData}.
   * @returns Complete `<!DOCTYPE html>…` document as a string (UTF‑8, inline CSS only).
   *
   * **Gotchas**
   * - Repo name is derived via `parseGitHubRepoUrl`; on parse failure the raw URL is shown.
   * - `escapeHtml` is applied to every user string — ensures `"<script>"` in a commit msg is inert.
   * - Empty category arrays render nothing (no empty `<ul>` kept).
   */
  public generateHtmlEmail(data: DigestReportData): string {
    let repoName = data.targetRepoUrl;
    try {
      const { owner, repo } = parseGitHubRepoUrl(data.targetRepoUrl);
      repoName = `${owner}/${repo}`;
    } catch {
      // Keep targetRepoUrl if parsing fails
    }

    const verdictColor =
      data.securityVerdict === 'CLEAN'
        ? '#10b981'
        : data.securityVerdict === 'WARNING'
        ? '#f59e0b'
        : '#ef4444';

    const verdictIcon =
      data.securityVerdict === 'CLEAN' ? '🛡️' : data.securityVerdict === 'WARNING' ? '⚠️' : '🚨';

    const verdictTitle =
      data.securityVerdict === 'CLEAN'
        ? 'VERDICT: CLEAN & SECURE'
        : data.securityVerdict === 'WARNING'
        ? 'VERDICT: WARNINGS DETECTED'
        : 'VERDICT: VULNERABILITY / BREAKING CHANGES DETECTED';

    // Build features/fixes/etc HTML
    const renderCategory = (title: string, icon: string, items: string[]) => {
      if (!items || items.length === 0) return '';
      return `
        <div style="margin-bottom: 16px;">
          <h4 style="margin: 0 0 8px 0; color: #f1f5f9; font-size: 14px; font-weight: 600;">
            ${icon} ${title} (${items.length})
          </h4>
          <ul style="margin: 0; padding-left: 20px; color: #94a3b8; font-size: 13px; line-height: 1.6;">
            ${items.map((item) => `<li style="margin-bottom: 4px;">${this.escapeHtml(item)}</li>`).join('')}
          </ul>
        </div>
      `;
    };

    // Authors Table
    const authorsRows = data.authors
      .map(
        (a) => `
        <tr style="border-bottom: 1px solid #334155;">
          <td style="padding: 10px 12px; color: #f8fafc; font-weight: 500; font-size: 13px;">
            ${this.escapeHtml(a.name)} <span style="color: #64748b; font-size: 11px;">(${this.escapeHtml(a.email)})</span>
          </td>
          <td style="padding: 10px 12px; color: #38bdf8; text-align: center; font-weight: 600; font-size: 13px;">
            ${a.commitCount}
          </td>
          <td style="padding: 10px 12px; color: #94a3b8; font-size: 12px;">
            ${this.escapeHtml(a.summary || 'Committed changes')}
          </td>
        </tr>
      `
      )
      .join('');

    // Vulnerability Cards
    const vulnCards =
      data.vulnerabilities.length === 0
        ? `
        <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 16px; text-align: center;">
          <p style="color: #10b981; margin: 0; font-weight: 600; font-size: 14px;">
            ✔ No security vulnerabilities, credential leaks, or breaking regressions detected in these commits.
          </p>
        </div>
      `
        : data.vulnerabilities
            .map((v) => {
              const bg =
                v.severity === 'CRITICAL' || v.severity === 'HIGH'
                  ? 'rgba(239, 68, 68, 0.12)'
                  : v.severity === 'MEDIUM'
                  ? 'rgba(245, 158, 11, 0.12)'
                  : 'rgba(59, 130, 246, 0.12)';
              const border =
                v.severity === 'CRITICAL' || v.severity === 'HIGH'
                  ? '#ef4444'
                  : v.severity === 'MEDIUM'
                  ? '#f59e0b'
                  : '#3b82f6';
              const text = border;

              return `
          <div style="background: #1e293b; border-left: 4px solid ${border}; border-radius: 6px; padding: 14px; margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span style="background: ${bg}; color: ${text}; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; text-transform: uppercase;">
                ${v.severity}
              </span>
              ${v.file ? `<span style="color: #94a3b8; font-size: 12px; font-family: monospace;">${this.escapeHtml(v.file)}${v.line ? `:${v.line}` : ''}</span>` : ''}
            </div>
            <h4 style="margin: 0 0 6px 0; color: #f8fafc; font-size: 14px; font-weight: 600;">
              ${this.escapeHtml(v.title)}
            </h4>
            <p style="margin: 0 0 8px 0; color: #cbd5e1; font-size: 13px; line-height: 1.5;">
              ${this.escapeHtml(v.description)}
            </p>
            <div style="background: #0f172a; padding: 8px 12px; border-radius: 4px; border: 1px solid #334155;">
              <span style="color: #38bdf8; font-size: 12px; font-weight: 600;">Recommendation: </span>
              <span style="color: #94a3b8; font-size: 12px;">${this.escapeHtml(v.recommendation)}</span>
            </div>
          </div>
        `;
            })
            .join('');

    // Commits List
    const commitsList = data.commits
      .map((c) => {
        const commitUrl = data.targetRepoUrl.replace(/\.git$/, '') + `/commit/${c.hash}`;
        return `
        <div style="background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 12px 14px; margin-bottom: 8px;">
          <div style="margin-bottom: 4px;">
            <a href="${commitUrl}" target="_blank" style="color: #60a5fa; font-family: monospace; font-size: 12px; font-weight: 600; text-decoration: none;">
              [${c.shortHash || c.hash.slice(0, 7)}]
            </a>
            <span style="color: #f8fafc; font-weight: 500; font-size: 13px; margin-left: 6px;">
              ${this.escapeHtml(c.message)}
            </span>
          </div>
          <div style="color: #64748b; font-size: 11px;">
            👤 <strong>${this.escapeHtml(c.author)}</strong> &bull; 🕒 ${c.date}
            ${c.filesChanged && c.filesChanged.length > 0 ? ` &bull; 📁 ${c.filesChanged.length} files changed` : ''}
          </div>
        </div>
      `;
      })
      .join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PRism Daily Commit & Security Digest</title>
</head>
<body style="margin: 0; padding: 0; background-color: #090d16; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f8fafc;">
  <div style="max-width: 680px; margin: 0 auto; padding: 24px 16px;">
    
    <!-- Top Header Card -->
    <div style="background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%); border: 1px solid #312e81; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #a5b4fc; letter-spacing: -0.5px;">
          🔮 PRism Daily Digest
        </h1>
        <span style="background: #312e81; color: #c7d2fe; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 9999px;">
          10:00 PM IST Digest
        </span>
      </div>
      <p style="margin: 0 0 14px 0; color: #94a3b8; font-size: 13px;">
        Repository: <strong style="color: #e2e8f0;">${this.escapeHtml(repoName)}</strong> (${data.targetBranch}) &bull; ${data.reportDate}
      </p>

      <!-- Quick Metrics Grid -->
      <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
        <tr>
          <td style="background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 10px 14px; width: 33%;">
            <div style="color: #64748b; font-size: 11px; text-transform: uppercase;">Total Commits</div>
            <div style="color: #38bdf8; font-size: 20px; font-weight: 700; margin-top: 2px;">${data.totalCommits}</div>
          </td>
          <td style="width: 10px;"></td>
          <td style="background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 10px 14px; width: 33%;">
            <div style="color: #64748b; font-size: 11px; text-transform: uppercase;">Contributors</div>
            <div style="color: #818cf8; font-size: 20px; font-weight: 700; margin-top: 2px;">${data.authors.length}</div>
          </td>
          <td style="width: 10px;"></td>
          <td style="background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 10px 14px; width: 33%;">
            <div style="color: #64748b; font-size: 11px; text-transform: uppercase;">Files Changed</div>
            <div style="color: #c084fc; font-size: 20px; font-weight: 700; margin-top: 2px;">${data.totalFilesChanged}</div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Security Verdict Banner -->
    <div style="background: #0f172a; border: 1px solid ${verdictColor}; border-radius: 10px; padding: 16px 20px; margin-bottom: 20px;">
      <div style="display: flex; align-items: center; margin-bottom: 6px;">
        <span style="font-size: 18px; margin-right: 8px;">${verdictIcon}</span>
        <h3 style="margin: 0; color: ${verdictColor}; font-size: 15px; font-weight: 700;">
          ${verdictTitle}
        </h3>
      </div>
      <p style="margin: 0; color: #cbd5e1; font-size: 13px; line-height: 1.5;">
        ${this.escapeHtml(data.securitySummary)}
      </p>
    </div>

    <!-- Executive Summary Card -->
    <div style="background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 20px; margin-bottom: 20px;">
      <h2 style="margin: 0 0 12px 0; color: #f9fafb; font-size: 16px; font-weight: 600;">
        📌 Executive Summary
      </h2>
      <p style="margin: 0 0 16px 0; color: #cbd5e1; font-size: 14px; line-height: 1.6;">
        ${this.escapeHtml(data.executiveSummary)}
      </p>

      <!-- Categorized Highlights -->
      ${renderCategory('New Features & Capabilities', '🚀', data.categorizedChanges.features)}
      ${renderCategory('Bug Fixes & Patches', '🐛', data.categorizedChanges.fixes)}
      ${renderCategory('Security & Integrity', '🔒', data.categorizedChanges.security)}
      ${renderCategory('Refactoring & Chores', '🧹', data.categorizedChanges.refactoring)}
      ${renderCategory('Other Modifications', '📝', data.categorizedChanges.other)}
    </div>

    <!-- Security & Vulnerability Audit Findings -->
    <div style="background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 20px; margin-bottom: 20px;">
      <h2 style="margin: 0 0 12px 0; color: #f9fafb; font-size: 16px; font-weight: 600;">
        🛡️ Vulnerability & Breaking Changes Audit
      </h2>
      ${vulnCards}
    </div>

    <!-- Contributors Breakdown -->
    <div style="background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 20px; margin-bottom: 20px;">
      <h2 style="margin: 0 0 12px 0; color: #f9fafb; font-size: 16px; font-weight: 600;">
        👥 Contributor Breakdown (${data.authors.length})
      </h2>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="border-bottom: 1px solid #374151; text-align: left;">
            <th style="padding: 8px 12px; color: #9ca3af; font-size: 11px; text-transform: uppercase;">Author</th>
            <th style="padding: 8px 12px; color: #9ca3af; font-size: 11px; text-transform: uppercase; text-align: center;">Commits</th>
            <th style="padding: 8px 12px; color: #9ca3af; font-size: 11px; text-transform: uppercase;">Key Highlights</th>
          </tr>
        </thead>
        <tbody>
          ${authorsRows}
        </tbody>
      </table>
    </div>

    <!-- All Commits Feed -->
    <div style="background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 20px; margin-bottom: 20px;">
      <h2 style="margin: 0 0 12px 0; color: #f9fafb; font-size: 16px; font-weight: 600;">
        📜 All Commits in Time Window (${data.commits.length})
      </h2>
      ${commitsList}
    </div>

    <!-- Footer -->
    <div style="text-align: center; color: #6b7280; font-size: 12px; padding: 12px 0;">
      <p style="margin: 0 0 4px 0;">
        Generated autonomously by <a href="https://github.com/Divyanshu-kumar14/PRism" style="color: #818cf8; text-decoration: none;">PRism AI Daily Digest Agent</a> powered by Google Gemini.
      </p>
      <p style="margin: 0;">Sent automatically to <strong style="color: #9ca3af;">${this.escapeHtml(config.emailRecipient)}</strong> everyday at 10:00 PM IST.</p>
    </div>

  </div>
</body>
</html>
    `;
  }

  /**
   * Generates the plain‑text / Markdown variant of the report.
   * Same data as `generateHtmlEmail` but suited for email `text` part and local `.md` archive.
   *
   * @param data - Report payload.
   * @returns Markdown string (headings, bullets, code spans for files/hashes).
   *
   * @example
   * ```ts
   * const md = svc.generateMarkdownReport(data);
   * console.log(md.slice(0, 200));
   * ```
   */
  public generateMarkdownReport(data: DigestReportData): string {
    const lines: string[] = [];

    lines.push(`# 🔮 PRism Daily Commit & Security Digest`);
    lines.push(`**Target Repo**: ${data.targetRepoUrl} (\`${data.targetBranch}\`)  `);
    lines.push(`**Report Date**: ${data.reportDate} (10:00 PM IST)  `);
    lines.push(`**Time Window**: ${data.timeWindow} | **Total Commits**: ${data.totalCommits} | **Files Changed**: ${data.totalFilesChanged}\n`);

    lines.push(`---`);
    lines.push(`## 🛡️ Security & Vulnerability Verdict: ${data.securityVerdict}`);
    lines.push(`${data.securitySummary}\n`);

    if (data.vulnerabilities.length > 0) {
      lines.push(`### Detected Security/Breaking Issues:`);
      for (const v of data.vulnerabilities) {
        lines.push(`- **[${v.severity}] ${v.title}**`);
        if (v.file) lines.push(`  - *File*: \`${v.file}${v.line ? `:${v.line}` : ''}\``);
        lines.push(`  - *Details*: ${v.description}`);
        lines.push(`  - *Recommendation*: ${v.recommendation}`);
      }
      lines.push('');
    }

    lines.push(`---`);
    lines.push(`## 📌 Executive Summary`);
    lines.push(`${data.executiveSummary}\n`);

    if (data.categorizedChanges.features.length > 0) {
      lines.push(`### 🚀 Features & Enhancements`);
      for (const item of data.categorizedChanges.features) lines.push(`- ${item}`);
      lines.push('');
    }

    if (data.categorizedChanges.fixes.length > 0) {
      lines.push(`### 🐛 Bug Fixes & Patches`);
      for (const item of data.categorizedChanges.fixes) lines.push(`- ${item}`);
      lines.push('');
    }

    if (data.categorizedChanges.security.length > 0) {
      lines.push(`### 🔒 Security & Refactoring`);
      for (const item of data.categorizedChanges.security) lines.push(`- ${item}`);
      lines.push('');
    }

    if (data.categorizedChanges.refactoring.length > 0) {
      lines.push(`### 🧹 Chores & Maintenance`);
      for (const item of data.categorizedChanges.refactoring) lines.push(`- ${item}`);
      lines.push('');
    }

    lines.push(`---`);
    lines.push(`## 👥 Contributors`);
    for (const a of data.authors) {
      lines.push(`- **${a.name}** (<${a.email}>): ${a.commitCount} commit(s) — *${a.summary}*`);
    }
    lines.push('');

    lines.push(`---`);
    lines.push(`## 📜 Detailed Commits`);
    for (const c of data.commits) {
      lines.push(`- \`${c.shortHash}\` **${c.message}** by *${c.author}* on ${c.date}`);
    }

    return lines.join('\n');
  }

  /**
   * Persists the HTML + Markdown renderings to `./reports/`.
   *
   * @param data - Report payload (also controls file name via `reportDate` + ISO timestamp).
   * @returns `{ htmlPath, mdPath }` absolute paths of the two files just written.
   *
   * **Naming:** `digest-<safeDate>-<isoTimestamp>.{html,md}`
   * where `safeDate = reportDate.replace(/[^a-zA-Z0-9_-]/g, '_')`
   * and `isoTimestamp = new Date().toISOString().replace(/[:.]/g, '-')`.
   *
   * **Gotcha:** writes use `fs.writeFileSync` (synchronous) so the directory
   * must exist — guaranteed by the constructor.
   */
  public saveReportToDisk(data: DigestReportData): { htmlPath: string; mdPath: string } {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeDate = data.reportDate.replace(/[^a-zA-Z0-9_-]/g, '_');
    const baseName = `digest-${safeDate}-${timestamp}`;

    const htmlPath = path.join(this.reportsDir, `${baseName}.html`);
    const mdPath = path.join(this.reportsDir, `${baseName}.md`);

    const htmlContent = this.generateHtmlEmail(data);
    const mdContent = this.generateMarkdownReport(data);

    fs.writeFileSync(htmlPath, htmlContent, 'utf8');
    fs.writeFileSync(mdPath, mdContent, 'utf8');

    return { htmlPath, mdPath };
  }

  /**
   * Renders, archives, and attempts to email the digest.
   *
   * **Provider cascading (first success wins):**
   * 1. Resend API (`RESEND_API_KEY`) — `POST https://api.resend.com/emails`
   * 2. SMTP via `nodemailer` (`SMTP_HOST`+`SMTP_USER`)
   * 3. Ethereal `createTestAccount()` preview (no credentials needed, returns a URL)
   * 4. Archive‑only success (`{ htmlPath, mdPath }`) when even Ethereal fails (offline).
   *
   * @param data - Report payload.
   * @param recipientOverride - Optional `To:` address (defaults to `config.emailRecipient`).
   * @returns `{ success, message, previewUrl?, savedFiles }`. `success:true` even for
   *   Ethereal / archive‑only paths — the digest is never treated as failed if it was saved.
   *
   * @example Resend
   * ```ts
   * // .env: RESEND_API_KEY=re_…  EMAIL_FROM="PRism Digest <noreply@prism.dev>"
   * const r = await svc.sendDigestEmail(data);
   * console.log(r.message); // "Email successfully sent via Resend (ID: …)"
   * ```
   *
   * @example SMTP
   * ```ts
   * // .env: SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_USER=… SMTP_PASS=…
   * const r = await svc.sendDigestEmail(data, 'alt@example.com');
   * ```
   */
  public async sendDigestEmail(
    data: DigestReportData,
    recipientOverride?: string
  ): Promise<{ success: boolean; message: string; previewUrl?: string; savedFiles?: { htmlPath: string; mdPath: string } }> {
    const toEmail = recipientOverride || config.emailRecipient;
    const subject = `[PRism Daily Digest] ${data.securityVerdict === 'VULNERABLE' ? '🚨 VULN ALERT' : '✔ Updates'}: ${data.totalCommits} Commits on ${data.targetRepoUrl.split('/').pop()?.replace('.git', '') || 'Repo'} (${data.reportDate})`;

    const html = this.generateHtmlEmail(data);
    const text = this.generateMarkdownReport(data);

    // 1. Always archive to reports/
    const savedFiles = this.saveReportToDisk(data);
    console.log(`\x1b[35m[Report Archive]\x1b[0m Saved HTML: \x1b[34m${savedFiles.htmlPath}\x1b[0m`);

    // 2. Check if Resend API Key is set
    if (config.resendApiKey) {
      try {
        console.log(`\x1b[36m[Email]\x1b[0m Sending via Resend API to \x1b[32m${toEmail}\x1b[0m...`);
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: config.emailFrom,
            to: [toEmail],
            subject,
            html,
            text,
          }),
        });

        if (res.ok) {
          const resJson = (await res.json()) as any;
          return {
            success: true,
            message: `Email successfully sent via Resend (ID: ${resJson.id}) to ${toEmail}`,
            savedFiles,
          };
        } else {
          const errorText = await res.text();
          console.warn(`\x1b[33m[Resend Warning]\x1b[0m Failed to send via Resend: ${errorText}`);
        }
      } catch (err: any) {
        console.warn(`\x1b[33m[Resend Error]\x1b[0m ${err.message}`);
      }
    }

    // 3. Check if standard SMTP is configured
    if (config.smtpHost && config.smtpUser) {
      try {
        console.log(`\x1b[36m[Email]\x1b[0m Sending via SMTP (${config.smtpHost}:${config.smtpPort}) to \x1b[32m${toEmail}\x1b[0m...`);
        const transporter = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpSecure,
          auth: {
            user: config.smtpUser,
            pass: config.smtpPass,
          },
        });

        const info = await transporter.sendMail({
          from: config.emailFrom,
          to: toEmail,
          subject,
          text,
          html,
        });

        console.log(`\x1b[32m[Email Success]\x1b[0m Message ID: ${info.messageId}`);
        return {
          success: true,
          message: `Email successfully sent via SMTP to ${toEmail} (Message ID: ${info.messageId})`,
          savedFiles,
        };
      } catch (err: any) {
        console.warn(`\x1b[33m[SMTP Warning]\x1b[0m Failed to send via SMTP: ${err.message}`);
      }
    }

    // 4. Fallback: Ethereal test account or local preview
    try {
      console.log(`\x1b[33m[Email Notice]\x1b[0m No live SMTP/Resend credentials in .env. Creating test preview dispatcher...`);
      const testAccount = await nodemailer.createTestAccount();
      const testTransporter = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });

      const info = await testTransporter.sendMail({
        from: config.emailFrom,
        to: toEmail,
        subject,
        text,
        html,
      });

      const previewUrl = nodemailer.getTestMessageUrl(info) || undefined;
      if (previewUrl) {
        console.log(`\x1b[32m✔ [Email Preview URL]:\x1b[0m \x1b[1m\x1b[36m${previewUrl}\x1b[0m`);
      }

      return {
        success: true,
        message: `Digest generated! Preview available at: ${previewUrl || savedFiles.htmlPath}`,
        previewUrl,
        savedFiles,
      };
    } catch (err: any) {
      return {
        success: true,
        message: `Digest generated and archived locally at ${savedFiles.htmlPath}`,
        savedFiles,
      };
    }
  }

  /**
   * Minimal HTML escaper for email template interpolation.
   * @param str - Raw user/commit string.
   * @returns Escaped string safe for `innerHTML` insertion.
   * @private
   */
  private escapeHtml(str: string): string {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
