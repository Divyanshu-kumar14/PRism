/**
 * @fileoverview Sandboxed file-system tools for the LLM agents.
 *
 * **What this module does**
 * - Exposes `read_file`, `write_file`, and `list_dir` as Gemini `FunctionDeclaration`s
 *   plus synchronous executors (`execute*`) that always stay inside `workspaceRoot`.
 * - Prevents path-traversal, filters large ignored directories, and caps output size
 *   to keep the LLM context window healthy.
 *
 * **Key configurations / parameters**
 * | Tool        | Param        | Type      | Default | Notes |
 * |-------------|--------------|-----------|---------|-------|
 * | `read_file` | `filePath`   | `string`  | —       | Relative to workspace root, e.g. `src/lib/utils.ts` |
 * |             | `startLine`  | `number`  | 1       | 1-based inclusive |
 * |             | `endLine`    | `number`  | EOF     | Clamped to `totalLines` |
 * | `write_file`| `filePath`   | `string`  | —       | Auto-creates parent dirs |
 * |             | `content`    | `string`  | —       | Full UTF-8 overwrite, not append |
 * | `list_dir`  | `dirPath`    | `string`  | `"."`   | Relative dir |
 * |             | `recursive`  | `boolean` | `true`  | |
 * |             | `maxDepth`   | `number`  | 5       | Ignored when `recursive=false` |
 * |             | `extension`  | `string`  | none    | `"ts"` matches `*.ts` (dot optional) |
 *
 * **Usage examples**
 * ```ts
 * // Read a slice
 * executeReadFile(ws, { filePath: 'package.json' });
 * executeReadFile(ws, { filePath: 'src/agent.ts', startLine: 1, endLine: 50 });
 *
 * // Write a test file
 * executeWriteFile(ws, { filePath: 'tests/utils.test.ts', content: 'import { x } from \"../src/x\"...' });
 *
 * // List source files
 * executeListDir(ws, { dirPath: 'src', recursive: true, maxDepth: 3, extension: 'ts' });
 * ```
 *
 * @see {@link resolveWorkspacePath} — the security boundary.
 */

import fs from 'fs';
import path from 'path';
import type { FunctionDeclaration } from '@google/genai';

// ── Performance caches (module-level, O(1) lookups) ───────────────────────
// Read cache: Map keyed by absolute path + mtime → parsed lines
// Avoids repeated disk I/O when agent re-reads same file across turns (common in explore loops)
// List cache: TTL-based for directory listings (invalidated on write)
// Both are bounded (LRU eviction) to prevent unbounded memory growth in long-lived scheduler daemon
const READ_CACHE_MAX = 100;
const readCache = new Map<string, { mtimeMs: number; lines: string[]; totalLines: number }>();
const LIST_CACHE_TTL_MS = 30_000;
const LIST_CACHE_MAX = 80;
const listCache = new Map<string, { ts: number; result: { entries: string[]; count: number } }>();

// O(1) lookup Set for ignored directories — shared across all list_dir calls
// Perf: single shared Set avoids re-allocating 7-entry Set per invocation (was `new Set([...])` inside fn)
// Lookup is O(1) vs O(n) array.includes, critical when walking 10k+ entries
const SHARED_IGNORE_SET = new Set(['.git', 'node_modules', '.next', 'dist', '.turbo', 'build', '.cache']);

// Perf: grep result cache — memoize recent searches O(1) Map hit
// WHY: Agent often repeats same grep (e.g., "export function" twice) within one mission. Cache saves O(N) file walks.
// TTL 10s ensures fresh results after write_file; bounded to 40 entries to prevent leak in scheduler daemon.
// Key includes workspace + query + flags + extension + pathPrefix → exact hit required (Do No Harm: no stale cross-workspace)
const GREP_CACHE_TTL_MS = 10_000;
const GREP_CACHE_MAX = 40;
const grepCache = new Map<string, { ts: number; result: { matches: GrepMatch[]; totalMatches: number; count: number; truncated: boolean } }>();

function buildGrepCacheKey(
  workspaceRoot: string,
  params: GrepSearchParams
): string {
  // O(1) string concat key — all params participate to avoid false hits
  return `${path.resolve(workspaceRoot)}::q:${params.query}::r:${params.isRegex ? 1 : 0}::i:${params.caseInsensitive ? 1 : 0}::e:${params.extension ?? ''}::p:${params.pathPrefix ?? '.'}::m:${params.maxResults ?? 50}`;
}

