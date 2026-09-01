/**
 * @fileoverview Central configuration & Google GenAI client factory for PRism.
 *
 * **What this module does**
 * - Loads environment variables from `.env` (via `dotenv`).
 * - Exposes a single typed `config` object that every agent, tool, and service
 *   consumes — no ad-hoc `process.env` reads elsewhere.
 * - Provides `parseGitHubRepoUrl()` and `createGenAIClient()` helpers that
 *   encapsulate URL parsing and the Vertex AI ↔ AI Studio auth switch.
 *
 * @example
 * ```ts
 * import { config, createGenAIClient } from './config.js';
 *
 * console.log(config.targetRepoUrl); // https://github.com/Divyanshu-kumar14/fluent.git
 * console.log(config.cronSchedule);  // "0 22 * * *"
 * const ai = createGenAIClient();    // auto-picks Vertex ADC or API key
 * ```
 *
 * @see {@link AppConfig} for the full list of supported env vars.
 * @see {@link https://github.com/googleapis/js-genai | @google/genai docs}
 */

import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

// Load `.env` on import so every downstream module sees populated `process.env`.
// Safe to call multiple times — subsequent calls are no-ops.
dotenv.config();

/**
 * Strongly-typed application configuration.
 *
 * All fields are populated from environment variables with sensible defaults.
 * Never read `process.env` directly outside this file — add a field here instead.
 *
 * @category Configuration
 */
export interface AppConfig {
  /**
   * `true` when Vertex AI (enterprise) auth should be used.
   * Requires `GOOGLE_GENAI_USE_VERTEXAI=true` (or the legacy
   * `GOOGLE_GENAI_USE_ENTERPRISE=true`) **and** a GCP project id.
   * When `false` the SDK falls back to API-key auth.
   * @defaultValue `false`
   * @env `GOOGLE_GENAI_USE_VERTEXAI` | `GOOGLE_GENAI_USE_ENTERPRISE`
   */
  useEnterprise: boolean;

  /**
   * GCP project id for Vertex AI.
   * Aliases: `GOOGLE_CLOUD_PROJECT` → `GCP_PROJECT` → `GCLOUD_PROJECT` (first wins).
   * @env `GOOGLE_CLOUD_PROJECT`
   * @example "prism-demo-project-10492"
   */
  project?: string;

  /**
   * GCP region for Vertex AI.
   * @defaultValue "us-central1"
   * @env `GOOGLE_CLOUD_LOCATION`
   */
  location: string;

  /**
   * Gemini model id sent to `generateContent`.
   * @defaultValue "gemini-2.5-flash"
   * @env `GEMINI_MODEL`
   * @example "gemini-2.5-flash" | "gemini-2.0-flash" | "gemini-1.5-pro"
   */
  model: string;

  /**
   * GitHub PAT (classic or fine-grained, `repo` scope).
   * Aliases: `GITHUB_TOKEN` → `GH_TOKEN`.
   * Empty string means unauthenticated clone / no PR creation.
   * @env `GITHUB_TOKEN`
   */
  githubToken: string;

  /**
   * HTTPS clone URL of the repository under analysis.
   * @defaultValue "https://github.com/Divyanshu-kumar14/fluent.git"
   * @env `TARGET_REPO_URL`
   */
  targetRepoUrl: string;

  /**
   * Default branch to clone, diff, and target for PRs.
   * @defaultValue "main"
   * @env `TARGET_REPO_BRANCH`
   */
  targetBranch: string;

  /**
   * Local directory where the target repo is cloned.
   * Resolved to an absolute path by {@link GitRepoManager}.
   * @defaultValue "./workspace/fluent"
   * @env `WORKSPACE_DIR`
   */
  workspaceDir: string;

  /**
   * Maximum LLM ↔ tool round-trips per mission.
   * Prevents infinite loops; covers both {@link CoverageAgent} and {@link DailyCommitDigestAgent}.
   * @defaultValue 25
   * @env `MAX_AGENT_TURNS`
   */
  maxTurns: number;

  // ── Email & Alert ────────────────────────────────────────────────

  /**
   * Destination address for daily digest emails.
   * Aliases: `ALERT_EMAIL_TO` → `EMAIL_TO`.
   * @defaultValue "divyanshukumar.dev@proton.me"
   * @env `ALERT_EMAIL_TO`
   */
  emailRecipient: string;

