import { describe, it, expect } from 'vitest';
import { loadConfig, AppConfigSchema, parseGitHubRepoUrl } from '../src/config.js';

describe('Configuration & Schema Validation (Zod)', () => {
  it('should load default configuration when minimal env is provided', () => {
    const config = loadConfig({
      GEMINI_API_KEY: 'test-key',
    });

    expect(config.model).toBe('gemini-2.5-flash');
    expect(config.emailRecipient).toBe('divyanshukumar.dev@proton.me');
    expect(config.targetBranch).toBe('main');
    expect(config.maxTurns).toBe(25);
    expect(config.smtpPort).toBe(587);
  });

  it('should resolve environment variable aliases correctly', () => {
    const config = loadConfig({
      GH_TOKEN: 'ghp_alias_token',
      ALERT_EMAIL_TO: 'alerts@domain.com',
      GCP_PROJECT: 'gcp-project-123',
      MAX_AGENT_TURNS: '40',
      SMTP_PORT: '465',
    });

    expect(config.githubToken).toBe('ghp_alias_token');
    expect(config.emailRecipient).toBe('alerts@domain.com');
    expect(config.project).toBe('gcp-project-123');
    expect(config.maxTurns).toBe(40);
    expect(config.smtpPort).toBe(465);
  });

  it('should reject invalid email format in Zod schema', () => {
    expect(() => {
      loadConfig({
        ALERT_EMAIL_TO: 'not-an-email',
      });
    }).toThrow(/Invalid application configuration/);
  });

  it('should reject invalid port numbers in Zod schema', () => {
    expect(() => {
      loadConfig({
        SMTP_PORT: '999999',
      });
    }).toThrow(/Invalid application configuration/);
  });

  it('should reject out-of-bound maxTurns in Zod schema', () => {
    expect(() => {
      loadConfig({
        MAX_AGENT_TURNS: '200',
      });
    }).toThrow(/Invalid application configuration/);
  });

  it('should parse valid GitHub repository URLs', () => {
    const parsed1 = parseGitHubRepoUrl('https://github.com/Divyanshu-kumar14/fluent.git');
    expect(parsed1).toEqual({ owner: 'Divyanshu-kumar14', repo: 'fluent' });

    const parsed2 = parseGitHubRepoUrl('https://github.com/facebook/react');
    expect(parsed2).toEqual({ owner: 'facebook', repo: 'react' });

    expect(() => parseGitHubRepoUrl('https://gitlab.com/user/repo')).toThrow(/Invalid GitHub repository/);
  });
});