function evictLRU<K, V>(map: Map<K, V>, max: number): void {
  // O(1) amortized LRU eviction — delete oldest entry (Map preserves insertion order)
  if (map.size > max) {
    const firstKey = map.keys().next().value as K;
    map.delete(firstKey);
  }
}

function buildReadCacheKey(workspaceRoot: string, relPath: string): string {
  return `${path.resolve(workspaceRoot)}::${relPath}`;
}

function buildListCacheKey(
  workspaceRoot: string,
  baseRelative: string,
  recursive: boolean,
  maxDepth: number,
  extFilter: string | null
): string {
  return `${path.resolve(workspaceRoot)}::${baseRelative}::r${recursive ? 1 : 0}::d${maxDepth}::e${extFilter ?? ''}`;
}

// ── Param interfaces ───────────────────────────────────────────────

/** Parameters for `read_file`. Paths are always relative to `workspaceRoot`. */
export interface ReadFileParams {
  /** Relative path inside workspace, e.g. `src/lib/utils.ts` or `package.json`. */
  filePath: string;
  /** 1-based first line to include (inclusive). Defaults to `1`. */
  startLine?: number;
  /** 1-based last line to include (inclusive). Defaults to end-of-file. */
  endLine?: number;
}

/** Parameters for `write_file`. Overwrites the file atomically (truncates). */
export interface WriteFileParams {
  /** Relative destination, e.g. `tests/utils.test.ts`. Parent dirs are created (`mkdir -p`). */
  filePath: string;
  /** Full UTF-8 content to write. No append mode — this replaces the file. */
  content: string;
}

/** Parameters for `patch_file`. Performs surgical find-and-replace without full file overwrite. */
export interface PatchFileParams {
  /** Relative path of the file to modify within the repository (e.g. `src/lib/utils.ts`). */
  filePath: string;
  /** The exact string or code block in the file to replace. Must match existing content exactly. */
  targetContent: string;
  /** New replacement string or code block. */
  replacementContent: string;
  /** Whether to replace all occurrences if found multiple times. Defaults to false. */
  allowMultiple?: boolean;
}

/** Parameters for `list_dir`. */
export interface ListDirParams {
  /** Relative directory to list (`"."` = workspace root). Defaults to `"."`. */
  dirPath?: string;
  /** Walk subdirectories. Defaults to `true`. */
  recursive?: boolean;
  /** Max subdirectory depth when recursive. Defaults to `5`. */
  maxDepth?: number;
  /** Filter by extension without dot, e.g. `"ts"` → `*.ts`. Dot prefix auto-stripped. */
  extension?: string;
}

/** Parameters for `grep_search`. Searches text or regex across workspace files. */
export interface GrepSearchParams {
  /** Search query string or regex pattern. */
  query: string;
  /** Whether to interpret query as a regular expression. Defaults to false. */
  isRegex?: boolean;
  /** Whether search is case-insensitive. Defaults to false. */
  caseInsensitive?: boolean;
  /** Optional file extension filter without dot (e.g. "ts", "tsx", "json"). */
  extension?: string;
  /** Relative directory to scope the search within (e.g. "src", "tests"). Defaults to ".". */
  pathPrefix?: string;
  /** Maximum number of line matches to return. Defaults to 50. */
  maxResults?: number;
}

/** Single match returned by `grep_search`. */
export interface GrepMatch {
  filePath: string;
  lineNumber: number;
  lineContent: string;
}

// ── Gemini function declarations ───────────────────────────────────

/**
 * Gemini tool declaration for `read_file`.
 * The LLM uses this to inspect source code, package manifests, configs, etc.
 * @example LLM call: `read_file({ filePath: "src/lib/utils.ts", startLine: 1, endLine: 80 })`
 */
export const readFileFunctionDeclaration: FunctionDeclaration = {
  name: 'read_file',
  description: 'Reads content from a file inside the target repository workspace. Supports optional startLine and endLine for partial reading.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Relative path of the file to read within the repository (e.g., "src/lib/utils.ts", "package.json").',
      },
      startLine: {
        type: 'integer',
        description: 'Optional 1-based start line number to read from.',
      },
      endLine: {
        type: 'integer',
        description: 'Optional 1-based end line number to read until (inclusive).',
      },
    },
    required: ['filePath'],
  },
};

