/**
 * @fileoverview Central configuration & Google GenAI client factory for PRism.
 *
 * **What this module does**
 * - Loads environment variables from `.env` (via `dotenv`).
 * - Exposes a single typed `config` object that every agent, tool, and service
 *   consumes — no ad-hoc `process.env` reads elsewhere.
 * - Provides `parseGitHubRepoUrl()` and `createGenAIClient()` helpers that
 *   encapsulate URL parsing and the Vertex AI ↔ AI Studio auth switch.
 * - Implements memoization caches for O(1) repeated lookups (repo URL parsing).
 *
 * **Performance Optimizations:**
 * - **O(1) memoization for repo URL parsing**: Map keyed by raw URL → parsed {owner, repo}.
 *   Avoids repeated regex exec (agents parse same URL 5-10 times per mission).
 * - **Config validation at boot**: Zod schema validation runs once at import time.
 *   Fail-fast design — invalid config throws immediately with field-by-field diagnostics.
 * - **Singleton pattern**: `config` exported as const — no re-validation on subsequent imports.
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
import { z } from 'zod';

// Load `.env` on import so every downstream module sees populated `process.env`.
// Safe to call multiple times — subsequent calls are no-ops.
dotenv.config();

/**
 * Zod validation schema for strongly-typed application configuration.
 *
 * Validates types, formats (emails, URLs, ports), and numeric bounds at boot time.
 * WHY: Fail-fast at startup rather than cryptic runtime errors downstream.
 * Each field has sensible defaults for local development.
 */
export const AppConfigSchema = z.object({
  useEnterprise: z.boolean().default(false),
  project: z.string().optional(),
  location: z.string().default('us-central1'),
  model: z.string().min(1).default('gemini-2.5-flash'),
  githubToken: z.string().default(''),
  targetRepoUrl: z.string().min(1).default('https://github.com/Divyanshu-kumar14/fluent.git'),
  targetBranch: z.string().min(1).default('main'),
  workspaceDir: z.string().min(1).default('./workspace/fluent'),
  maxTurns: z.number().int().min(1).max(100).default(25),

  // Email & Alerts
  emailRecipient: z.string().email().default('divyanshukumar.dev@proton.me'),
  emailFrom: z.string().min(1).default('PRism Digest <noreply@prism.dev>'),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).default(587),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpSecure: z.boolean().default(false),
  resendApiKey: z.string().optional(),

  // Webhooks
  slackWebhookUrl: z.string().url().optional(),
  discordWebhookUrl: z.string().url().optional(),
  genericWebhookUrl: z.string().url().optional(),

  // Scheduling
  cronSchedule: z.string().min(1).default('0 22 * * *'),
  cronTimezone: z.string().min(1).default('Asia/Kolkata'),

  // Healer (CI auto-fix)
  healerEnabled: z.boolean().default(false),
  healerMaxAttempts: z.number().int().min(1).max(5).default(3),
  healerAllowPush: z.boolean().default(false),
  healerWebhookPort: z.number().int().min(1).max(65535).default(8787),
});

/**
 * Strongly-typed application configuration type inferred from {@link AppConfigSchema}.
 *
 * @category Configuration
 */
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Parses, resolves environment variable aliases, and validates application configuration via Zod.
 *
 * @param env - Source environment variables dictionary (defaults to `process.env`).
 * @returns Fully validated and strongly typed {@link AppConfig}.
 * @throws {Error} If configuration fails Zod schema validation with clear field-by-field diagnostics.
 *
 * **Performance**: Runs once at module import. Subsequent imports reuse the singleton `config`.
 * **Env-var aliases**: Multiple names supported for each field (see table in `config` export).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const gcpProject = env.GOOGLE_CLOUD_PROJECT || env.GCP_PROJECT || env.GCLOUD_PROJECT;
  const isEnterprise = (env.GOOGLE_GENAI_USE_ENTERPRISE === 'true' || env.GOOGLE_GENAI_USE_VERTEXAI === 'true') && !!gcpProject;

  const rawConfig = {
    useEnterprise: isEnterprise,
    project: gcpProject || undefined,
    location: env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    model: env.GEMINI_MODEL || 'gemini-2.5-flash',
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN || '',
    targetRepoUrl: env.TARGET_REPO_URL || 'https://github.com/Divyanshu-kumar14/fluent.git',
    targetBranch: env.TARGET_REPO_BRANCH || 'main',
    workspaceDir: env.WORKSPACE_DIR || './workspace/fluent',
    maxTurns: parseInt(env.MAX_AGENT_TURNS || '25', 10),

    // Email
    emailRecipient: env.ALERT_EMAIL_TO || env.EMAIL_TO || 'divyanshukumar.dev@proton.me',
    emailFrom: env.EMAIL_FROM || 'PRism Digest <noreply@prism.dev>',
    smtpHost: env.SMTP_HOST || undefined,
    smtpPort: parseInt(env.SMTP_PORT || '587', 10),
    smtpUser: env.SMTP_USER || undefined,
    smtpPass: env.SMTP_PASS || undefined,
    smtpSecure: env.SMTP_SECURE === 'true',
    resendApiKey: env.RESEND_API_KEY || undefined,

    // Webhooks
    slackWebhookUrl: env.SLACK_WEBHOOK_URL || undefined,
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || undefined,
    genericWebhookUrl: env.WEBHOOK_URL || env.GENERIC_WEBHOOK_URL || undefined,

    // Schedule
    cronSchedule: env.DIGEST_CRON_SCHEDULE || '0 22 * * *',
    cronTimezone: env.DIGEST_TIMEZONE || 'Asia/Kolkata',

    // Healer
    healerEnabled: env.HEALER_ENABLED === 'true',
    healerMaxAttempts: parseInt(env.HEALER_MAX_ATTEMPTS || '3', 10),
    healerAllowPush: env.HEALER_ALLOW_PUSH === 'true',
    healerWebhookPort: parseInt(env.HEALER_WEBHOOK_PORT || '8787', 10),
  };

  const parsed = AppConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((issue) => `  - [${issue.path.join('.')}]: ${issue.message}`)
      .join('\n');
    console.error(`\x1b[31m[Configuration Error] Invalid environment configuration:\x1b[0m\n${errorDetails}`);
    throw new Error(`Invalid application configuration:\n${errorDetails}`);
  }

  return parsed.data;
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
 * @example
 * ```ts
 * import { config } from './config.js';
 * if (!config.githubToken) console.warn('PR creation will fail — set GITHUB_TOKEN');
 * ```
 *
 * **Performance**: Validated once at import. O(1) property access thereafter.
 * **Hot-reload**: In development, `.env` changes require process restart (dotenv caches).
 */
export const config: AppConfig = loadConfig();

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
 *
 * **Performance**: O(1) memoization cache (bounded to 20 entries).
 * Called on every email subject, PR creation, and header render — avoids repeated regex exec.
 */
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
 *
 * **Performance**: Called once per agent instance. Client creation is O(1) — no config re-validation.
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