  /**
   * `From:` header for outgoing mail.
   * @defaultValue "PRism Digest <noreply@prism.dev>"
   * @env `EMAIL_FROM`
   */
  emailFrom: string;

  /** SMTP hostname (e.g. `smtp.gmail.com`). Omit to skip SMTP. @env `SMTP_HOST` */
  smtpHost?: string;

  /**
   * SMTP port.
   * @defaultValue 587
   * @env `SMTP_PORT`
   */
  smtpPort: number;

  /** SMTP username (full email). @env `SMTP_USER` */
  smtpUser?: string;

  /** SMTP password / app-password. @env `SMTP_PASS` */
  smtpPass?: string;

  /**
   * Whether to use implicit TLS. For port 587 use `false` (STARTTLS);
   * for 465 use `true`.
   * @defaultValue `false` unless `SMTP_SECURE=true`
   * @env `SMTP_SECURE`
   */
  smtpSecure: boolean;

  /**
   * Resend.com API key — preferred over SMTP when set.
   * Falls back to SMTP → Ethereal preview → local archive.
   * @env `RESEND_API_KEY`
   */
  resendApiKey?: string;

  // ── Scheduling ───────────────────────────────────────────────────

  /**
   * Cron expression for the daily digest daemon.
   * Uses `node-cron` syntax (5 or 6 fields).
   * @defaultValue "0 22 * * *` (daily 22:00)
   * @env `DIGEST_CRON_SCHEDULE`
   * @example "0 22 * * *" — every day at 22:00
   * @example "0 9 * * 1"  — every Monday at 09:00
   */
  cronSchedule: string;

  /**
   * IANA timezone for {@link cronSchedule} evaluation.
   * Must be a valid `Intl` timezone.
   * @defaultValue "Asia/Kolkata" (IST)
   * @env `DIGEST_TIMEZONE`
   * @see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
   */
  cronTimezone: string;
}

/**
 * Global singleton config — import this instead of reading `process.env` directly.
 *
 * **Key env-var aliases / fallbacks**
 * | Field            | Lookup order                                      |
 * |------------------|---------------------------------------------------|
 * | `project`        | `GOOGLE_CLOUD_PROJECT` → `GCP_PROJECT` → `GCLOUD_PROJECT` |
 * | `githubToken`    | `GITHUB_TOKEN` → `GH_TOKEN`                       |
 * | `emailRecipient` | `ALERT_EMAIL_TO` → `EMAIL_TO`                     |
 * | `apiKey` (factory) | `GEMINI_API_KEY` → `GOOGLE_API_KEY`           |
 *
 * **Gotchas**
 * - `MAX_AGENT_TURNS` is parsed with `parseInt(..., 10)` — non-numeric values
 *   silently become `NaN` (agent loops guard against it, but validate in CI).
 * - `SMTP_SECURE` is strictly `=== 'true'`; any other truthy string is `false`.
 * - `WORKSPACE_DIR` is stored as-is; conversion to an absolute path happens in
 *   {@link GitRepoManager} via `path.resolve()`.
 *
 * @example
 * ```ts
 * import { config } from './config.js';
 * if (!config.githubToken) console.warn('PR creation will fail — set GITHUB_TOKEN');
 * ```
 */