/**
 * Gemini tool declaration for `write_file`.
 * Used by {@link CoverageAgent} to create test files and by agents to patch code.
 * Parent directories are created automatically (`mkdir -p` semantics).
 */
export const writeFileFunctionDeclaration: FunctionDeclaration = {
  name: 'write_file',
  description: 'Writes or updates a file inside the target repository workspace. Creates parent directories automatically if they do not exist.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Relative path of the file to create or update (e.g., "tests/utils.test.ts", "src/features/audio.test.ts").',
      },
      content: {
        type: 'string',
        description: 'Complete text/code content to write to the file.',
      },
    },
    required: ['filePath', 'content'],
  },
};

/**
 * Gemini tool declaration for `patch_file`.
 * Surgical find-and-replace for modifying existing files without full rewrites.
 */
export const patchFileFunctionDeclaration: FunctionDeclaration = {
  name: 'patch_file',
  description: 'Performs a surgical find-and-replace of an exact code snippet or block inside an existing file without overwriting the entire file. The targetContent must match the file content exactly.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Relative path of the file to modify within the repository (e.g., "src/lib/utils.ts", "tests/utils.test.ts").',
      },
      targetContent: {
        type: 'string',
        description: 'The exact string/lines of code in the file to replace. Must match existing file content exactly including whitespace.',
      },
      replacementContent: {
        type: 'string',
        description: 'The replacement string/lines of code to insert.',
      },
      allowMultiple: {
        type: 'boolean',
        description: 'Whether to replace multiple occurrences if found. If false and target occurs >1 times, the patch is rejected. Defaults to false.',
      },
    },
    required: ['filePath', 'targetContent', 'replacementContent'],
  },
};

/**
 * Gemini tool declaration for `list_dir`.
 * Hard-codes an ignore list (`.git`, `node_modules`, `.next`, …) to keep the
 * 150-entry cap useful for source exploration.
 */
export const listDirFunctionDeclaration: FunctionDeclaration = {
  name: 'list_dir',
  description: 'Lists files and directories inside the target repository workspace. Supports recursive listing and filtering by extension.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      dirPath: {
        type: 'string',
        description: 'Relative directory path to list (e.g., "." for root, "src", "src/lib"). Defaults to ".".',
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to list recursively down subdirectories. Defaults to true.',
      },
      maxDepth: {
        type: 'integer',
        description: 'Maximum subdirectory depth when recursive is true. Defaults to 5.',
      },
      extension: {
        type: 'string',
        description: 'Optional file extension filter without dot (e.g., "ts", "tsx", "json").',
      },
    },
  },
};

/**
 * Gemini tool declaration for `grep_search`.
 * Fast regex/text code search across workspace files with line number snippets.
 */
export const grepSearchFunctionDeclaration: FunctionDeclaration = {
  name: 'grep_search',
  description: 'Searches for exact text or regex patterns across files in the target repository workspace. Returns matching file paths, line numbers, and snippets. Use this to find functions, types, imports, and variables.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text string or regular expression pattern to search for across files.',
      },
      isRegex: {
        type: 'boolean',
        description: 'Whether to treat query as a regular expression. Defaults to false.',
      },
      caseInsensitive: {
        type: 'boolean',
        description: 'Whether search is case-insensitive. Defaults to false.',
      },
      extension: {
        type: 'string',
        description: 'Optional file extension filter without dot (e.g., "ts", "tsx", "js").',
      },
      pathPrefix: {
        type: 'string',
        description: 'Subdirectory path to scope the search within (e.g., "src", "src/lib"). Defaults to ".".',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of line matches to return. Defaults to 50.',
      },
    },
    required: ['query'],
  },
};

// ── Executors ──────────────────────────────────────────────────────

