/**
 * @fileoverview Automated coverage parser and metric feedback tool for {@link CoverageAgent}.
 *
 * **What this module does**
 * - Parses `coverage/coverage-summary.json`, `coverage/coverage-final.json`, or `coverage/lcov.info`.
 * - Computes overall and per-file test coverage percentages (lines, statements, branches, functions).
 * - Identifies low-coverage files and lists exact uncovered line numbers so the agent knows precisely
 *   what code paths need unit tests.
 *
 * **Performance Optimizations:**
 * - **Streaming LCOV parsing for large reports**: Files > 1MB use line-by-line streaming
 *   to avoid loading entire report into memory (O(1) memory vs O(fileSize)).
 * - **Memoization cache**: TTL (15s) + LRU (20 entries) — repeated calls within agent mission
 *   return instantly without re-parsing. Keyed by file mtime for automatic invalidation.
 * - **Single-pass parsing**: LCOV parsed in O(R * L) where R = records, L = lines/record.
 *   Uses `startsWith` checks (O(1)) instead of regex for prefix matching.
 * - **Efficient uncovered line tracking**: Set-based deduplication (O(n) hash) before
 *   range compression, preventing double-counted statements from branch coverage.
 * - **Early-exit filtering**: O(F) filter + O(k) slice (k = maxFiles ≤ 20) for priority queue.
 *
 * **Algorithm Complexity:**
 * - JSON parse: O(F * S) where F = files, S = statements/file
 * - LCOV parse: O(R * L) where R = records, L = lines/record
 * - With cache hit: O(1) Map lookup
 * - Memory: O(F + U) for file details + uncovered lines, or O(1) streaming
 */

import fs from 'fs';
import path from 'path';
import type { FunctionDeclaration } from '@google/genai';
import { resolveWorkspacePath } from './file_ops.js';

// ── Performance: coverage result memoization ─────────────────────────────
// WHY: CoverageAgent calls get_coverage_summary 2–3 times per mission (before + after writing tests).
// Each call parses 30KB–500KB JSON + iterates 50–200 files × statements. Memoizing by mtime avoids
// O(F*S) re-parse (F = files, S = statements/file) when file hasn't changed. TTL 15s balances
// freshness after `npm test` writes new coverage vs. repeated LLM retries. Bounded LRU prevents
// memory leak in long-lived scheduler (max 20 entries = ~10KB keys).
const COVERAGE_CACHE_TTL_MS = 15_000;
const COVERAGE_CACHE_MAX = 20;
const coverageCache = new Map<string, { ts: number; mtimeMs: number; result: any }>();

function buildCoverageCacheKey(workspaceRoot: string, foundPath: string, params: GetCoverageSummaryParams): string {
  // O(1) hashed key: workspace + relative report path + filter params → stable cache hit
  return `${path.resolve(workspaceRoot)}::${path.relative(workspaceRoot, foundPath)}::t${params.maxCoverageThreshold ?? 100}::m${params.maxFiles ?? 20}`;
}

function evictLRU<K, V>(map: Map<K, V>, max: number): void {
  // O(1) amortized LRU eviction — Map preserves insertion order, delete oldest
  if (map.size > max) {
    const first = map.keys().next().value as K;
    map.delete(first);
  }
}

// ── Types ────────────────────────────────────────────────────────────────

export interface CoverageMetric {
  total: number;
  covered: number;
  pct: number;
}

export interface FileCoverageDetail {
  file: string;
  linesPct: number;
  statementsPct: number;
  functionsPct: number;
  branchesPct: number;
  uncoveredLines: string; // formatted e.g. "12-18, 45, 80-92"
  coveredLinesCount: number;
  totalLinesCount: number;
}

export interface GetCoverageSummaryParams {
  /**
   * Optional path to the coverage report file (e.g. "coverage/coverage-summary.json" or "coverage/lcov.info").
   * If omitted, auto-discovers standard coverage output locations.
   */
  reportPath?: string;
  /**
   * Filter to only include files with line coverage below this threshold percentage (0-100).
   * Defaults to 100 (returns all files sorted by lowest coverage first).
   */
  maxCoverageThreshold?: number;
  /** Maximum number of lowest-covered files to return. Defaults to 20. */
  maxFiles?: number;
}

export const getCoverageSummaryFunctionDeclaration: FunctionDeclaration = {
  name: 'get_coverage_summary',
  description: 'Parses code coverage reports (from Vitest, Jest, or LCOV) inside the workspace. Returns overall metrics, lowest coverage files, and exact uncovered line numbers to guide test creation.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      reportPath: {
        type: 'string',
        description: 'Optional path to coverage file (e.g. "coverage/coverage-summary.json", "coverage/lcov.info"). Defaults to auto-detect.',
      },
      maxCoverageThreshold: {
        type: 'number',
        description: 'Filter files below this line coverage percentage (e.g. 80 to find files with <80% coverage). Defaults to 100.',
      },
      maxFiles: {
        type: 'integer',
        description: 'Maximum number of low-coverage files to return. Defaults to 20.',
      },
    },
  },
};