export const config: AppConfig = {
  useEnterprise: (process.env.GOOGLE_GENAI_USE_ENTERPRISE === 'true' || process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') && !!(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT),
  project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  targetRepoUrl: process.env.TARGET_REPO_URL || 'https://github.com/Divyanshu-kumar14/fluent.git',
  targetBranch: process.env.TARGET_REPO_BRANCH || 'main',
  workspaceDir: process.env.WORKSPACE_DIR || './workspace/fluent',
  maxTurns: parseInt(process.env.MAX_AGENT_TURNS || '25', 10),

  // Email settings (defaults to divyanshukumar.dev@proton.me as requested)
  emailRecipient: process.env.ALERT_EMAIL_TO || process.env.EMAIL_TO || 'divyanshukumar.dev@proton.me',
  emailFrom: process.env.EMAIL_FROM || 'PRism Digest <noreply@prism.dev>',
  smtpHost: process.env.SMTP_HOST,
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  smtpSecure: process.env.SMTP_SECURE === 'true',
  resendApiKey: process.env.RESEND_API_KEY,

  // Schedule settings (defaults to 10:00 PM IST every day)
  cronSchedule: process.env.DIGEST_CRON_SCHEDULE || '0 22 * * *',
  cronTimezone: process.env.DIGEST_TIMEZONE || 'Asia/Kolkata',
};

/**
 * Extracts `{ owner, repo }` from a GitHub URL.
 *
 * Supports:
 * - `https://github.com/owner/repo`
 * - `https://github.com/owner/repo.git`
 * - `git@github.com:owner/repo.git` (SSH shorthand via `:` separator)
 * - Case-insensitive host, optional trailing `.git`
 *
 * @param url - Full GitHub URL (HTTPS or SSH-style).
 * @returns Parsed owner and repo name (without `.git`).
 * @throws {Error} If the URL does not look like a GitHub repo URL.
 *
 * @example
 * ```ts
 * parseGitHubRepoUrl('https://github.com/Divyanshu-kumar14/fluent.git')
 * // → { owner: 'Divyanshu-kumar14', repo: 'fluent' }
 *
 * parseGitHubRepoUrl('git@github.com:my-org/my-repo')
 * // → { owner: 'my-org', repo: 'my-repo' }
 * ```
 *
 * **Edge cases / gotchas**
 * - Trailing slash is **not** accepted (`…/repo/` throws).
 * - Repo names with dots (e.g. `my.repo`) — only the final `.git` is stripped;
 *   interior dots are preserved (`my.repo` not `my`).
 * - No validation that the repo actually exists — only syntax.
 */
// Perf: O(1) memoization for repo URL parsing — called on every email subject, PR creation, and header render
// Map keyed by raw URL, value is parsed {owner, repo}. Avoids repeated regex exec (agents parse same URL 5-10 times per mission)
const parsedRepoCache = new Map<string, { owner: string; repo: string }>();

export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } {
  const cached = parsedRepoCache.get(url);
  if (cached) return cached; // O(1) hit

  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!match) {
    throw new Error(`Invalid GitHub repository URL: ${url}`);
  }
  const result = {
    owner: match[1],
    repo: match[2],
  };
  // Bounded memo — keep last 20 URLs (covers TARGET_REPO_URL + any test overrides)
  parsedRepoCache.set(url, result);
  if (parsedRepoCache.size > 20) {
    const first = parsedRepoCache.keys().next().value as string;
    parsedRepoCache.delete(first);
  }
  return result;
}

/**
 * Creates a {@link GoogleGenAI} client using the best available auth method.
 *
 * **Priority (first match wins):**
 * 1. **Vertex AI ADC** — if `useEnterprise && project` → `{ enterprise: true, project, location }`
 *    (requires `gcloud auth application-default login`)
 * 2. **API key** — if `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set → `{ apiKey }`
 * 3. **Vertex fallback** — if `project` exists without the feature flag → enterprise mode
 * 4. **Empty init** — `new GoogleGenAI({})` — relies on SDK defaults / ADC discovery
 *
 * @returns Configured `GoogleGenAI` instance ready for `models.generateContent`.
 *
 * @example Vertex AI (recommended for GCP workloads)
 * ```ts
 * // .env: GOOGLE_GENAI_USE_VERTEXAI=true / GOOGLE_CLOUD_PROJECT=my-proj
 * const ai = createGenAIClient();
 * ```
 *
 * @example API key (AI Studio)
 * ```ts
 * // .env: GEMINI_API_KEY=AIza...
 * const ai = createGenAIClient();
 * ```
 *
 * **Gotchas**
 * - If both Vertex flag **and** API key are set, Vertex wins.
 * - Missing credentials are not thrown here — the first `generateContent` call will
 *   fail with an auth error (fail-loudly by design).
 * - `location` is only meaningful in enterprise mode (ignored otherwise).
 */
export function createGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if (config.useEnterprise && config.project) {
    return new GoogleGenAI({
      enterprise: true,
      project: config.project,
      location: config.location,
    });
  }

  if (apiKey) {
    return new GoogleGenAI({
      apiKey,
    });
  }

  if (config.project) {
    return new GoogleGenAI({
      enterprise: true,
      project: config.project,
      location: config.location,
    });
  }

  // Final fallback to default GoogleGenAI init
  return new GoogleGenAI({});
}