/**
 * Resolves `relativePath` against `workspaceRoot` and enforces sandbox containment.
 *
 * @param workspaceRoot - Absolute workspace path from {@link GitRepoManager#getWorkspacePath}.
 * @param relativePath - User/LLM-supplied relative path.
 * @returns Absolute, normalized path guaranteed to be inside `workspaceRoot`.
 * @throws {Error} `Path traversal violation` if the resolved path escapes the workspace.
 *
 * @example
 * ```ts
 * resolveWorkspacePath('/ws/fluent', 'src/index.ts') // → '/ws/fluent/src/index.ts'
 * resolveWorkspacePath('/ws/fluent', '../../etc/passwd') // throws!
 * ```
 *
 * **Gotcha:** relies on `path.resolve` string-prefix check. On case-insensitive
 * filesystems (macOS/Windows) symlinks could still escape — but workspaces are
 * ephemeral clones on Linux CI so this is not a practical bypass.
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!resolved.startsWith(path.resolve(workspaceRoot))) {
    throw new Error(`Path traversal violation: ${relativePath} resolves outside workspace.`);
  }
  return resolved;
}

/**
 * Reads a file inside the workspace, optionally slicing by line range.
 *
 * @param workspaceRoot - Absolute workspace root.
 * @param params - File path + optional 1-based line window.
 * @returns `{ content, totalLines, startLine, endLine }` on success, or `{ error }`.
 *   Content is annotated with line numbers (`"12: const x = 1;"`) for LLM context.
 *
 * **Edge cases / gotchas**
 * - If the file is a directory → `{ error: "… is a directory. Use list_dir instead." }`
 * - Missing file → `{ error: "File not found: …" }`
 * - `startLine` beyond EOF → returns empty slice but still reports `totalLines`.
 * - Reads as `utf8`; binary files (images) will produce garbled text but not throw.
 * - `endLine` is **clamped** to `totalLines` (never throws for out-of-range).
 *
 * @example
 * ```ts
 * const r = executeReadFile(ws, { filePath: 'package.json' });
 * if ('error' in r) throw new Error(r.error);
 * console.log(r.content); // "1: {\n2:   \"name\": \"fluent\",..."
 * ```
 */
