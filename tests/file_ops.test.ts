import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  resolveWorkspacePath,
  executeListDir,
  executeGrepSearch,
  executePatchFile,
  executeWriteFile,
  executeReadFile,
} from '../src/tools/file_ops.js';

describe('File Operations & Security Sandboxing', () => {
  const tmpDir = path.resolve('/home/rtx/github/PRism/workspace/test_file_ops_tmp');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{\n  "name": "test-pkg"\n}\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should block directory traversal outside workspace root', () => {
    expect(() => resolveWorkspacePath(tmpDir, '../../etc/passwd')).toThrow(/Path traversal violation/);
    expect(() => resolveWorkspacePath(tmpDir, '/etc/passwd')).toThrow(/Path traversal violation/);
  });

  it('should list directory contents with metadata', () => {
    const res = executeListDir(tmpDir, { dirPath: '.' });
    expect(res.entries.length).toBeGreaterThanOrEqual(2);
    expect(res.entries).toContain('package.json');
    expect(res.entries).toContain('src/');
  });

  it('should read file content within line bounds', () => {
    const res = executeReadFile(tmpDir, { filePath: 'src/math.ts', startLine: 1, endLine: 2 });
    expect(res.content).toContain('export function add');
    expect(res.totalLines).toBeGreaterThanOrEqual(3);
  });

  it('should grep search patterns across files', () => {
    const res = executeGrepSearch(tmpDir, { query: 'export function' });
    expect(res.totalMatches).toBe(1);
    expect(res.matches[0].filePath).toBe('src/math.ts');
    expect(res.matches[0].lineContent).toContain('export function add');
  });

  it('should surgically patch file with replacement', () => {
    const patchRes = executePatchFile(tmpDir, {
      filePath: 'src/math.ts',
      targetContent: 'return a + b;',
      replacementContent: 'return Number(a) + Number(b);',
    });

    expect(patchRes).toHaveProperty('success', true);

    const readRes = executeReadFile(tmpDir, { filePath: 'src/math.ts' });
    expect(readRes.content).toContain('return Number(a) + Number(b);');
    expect(readRes.content).not.toContain('return a + b;');
  });

  it('should return error when targetContent to patch is not found', () => {
    const patchRes = executePatchFile(tmpDir, {
      filePath: 'src/math.ts',
      targetContent: 'non_existent_code();',
      replacementContent: 'new_code();',
    });

    expect(patchRes).toHaveProperty('error');
    expect((patchRes as { error: string }).error).toContain('Target content not found');
  });
});
