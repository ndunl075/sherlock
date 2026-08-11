// .sherlock/cache.json — ARCHITECTURE.md §5, §10, §12.
//
// Keyed by path + mtime + size (§5): a cache hit skips re-reading and
// re-measuring a file entirely. Scope is deliberately narrow — only the
// per-file measure/classify outputs below. graph/'s orphanModule and
// deadExportSymbols are NOT cached here: they depend on the whole repo's
// import edges, not just one file's own content, so a file whose only
// importer got deleted would keep reading as "not orphan" from a stale
// per-file cache entry. A wrong "safe to trim" is worse than a slow scan, so
// graph/ always recomputes.
//
// Format carries a version and is silently discarded on mismatch (§11) —
// never migrated. Holds path, mtime, size, token count, and other per-file
// metadata; never file content or snippets (§12). Cache writes are
// best-effort: a failed write (read-only fs, no permissions) must never fail
// the scan, and .sherlock/ is added to the repo's .gitignore on first run.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileKind } from "../types.js";
import type { ModuleImport, ModuleReexport } from "../graph/parse.js";

/** JSON-serializable form of graph/parse.ts's ModuleInfo (its exportedNames Set becomes an array). */
export interface CachedModuleInfo {
  imports: ModuleImport[];
  reexports: ModuleReexport[];
  exportedNames: string[];
}

export interface CacheEntry {
  mtimeMs: number;
  bytes: number;
  tokens: number;
  estimated: boolean;
  kind: FileKind;
  generatedHeader?: boolean;
  referencedPaths?: string[];
  contentSimhash?: number;
  /** graph/'s per-file parse — safe to cache, unlike the aggregate orphan/deadExports signals (see graph/index.ts) */
  moduleInfo?: CachedModuleInfo;
}

const FORMAT_VERSION = 1;
const CACHE_DIR_NAME = ".sherlock";
const CACHE_FILE_NAME = "cache.json";
const GITIGNORE_LINE = ".sherlock/";

interface CacheFile {
  formatVersion: number;
  entries: Record<string, CacheEntry>;
}

function isCacheFile(v: unknown): v is CacheFile {
  return (
    typeof v === "object" &&
    v !== null &&
    "formatVersion" in v &&
    (v as { formatVersion: unknown }).formatVersion === FORMAT_VERSION &&
    "entries" in v &&
    typeof (v as { entries: unknown }).entries === "object" &&
    (v as { entries: unknown }).entries !== null
  );
}

export function isCacheValid(entry: CacheEntry | undefined, bytes: number, mtimeMs: number, kind: FileKind): entry is CacheEntry {
  return !!entry && entry.bytes === bytes && entry.mtimeMs === mtimeMs && entry.kind === kind;
}

export async function loadCache(root: string): Promise<Map<string, CacheEntry>> {
  try {
    const text = await fs.readFile(path.join(root, CACHE_DIR_NAME, CACHE_FILE_NAME), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!isCacheFile(parsed)) return new Map(); // format mismatch (or corrupt) — silently discard, per §11
    return new Map(Object.entries(parsed.entries));
  } catch {
    return new Map(); // no cache yet (cold on fresh clone, per §10) or unreadable — cold start either way
  }
}

async function ensureGitignored(root: string): Promise<void> {
  const gitignorePath = path.join(root, ".gitignore");
  try {
    let content = "";
    try {
      content = await fs.readFile(gitignorePath, "utf8");
    } catch {
      // no .gitignore yet — fine, we'll create one
    }
    const alreadyPresent = content.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_LINE || line.trim() === ".sherlock");
    if (alreadyPresent) return;
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await fs.writeFile(gitignorePath, `${content}${separator}${GITIGNORE_LINE}\n`);
  } catch {
    // best-effort — a read-only tree or missing permissions must never fail the scan
  }
}

export async function saveCache(root: string, entries: Map<string, CacheEntry>): Promise<void> {
  try {
    const dir = path.join(root, CACHE_DIR_NAME);
    await fs.mkdir(dir, { recursive: true });
    const file: CacheFile = { formatVersion: FORMAT_VERSION, entries: Object.fromEntries(entries) };
    await fs.writeFile(path.join(dir, CACHE_FILE_NAME), JSON.stringify(file));
    await ensureGitignored(root);
  } catch {
    // best-effort — see module header; a slow scan beats a failed one
  }
}