export function executeReadFile(workspaceRoot: string, params: ReadFileParams): { content: string; totalLines: number; startLine: number; endLine: number } | { error: string } {
  try {
    const fullPath = resolveWorkspacePath(workspaceRoot, params.filePath);
    if (!fs.existsSync(fullPath)) {
      return { error: `File not found: ${params.filePath}` };
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return { error: `Cannot read: ${params.filePath} is a directory. Use list_dir instead.` };
    }

    // Perf: O(1) cache lookup by mtime — avoids O(n) disk read + split when agent re-reads same file
    // across multiple turns (e.g., coverage agent reads package.json 5+ times). Invalidates automatically on mtime change.
    const cacheKey = buildReadCacheKey(workspaceRoot, params.filePath);
    const cached = readCache.get(cacheKey);
    let lines: string[];
    let totalLines: number;
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      // Cache hit — reuse parsed lines (O(1) Map get)
      lines = cached.lines;
      totalLines = cached.totalLines;
    } else {
      const raw = fs.readFileSync(fullPath, 'utf8');
      lines = raw.split(/\r?\n/);
      totalLines = lines.length;
      // Store parsed lines for next turn — bounded LRU to prevent memory leak in daemon
      readCache.set(cacheKey, { mtimeMs: stat.mtimeMs, lines, totalLines });
      evictLRU(readCache, READ_CACHE_MAX);
    }

    const start = Math.max(1, params.startLine || 1);
    const end = Math.min(totalLines, params.endLine || totalLines);

    // Single-pass slice + map — O(k) where k = end-start, not O(n)
    const slice = lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`).join('\n');
    return {
      content: slice,
      totalLines,
      startLine: start,
      endLine: end,
    };
  } catch (err: any) {
    return { error: `Failed to read ${params.filePath}: ${err.message}` };
  }
}

/**
 * Writes (overwrites) a file inside the workspace.
 *
 * @param workspaceRoot - Absolute workspace root.
 * @param params - Destination + UTF-8 content.
 * @returns `{ success, filePath, bytesWritten }` or `{ error }`.
 *
 * **Behavior**
 * - `fs.mkdirSync(dir, { recursive: true })` before writing — never fails for missing parents.
 * - Atomic in the sense of `writeFileSync` (truncates), but not `write + rename` crash-safe.
 *
 * **Gotchas**
 * - Overwrites without confirmation — agents rely on this to replace test files.
 * - No size limit checked here; very large content (>10 MB) may strain LLM context downstream.
 *
 * @example
 * ```ts
 * const r = executeWriteFile(ws, { filePath: 'tests/utils.test.ts', content: '...' });
 * if ('error' in r) console.error(r.error);
 * else console.log(`Wrote ${r.bytesWritten} bytes`);
 * ```
 */
export function executeWriteFile(workspaceRoot: string, params: WriteFileParams): { success: boolean; filePath: string; bytesWritten: number } | { error: string } {
  try {
    const fullPath = resolveWorkspacePath(workspaceRoot, params.filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, params.content, 'utf8');
    // Perf: cache invalidation — O(k) where k = cache size, but k ≤ 100 so negligible
    // Invalidate read cache for this file and any list caches under its parent dirs
    // This ensures subsequent read_file sees fresh content without stale O(1) hit
    const cacheKey = buildReadCacheKey(workspaceRoot, params.filePath);
    readCache.delete(cacheKey);
    // Invalidate list caches that could contain this path — iterate keys (bounded to 80)
    // O(1) amortized per write; prevents stale directory listings after test file creation
    for (const key of listCache.keys()) {
      if (key.startsWith(path.resolve(workspaceRoot))) {
        // Conservative: clear all list caches for this workspace on any write
        // Alternative would be precise prefix matching, but write frequency is low (few files per mission)
        listCache.delete(key);
      }
    }
    // Perf: invalidate grep cache for this workspace — O(k) where k ≤ 40
    // WHY: write_file changes file content; cached grep results would be stale. Clear workspace-scoped keys.
    for (const key of grepCache.keys()) {
      if (key.startsWith(path.resolve(workspaceRoot))) grepCache.delete(key);
    }
    return {
      success: true,
      filePath: params.filePath,
      bytesWritten: Buffer.byteLength(params.content, 'utf8'),
    };
  } catch (err: any) {
    return { error: `Failed to write ${params.filePath}: ${err.message}` };
  }
}

/**
 * Lists files/directories inside the workspace with ignore & depth controls.
 *
 * @param workspaceRoot - Absolute workspace root.
 * @param params - Dir, recursion, depth, extension filter.
 * @returns `{ entries, count }` (entries capped at 150) or `{ error }`.
 *   Directories end with `/`, files do not. Paths are **relative** to workspace.
 *
 * **Hard-coded ignore list** (skipped at every level):
 * `.git`, `node_modules`, `.next`, `dist`, `.turbo`, `build`, `.cache`
 *
 * **Edge cases / gotchas**
 * - `count` = total found before the 150-entry cap; useful to know if listing was truncated.
 * - `entries.slice(0,150)` — if you need more, call with a narrower `dirPath` or `extension`.
 * - `extension` strips a leading dot, so `".ts"` and `"ts"` are equivalent.
 * - `maxDepth` defaults to `5` and `recursive` defaults to `true`; pass `recursive:false`
 *   for a single-level listing.
 *
 * @example
 * ```ts
 * const r = executeListDir(ws, { dirPath: 'src', recursive: true, extension: 'ts' });
 * if (!('error' in r)) console.log(r.entries); // ["src/index.ts", "src/lib/utils.ts", ...]
 * ```
 */
export function executeListDir(workspaceRoot: string, params: ListDirParams): { entries: string[]; count: number } | { error: string } {
  try {
    const baseRelative = params.dirPath || '.';
    const fullBase = resolveWorkspacePath(workspaceRoot, baseRelative);
    if (!fs.existsSync(fullBase)) {
      return { error: `Directory not found: ${baseRelative}` };
    }

    const recursive = params.recursive !== false;
    const maxDepth = params.maxDepth || 5;
    const extFilter = params.extension ? `.${params.extension.replace(/^\./, '')}` : null;

    // Perf: TTL cache check — O(1) Map lookup avoids O(n) fs walk on repeated explorer turns
    // Agents often call list_dir "." twice within 2 turns; cache hit saves 50-200ms on large repos
    const cacheKey = buildListCacheKey(workspaceRoot, baseRelative, recursive, maxDepth, extFilter);
    const cached = listCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < LIST_CACHE_TTL_MS) {
      return cached.result;
    }

    // Use shared O(1) Set for ignore check — was per-call allocation, now reused
    const ignoreSet = SHARED_IGNORE_SET;

    // Perf: memory-optimized — store only first 150 entries but count all
    // Old: results = [] pushed 10k entries then slice(0,150) → O(N) memory
    // New: cappedEntries ≤150, totalCount accurate, O(1) memory for huge repos
    const cappedEntries: string[] = [];
    let totalCount = 0;

    function walk(currentDir: string, currentDepth: number) {
      // O(n) DFS where n = entries in subtree; ignoreSet.has is O(1) vs array.includes O(m)
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (ignoreSet.has(entry.name)) continue; // O(1) lookup via shared Set

        const entryPath = path.join(currentDir, entry.name);
        const rel = path.relative(workspaceRoot, entryPath);

        if (entry.isDirectory()) {
          totalCount++;
          if (cappedEntries.length < 150) cappedEntries.push(`${rel}/`);
          if (recursive && currentDepth < maxDepth) {
            walk(entryPath, currentDepth + 1);
          }
        } else if (entry.isFile()) {
          if (!extFilter || entry.name.endsWith(extFilter)) {
            totalCount++;
            if (cappedEntries.length < 150) cappedEntries.push(rel);
          }
        }
      }
    }

    walk(fullBase, 1);
    const result = {
      entries: cappedEntries, // already capped at 150 — O(1) slice avoided
      count: totalCount,
    };
    // Cache result for next agent turn — O(1) TTL Map
    listCache.set(cacheKey, { ts: Date.now(), result });
    evictLRU(listCache, LIST_CACHE_MAX);
    return result;
  } catch (err: any) {
    return { error: `Failed to list directory: ${err.message}` };
  }
}

/**
 * Surgically replaces an exact code snippet or block within an existing file.
 *
 * @param workspaceRoot - Absolute workspace root.
 * @param params - File path, target content, replacement content, and allowMultiple flag.
 * @returns `{ success: true, filePath, replacementsCount }` or `{ error }`.
 *
 * @example
 * ```ts
 * const res = executePatchFile(ws, {
 *   filePath: 'src/lib/utils.ts',
 *   targetContent: 'export const x = 1;',
 *   replacementContent: 'export const x = 2;',
 * });
 * ```
 */
export function executePatchFile(
  workspaceRoot: string,
  params: PatchFileParams
): { success: boolean; filePath: string; replacementsCount: number } | { error: string } {
  try {
    const fullPath = resolveWorkspacePath(workspaceRoot, params.filePath);
    if (!fs.existsSync(fullPath)) {
      return { error: `File not found: ${params.filePath}` };
    }

    const currentContent = fs.readFileSync(fullPath, 'utf8');
    const target = params.targetContent;

    if (!target) {
      return { error: 'targetContent cannot be empty.' };
    }

    if (!currentContent.includes(target)) {
      return {
        error: `Target content not found in ${params.filePath}. Ensure exact whitespace, indentation, and newline matching.`,
      };
    }

    // Count exact occurrences
    const occurrences = currentContent.split(target).length - 1;
    if (occurrences > 1 && !params.allowMultiple) {
      return {
        error: `Target content found ${occurrences} times in ${params.filePath}. Provide more surrounding lines of context to target a unique occurrence or set allowMultiple: true.`,
      };
    }

    let updatedContent: string;
    if (params.allowMultiple) {
      updatedContent = currentContent.split(target).join(params.replacementContent);
    } else {
      updatedContent = currentContent.replace(target, params.replacementContent);
    }

    fs.writeFileSync(fullPath, updatedContent, 'utf8');

    // Invalidate read, list, and grep caches for the workspace — O(k) bounded
    const cacheKey = buildReadCacheKey(workspaceRoot, params.filePath);
    readCache.delete(cacheKey);
    for (const key of listCache.keys()) {
      if (key.startsWith(path.resolve(workspaceRoot))) {
        listCache.delete(key);
      }
    }
    // Perf: clear grep cache for workspace — content changed, cached searches stale
    for (const key of grepCache.keys()) {
      if (key.startsWith(path.resolve(workspaceRoot))) grepCache.delete(key);
    }

    return {
      success: true,
      filePath: params.filePath,
      replacementsCount: occurrences,
    };
  } catch (err: any) {
    return { error: `Failed to patch ${params.filePath}: ${err.message}` };
  }
}

/**
 * Searches for exact text or regex patterns across files in the workspace.
 *
 * @param workspaceRoot - Absolute workspace root.
 * @param params - Query string, regex options, file extension, and scope.
 * @returns `{ matches, totalMatches, count, truncated }` or `{ error }`.
 *
 * @example
 * ```ts
 * const res = executeGrepSearch(ws, { query: 'formatCurrency', extension: 'ts' });
 * ```
 */
export function executeGrepSearch(
  workspaceRoot: string,
  params: GrepSearchParams
): { matches: GrepMatch[]; totalMatches: number; count: number; truncated: boolean } | { error: string } {
  try {
    // Perf: O(1) cache check — repeated grep for same query within 10s returns instantly
    // WHY: Coverage agent often searches "export function" then "export const" then repeats after failure fix.
    const grepKey = buildGrepCacheKey(workspaceRoot, params);
    const cached = grepCache.get(grepKey);
    if (cached && Date.now() - cached.ts < GREP_CACHE_TTL_MS) {
      return cached.result; // O(1) Map hit — avoids O(N) file walk
    }

    const baseDir = params.pathPrefix || '.';
    const fullBase = resolveWorkspacePath(workspaceRoot, baseDir);
    if (!fs.existsSync(fullBase)) {
      return { error: `Directory not found: ${baseDir}` };
    }

    const maxResults = params.maxResults || 50;
    const extFilter = params.extension ? `.${params.extension.replace(/^\./, '')}` : null;
    // Perf: compile regex once O(1) — reused for all files/lines, no per-line recompilation
    let regex: RegExp;
    if (params.isRegex) {
      regex = new RegExp(params.query, params.caseInsensitive ? 'i' : '');
    } else {
      const escaped = params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, params.caseInsensitive ? 'i' : '');
    }
    // Clone for per-line test to avoid lastIndex pollution (if 'g' flag ever added) — O(1)
    // WHY: Reusing same RegExp with /g advances lastIndex, causing missed matches. Separate instance is safe.
    const lineRegex = new RegExp(regex.source, regex.flags);

    const matches: GrepMatch[] = [];
    let totalMatches = 0;
    const ignoreSet = SHARED_IGNORE_SET; // O(1) Set lookup vs O(n) array

    function walkAndSearch(currentDir: string) {
      if (matches.length >= maxResults) return; // early exit — O(1) check per dir

      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      // O(n) where n = entries in dir; ignoreSet.has is O(1) vs includes O(m)
      for (const entry of entries) {
        if (ignoreSet.has(entry.name)) continue; // O(1)

        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walkAndSearch(entryPath);
        } else if (entry.isFile()) {
          if (extFilter && !entry.name.endsWith(extFilter)) continue;

          const relPath = path.relative(workspaceRoot, entryPath);
          try {
            const content = fs.readFileSync(entryPath, 'utf8');
            // Perf: O(n) pre-filter — single regex.test on whole content avoids per-line scan for non-matching files
            // WHY: 80% of files won't contain query; early exit saves O(lines) work. No 'g' flag so test is safe.
            if (!regex.test(content)) continue;

            const lines = content.split(/\r?\n/);
            // O(lines) per file — each line checked once with cloned regex
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              // Use cloned regex to avoid stateful lastIndex side-effects
              if (lineRegex.test(line)) {
                totalMatches++;
                if (matches.length < maxResults) {
                  matches.push({
                    filePath: relPath,
                    lineNumber: i + 1,
                    lineContent: line.length > 200 ? line.slice(0, 200) + '...' : line,
                  });
                }
              } else {
                // Reset lastIndex in case of global flag edge — O(1)
                lineRegex.lastIndex = 0;
              }
            }
            // Reset global state after file
            regex.lastIndex = 0;
            lineRegex.lastIndex = 0;
          } catch {
            // Ignore unreadable or binary files — Do No Harm: never throw for one bad file
          }
        }
      }
    }

    walkAndSearch(fullBase);

    const result = {
      matches,
      totalMatches,
      count: matches.length,
      truncated: totalMatches > matches.length,
    };
    // Perf: cache result O(1) Map set — bounded LRU prevents leak
    grepCache.set(grepKey, { ts: Date.now(), result });
    evictLRU(grepCache, GREP_CACHE_MAX);
    return result;
  } catch (err: any) {
    return { error: `Grep search failed: ${err.message}` };
  }
}
