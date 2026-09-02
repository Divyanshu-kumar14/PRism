import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  isDangerousCommand,
  getSanitizedEnv,
  executeRunCommand,
} from '../src/tools/command_runner.js';

describe('Command Runner & Security Sandbox', () => {
  const workspaceRoot = path.resolve(process.cwd());

  it('should identify and block destructive commands', () => {
    expect(isDangerousCommand('rm -rf /').blocked).toBe(true);
    expect(isDangerousCommand('rm -rf ~').blocked).toBe(true);
    expect(isDangerousCommand('sudo rm -rf ./dist').blocked).toBe(true);
    expect(isDangerousCommand('mkfs.ext4 /dev/sda1').blocked).toBe(true);
    expect(isDangerousCommand('cat ../../.env').blocked).toBe(true);
  });

  it('should allow benign build, test, and git commands', () => {
    expect(isDangerousCommand('npm test').blocked).toBe(false);
    expect(isDangerousCommand('npx vitest run').blocked).toBe(false);
    expect(isDangerousCommand('git status').blocked).toBe(false);
    expect(isDangerousCommand('echo "hello world"').blocked).toBe(false);
  });

  it('should sanitize host secrets from process environment', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret_key_123';
    process.env.GEMINI_API_KEY = 'AIza_secret_key_456';
    process.env.SMTP_PASS = 'smtp_secret_pass';

    const sanitized = getSanitizedEnv();
    expect(sanitized.GITHUB_TOKEN).toBeUndefined();
    expect(sanitized.GEMINI_API_KEY).toBeUndefined();
    expect(sanitized.SMTP_PASS).toBeUndefined();
    expect(sanitized.CI).toBe('true');
  });

  it('should intercept dangerous command during executeRunCommand', async () => {
    const res = await executeRunCommand(workspaceRoot, { command: 'rm -rf /' });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Blocked dangerous system command');
  });

  it('should successfully execute safe commands', async () => {
    const res = await executeRunCommand(workspaceRoot, { command: 'node -e "console.log(\'prism-ok\')"' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('prism-ok');
  });
});
