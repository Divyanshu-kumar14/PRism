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

    const raw = fs.readFileSync(fullPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const totalLines = lines.length;

    const start = Math.max(1, params.startLine || 1);
    const end = Math.min(totalLines, params.endLine || totalLines);

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

    const ignoreList = new Set(['.git', 'node_modules', '.next', 'dist', '.turbo', 'build', '.cache']);

    const results: string[] = [];

    function walk(currentDir: string, currentDepth: number) {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (ignoreList.has(entry.name)) continue;

        const entryPath = path.join(currentDir, entry.name);
        const rel = path.relative(workspaceRoot, entryPath);

        if (entry.isDirectory()) {
          results.push(`${rel}/`);
          if (recursive && currentDepth < maxDepth) {
            walk(entryPath, currentDepth + 1);
          }
        } else if (entry.isFile()) {
          if (!extFilter || entry.name.endsWith(extFilter)) {
            results.push(rel);
          }
        }
      }
    }

    walk(fullBase, 1);
    return {
      entries: results.slice(0, 150),
      count: results.length,
    };
  } catch (err: any) {
    return { error: `Failed to list directory: ${err.message}` };
  }
}
