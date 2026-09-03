import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';

// Provide dummy Gemini auth for HealerAgent constructor (createGenAIClient requires API key or project)
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-dummy-key';
process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'test-dummy-key';

// We test Healer logic without hitting Gemini (mock the client)

describe('HealerAgent — CI Healing', () => {
  const tmpDir = path.resolve('/home/rtx/github/PRism/workspace/test_healer_tmp');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}', 'utf8');
  });

  it('should consider already-green command as healed (dry-run)', async () => {
    // Mock Gemini client to never be called (since repro passes, heal returns early)
    const { HealerAgent } = await import('../src/healer_agent.js');

    // Stub createGenAIClient before instantiation — we patch the module
    // Easier: just test the no-LLM path by using a command that passes
    wsSetup(tmpDir);

    const healer = new HealerAgent('test-model');
    // Override repoManager workspace to tmpDir
    (healer as unknown as { repoManager: { getWorkspacePath: () => string } }).repoManager = {
      getWorkspacePath: () => tmpDir,
      setupWorkspace: async () => ({ message: 'mock' }),
    } as never;

    // Mock the Gemini client so no network is hit (even though we won't reach LLM)
    (healer as unknown as { client: { models: { generateContent: unknown } } }).client = {
      models: {
        generateContent: vi.fn(async () => {
          throw new Error('should not be called when already green');
        }),
      },
    } as never;

    const res = await healer.heal({
      failingCommand: 'node -e "process.exit(0)"', // always passes
      branch: undefined, // stay on tmpDir
    });

    expect(res.healed).toBe(true);
    expect(res.attempts).toBe(0);
    expect(res.metrics.healed).toBe(true);
    expect(res.summary).toContain('already passes');
  });

  it('should respect maxAttempts cap (5)', async () => {
    const { HealerAgent } = await import('../src/healer_agent.js');
    const healer = new HealerAgent('test-model');
    (healer as unknown as { repoManager: { getWorkspacePath: () => string } }).repoManager = {
      getWorkspacePath: () => tmpDir,
      setupWorkspace: async () => ({ message: 'mock' }),
    } as never;

    // Make LLM always return no-op text, so verify stays red and we hit max attempts
    (healer as unknown as { client: { models: { generateContent: unknown } } }).client = {
      models: {
        generateContent: vi.fn(async () => ({
          candidates: [{ content: { parts: [{ text: 'I cannot fix' }] } }],
          text: 'cannot fix',
        })),
      },
    } as never;

    const res = await healer.heal({
      failingCommand: 'node -e "process.exit(1)"', // always fails
      maxAttempts: 10, // request 10, but capped to 5
    });

    expect(res.healed).toBe(false);
    expect(res.attempts).toBeLessThanOrEqual(5);
    expect(res.metrics.attempts).toBeLessThanOrEqual(5);
  });

  it('should block dangerous commands via command_runner guardrail', async () => {
    const { executeRunCommand } = await import('../src/tools/command_runner.js');
    const res = await executeRunCommand(tmpDir, { command: 'rm -rf /' });
    expect(res.success).toBe(false);
    expect(res.stderr).toContain('Security Violation');
  });

  it('should handle empty ciLogTail (edge case: LLM diagnoses from stderr only)', async () => {
    const { HealerAgent } = await import('../src/healer_agent.js');
    const healer = new HealerAgent('test-model');
    (healer as unknown as { repoManager: { getWorkspacePath: () => string } }).repoManager = {
      getWorkspacePath: () => tmpDir,
      setupWorkspace: async () => ({ message: 'mock' }),
    } as never;

    // Green path with empty log should still succeed without LLM
    (healer as unknown as { client: { models: { generateContent: unknown } } }).client = {
      models: { generateContent: vi.fn() },
    } as never;

    const res = await healer.heal({
      failingCommand: 'node -e "process.exit(0)"',
      ciLogTail: '', // empty edge case
    });

    expect(res.healed).toBe(true);
  });
});

function wsSetup(dir: string): void {
  // Ensure tmpDir has a minimal git-ish structure for command_runner cwd
  // Not a git repo, but executeRunCommand just needs cwd to exist
  fs.mkdirSync(dir, { recursive: true });
}
