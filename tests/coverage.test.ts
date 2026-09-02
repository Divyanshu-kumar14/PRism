import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  formatLineRanges,
  executeGetCoverageSummary,
} from '../src/tools/coverage.js';

describe('Coverage Tool & LCOV / JSON Parser', () => {
  const tmpDir = path.resolve('/home/rtx/github/PRism/workspace/test_coverage_suite_tmp');

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, 'coverage'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should format line numbers into compressed ranges', () => {
    expect(formatLineRanges([])).toBe('None (100% covered)');
    expect(formatLineRanges([10])).toBe('10');
    expect(formatLineRanges([1, 2, 3, 5, 8, 9, 10])).toBe('1-3, 5, 8-10');
  });

  it('should parse JSON coverage summary accurately', async () => {
    const mockSummary = {
      total: {
        lines: { total: 100, covered: 80, pct: 80 },
        statements: { total: 100, covered: 80, pct: 80 },
        functions: { total: 20, covered: 15, pct: 75 },
        branches: { total: 10, covered: 6, pct: 60 },
      },
      'src/core.ts': {
        lines: { total: 50, covered: 25, pct: 50 },
        statements: { pct: 50 },
        functions: { pct: 50 },
        branches: { pct: 50 },
        s: { '1': 1, '2': 0, '3': 0 },
        statementMap: {
          '1': { start: { line: 5 } },
          '2': { start: { line: 12 } },
          '3': { start: { line: 13 } },
        },
      },
    };

    fs.writeFileSync(
      path.join(tmpDir, 'coverage/coverage-summary.json'),
      JSON.stringify(mockSummary),
      'utf8'
    );

    const res = await executeGetCoverageSummary(tmpDir);
    expect(res.success).toBe(true);
    expect(res.total?.linesPct).toBe(80);
    expect(res.files).toHaveLength(1);
    expect(res.files![0].file).toBe('src/core.ts');
    expect(res.files![0].linesPct).toBe(50);
    expect(res.files![0].uncoveredLines).toBe('12-13');
  });

  it('should parse LCOV plain-text coverage report', async () => {
    const lcovContent = `
TN:
SF:${path.join(tmpDir, 'src/service.ts')}
DA:1,1
DA:2,1
DA:3,0
DA:4,0
DA:5,1
LF:5
LH:3
end_of_record
`;
    fs.writeFileSync(path.join(tmpDir, 'coverage/lcov.info'), lcovContent.trim(), 'utf8');

    const res = await executeGetCoverageSummary(tmpDir);
    expect(res.success).toBe(true);
    expect(res.files).toHaveLength(1);
    expect(res.files![0].file).toBe('src/service.ts');
    expect(res.files![0].linesPct).toBe(60);
    expect(res.files![0].uncoveredLines).toBe('3-4');
  });

  it('should return error when no coverage reports exist', async () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir);
    const res = await executeGetCoverageSummary(emptyDir);
    expect(res.success).toBe(false);
    expect(res.error).toContain('No coverage report found');
  });
});