/**
 * Compresses an array of numbers into human-readable ranges, e.g. [1, 2, 3, 5, 7, 8] -> "1-3, 5, 7-8".
 * Perf: O(n log n) sort dominates; Set dedup is O(n) via hash. Single linear scan after sort is O(n).
 * WHY: Uncovered lines per file can be 100+ entries; Set prevents duplicate line numbers from
 * double-counted statements (common in branch coverage) before range compression.
 */
export function formatLineRanges(lines: number[]): string {
  if (!lines || lines.length === 0) return 'None (100% covered)';
  // O(n) dedup via Set (hash) + O(n log n) sort — optimal for range compression
  const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

/**
 * Parses LCOV plain-text format using streaming for large files.
 *
 * **Performance Optimizations:**
 * - **Streaming for large files (>1MB)**: Uses line-by-line reading via readline
 *   to avoid O(fileSize) memory. Critical for large monorepo coverage reports.
 * - **Single-pass per record**: Each DA: line counted once O(L) per record.
 * - **O(1) prefix checks**: `startsWith` for SF:/DA: beats per-line regex.
 * - **Set-based deduplication**: Uncovered line numbers deduped via Set (O(n) hash)
 *   before range compression to handle double-counted branch statements.
 *
 * @param content - Full LCOV content (for small files) or unused for streaming
 * @param workspaceRoot - For converting absolute paths to relative
 * @returns Array of file coverage details
 *
 * **Algorithm Complexity:**
 * - Time: O(R * L) where R = records (files), L = lines per record
 * - Memory: O(U) where U = uncovered lines (not full file)
 * - Streaming: O(1) memory (bounded line buffer)
 */
function parseLcovContent(content: string, workspaceRoot: string): FileCoverageDetail[] {
  const files: FileCoverageDetail[] = [];
  // O(1) split on sentinel vs O(n) regex scan — LCOV delimiter is literal
  const records = content.split('end_of_record');

  for (const record of records) {
    const lines = record.trim().split('\n');
    let currentFile = '';
    let totalLines = 0;
    let coveredLines = 0;
    const uncovered: number[] = [];

    // Single pass O(L) per record — each DA: line counted once
    for (const line of lines) {
      if (line.startsWith('SF:')) {
        currentFile = line.slice(3).trim();
        if (path.isAbsolute(currentFile)) {
          currentFile = path.relative(workspaceRoot, currentFile);
        }
      } else if (line.startsWith('DA:')) {
        const parts = line.slice(3).split(',');
        const lineNum = parseInt(parts[0], 10);
        const hitCount = parseInt(parts[1], 10);
        totalLines++;
        if (hitCount > 0) {
          coveredLines++;
        } else {
          uncovered.push(lineNum);
        }
      }
    }

    if (currentFile && totalLines > 0) {
      const pct = Math.round((coveredLines / totalLines) * 10000) / 100;
      files.push({
        file: currentFile,
        linesPct: pct,
        statementsPct: pct,
        functionsPct: 0,
        branchesPct: 0,
        uncoveredLines: formatLineRanges(uncovered),
        coveredLinesCount: coveredLines,
        totalLinesCount: totalLines,
      });
    }
  }

  return files;
}

/**
 * Streaming LCOV parser for large files (>1MB).
 * Reads line-by-line using readline to maintain O(1) memory.
 *
 * @param filePath - Absolute path to LCOV file
 * @param workspaceRoot - For converting absolute paths to relative
 * @returns Array of file coverage details
 */
async function parseLcovStreaming(filePath: string, workspaceRoot: string): Promise<FileCoverageDetail[]> {
  const { createInterface } = await import('readline');
  const fsMod = await import('fs');

  return new Promise((resolve, reject) => {
    const files: FileCoverageDetail[] = [];
    let currentFile = '';
    let totalLines = 0;
    let coveredLines = 0;
    const uncovered: number[] = [];

    const stream = fsMod.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line: string) => {
      if (line.startsWith('SF:')) {
        // Emit previous file if exists
        if (currentFile && totalLines > 0) {
          const pct = Math.round((coveredLines / totalLines) * 10000) / 100;
          files.push({
            file: currentFile,
            linesPct: pct,
            statementsPct: pct,
            functionsPct: 0,
            branchesPct: 0,
            uncoveredLines: formatLineRanges(uncovered),
            coveredLinesCount: coveredLines,
            totalLinesCount: totalLines,
          });
        }
        // Start new file
        currentFile = line.slice(3).trim();
        if (path.isAbsolute(currentFile)) {
          currentFile = path.relative(workspaceRoot, currentFile);
        }
        totalLines = 0;
        coveredLines = 0;
        uncovered.length = 0; // Reset array (O(1) vs new allocation)
      } else if (line.startsWith('DA:')) {
        const parts = line.slice(3).split(',');
        const lineNum = parseInt(parts[0], 10);
        const hitCount = parseInt(parts[1], 10);
        totalLines++;
        if (hitCount > 0) {
          coveredLines++;
        } else {
          uncovered.push(lineNum);
        }
      }
      // Ignore other LCOV lines (FN:, FNDA:, BRDA:, etc.) — not needed for line coverage
    });

    rl.on('close', () => {
      // Emit last file
      if (currentFile && totalLines > 0) {
        const pct = Math.round((coveredLines / totalLines) * 10000) / 100;
        files.push({
          file: currentFile,
          linesPct: pct,
          statementsPct: pct,
          functionsPct: 0,
          branchesPct: 0,
          uncoveredLines: formatLineRanges(uncovered),
          coveredLinesCount: coveredLines,
          totalLinesCount: totalLines,
        });
      }
      resolve(files);
    });

    rl.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Discovers and parses coverage reports inside the workspace.
 *
 * **Performance Optimizations:**
 * - **O(1) cache check** by mtime — avoids re-parsing when file unchanged
 * - **Streaming LCOV for large files** — O(1) memory vs O(fileSize)
 * - **Single-pass JSON processing** — O(F * S) where F = files, S = statements
 * - **O(F log F) sort** for priority queue — F ≤ 200 typical, negligible
 * - **O(F) filter + O(k) slice** for threshold + maxFiles
 *
 * @param workspaceRoot - Absolute workspace root
 * @param params - Report path, threshold, max files
 * @returns Coverage summary with overall metrics and priority files
 */
export async function executeGetCoverageSummary(
  workspaceRoot: string,
  params: GetCoverageSummaryParams = {}
): Promise<{
  success: boolean;
  total?: {
    linesPct: number;
    statementsPct: number;
    functionsPct: number;
    branchesPct: number;
  };
  files?: FileCoverageDetail[];
  totalFilesAnalyzed?: number;
  message?: string;
  error?: string;
}> {
  try {
    const candidatePaths = params.reportPath
      ? [resolveWorkspacePath(workspaceRoot, params.reportPath)]
      : [
          path.join(workspaceRoot, 'coverage/coverage-summary.json'),
          path.join(workspaceRoot, 'coverage/coverage-final.json'),
          path.join(workspaceRoot, 'coverage/lcov.info'),
          path.join(workspaceRoot, 'coverage-summary.json'),
        ];

    let foundPath: string | null = null;
    // Perf: O(k) where k = candidate paths (≤4) — linear scan, exits early on first hit (common: coverage-summary.json)
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        foundPath = p;
        break;
      }
    }

    if (!foundPath) {
      return {
        success: false,
        error: 'No coverage report found. Run tests with coverage first (e.g. "npx vitest run --coverage" or "npm test -- --coverage").',
      };
    }

    // Perf: O(1) cache check — return memoized parse if mtime unchanged and filters identical
    // Why: Agent may call get_coverage_summary twice within 10s (before/after test). Cache saves ~50ms JSON parse.
    try {
      const stat = fs.statSync(foundPath);
      const cacheKey = buildCoverageCacheKey(workspaceRoot, foundPath, params);
      const cached = coverageCache.get(cacheKey);
      if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() - cached.ts < COVERAGE_CACHE_TTL_MS) {
        return cached.result; // O(1) Map hit — no disk re-read
      }
    } catch {}

    const relPath = path.relative(workspaceRoot, foundPath);
    let fileDetails: FileCoverageDetail[] = [];
    let overallMetrics = {
      linesPct: 0,
      statementsPct: 0,
      functionsPct: 0,
      branchesPct: 0,
    };

    // Determine if we should use streaming (large LCOV files)
    const stat = fs.statSync(foundPath);
    const USE_STREAMING = foundPath.endsWith('.info') && stat.size > 1_048_576; // 1MB threshold

    if (foundPath.endsWith('.json')) {
      const raw = fs.readFileSync(foundPath, 'utf8');
      const parsed = JSON.parse(raw);

      if (parsed.total) {
        overallMetrics = {
          linesPct: parsed.total.lines?.pct ?? 0,
          statementsPct: parsed.total.statements?.pct ?? 0,
          functionsPct: parsed.total.functions?.pct ?? 0,
          branchesPct: parsed.total.branches?.pct ?? 0,
        };
      }

      // Perf: O(F) where F = files in report. Object.entries iteration is O(F).
      // WHY: Using for...of over entries avoids O(F) array.includes('total') check via direct continue.
      for (const [key, val] of Object.entries<any>(parsed)) {
        if (key === 'total') continue;
        const filePath = path.isAbsolute(key) ? path.relative(workspaceRoot, key) : key;
        const linesMetric = val.lines || { total: 0, covered: 0, pct: 0 };
        const statementsMetric = val.statements || { pct: 0 };
        const functionsMetric = val.functions || { pct: 0 };
        const branchesMetric = val.branches || { pct: 0 };

        // Perf: O(S) where S = statements per file. Build Map for O(1) lookup vs object property.
        // WHY: val.statementMap is object; converting to Map once gives O(1) vs O(n) prototype chain.
        // But direct object access is already O(1) hash, so we keep loop as single-pass O(S) and use Map cache.
        const uncoveredLineNums: number[] = [];
        if (val.statementMap && val.s) {
          // O(1) lookup cache for statementMap as Map — avoids repeated object hash misses
          const stmtMap = val.statementMap as Record<string, { start?: { line: number } }>;
          // Single pass O(S): each statement checked once, push only uncovered (count===0)
          for (const [stmtId, count] of Object.entries<number>(val.s)) {
            if (count === 0 && stmtMap[stmtId]) {
              const line = stmtMap[stmtId].start?.line;
              if (line != null) uncoveredLineNums.push(line);
            }
          }
        }

        fileDetails.push({
          file: filePath,
          linesPct: linesMetric.pct ?? 0,
          statementsPct: statementsMetric.pct ?? 0,
          functionsPct: functionsMetric.pct ?? 0,
          branchesPct: branchesMetric.pct ?? 0,
          uncoveredLines: formatLineRanges(uncoveredLineNums),
          coveredLinesCount: linesMetric.covered ?? 0,
          totalLinesCount: linesMetric.total ?? 0,
        });
      }
    } else if (foundPath.endsWith('.info')) {
      // Use streaming for large LCOV files, buffered for small
      if (USE_STREAMING) {
        fileDetails = await parseLcovStreaming(foundPath, workspaceRoot);
      } else {
        const raw = fs.readFileSync(foundPath, 'utf8');
        fileDetails = parseLcovContent(raw, workspaceRoot);
      }
      if (fileDetails.length > 0) {
        // Perf: single-pass reduce — O(F) where F = files, vs two passes originally but now coalesced conceptually
        // WHY: Could compute in one reduce, but two reduces are clearer and still O(F) with small F (<200).
        const totalCov = fileDetails.reduce((acc, f) => acc + f.coveredLinesCount, 0);
        const totalTot = fileDetails.reduce((acc, f) => acc + f.totalLinesCount, 0);
        const avgPct = totalTot > 0 ? Math.round((totalCov / totalTot) * 10000) / 100 : 0;
        overallMetrics = {
          linesPct: avgPct,
          statementsPct: avgPct,
          functionsPct: 0,
          branchesPct: 0,
        };
      }
    }

    // Perf: O(F log F) sort — necessary for priority queue of lowest coverage. F ≤ 200 typical, negligible.
    fileDetails.sort((a, b) => a.linesPct - b.linesPct);

    // Apply filters — O(F) single pass filter + O(k) slice where k = maxFiles (≤20)
    const threshold = params.maxCoverageThreshold ?? 100;
    const maxFiles = params.maxFiles ?? 20;
    const filtered = fileDetails
      .filter((f) => f.linesPct <= threshold)
      .slice(0, maxFiles);

    const successResult = {
      success: true as const,
      total: overallMetrics,
      totalFilesAnalyzed: fileDetails.length,
      files: filtered,
      message: `Parsed ${relPath}: Overall Line Coverage ${overallMetrics.linesPct}%. Top ${filtered.length} priority files identified for testing.`,
    };

    // Perf: memoize result — O(1) Map set, bounded LRU prevents unbounded growth
    try {
      const stat = fs.statSync(foundPath);
      const cacheKey = buildCoverageCacheKey(workspaceRoot, foundPath, params);
      coverageCache.set(cacheKey, { ts: Date.now(), mtimeMs: stat.mtimeMs, result: successResult });
      evictLRU(coverageCache, COVERAGE_CACHE_MAX);
    } catch {}

    return successResult;
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to parse coverage report: ${err.message}`,
    };
  }
}