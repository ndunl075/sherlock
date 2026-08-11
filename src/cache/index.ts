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
//
// v2 wire format uses compact tuples instead of verbose objects — on a 50k-file
// warm scan, JSON.parse of the v1 shape alone was hundreds of ms and a large
// share of peak RSS (§9). Empty imports/reexports arrays are omitted.

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

const FORMAT_VERSION = 2;
const CACHE_DIR_NAME = ".sherlock";
const CACHE_FILE_NAME = "cache.json";
const GITIGNORE_LINE = ".sherlock/";

const FILE_KINDS = new Set<string>(["source", "generated", "vendored", "doc", "fixture", "binary"]);

/** Compact on-disk row; trailing optional slots are omitted when unused. */
type WireEntry = Array<number | string | WireModuleInfo | string[] | null>;

/** [exportedNames, imports?, reexports?] — trailing empties omitted */
type WireModuleInfo = [string[], ModuleImport[]?, ModuleReexport[]?];

interface CacheFileV2 {
  formatVersion: 2;
  entries: Record<string, WireEntry>;
}

function packModuleInfo(info: CachedModuleInfo): WireModuleInfo {
  const wire: WireModuleInfo = [info.exportedNames];
  if (info.imports.length > 0) wire[1] = info.imports;
  if (info.reexports.length > 0) {
    if (wire[1] === undefined) wire[1] = [];
    wire[2] = info.reexports;
  }
  return wire;
}

function unpackModuleInfo(wire: WireModuleInfo): CachedModuleInfo {
  return {
    exportedNames: wire[0] ?? [],
    imports: wire[1] ?? [],
    reexports: wire[2] ?? [],
  };
}

function packEntry(entry: CacheEntry): WireEntry {
  const wire: WireEntry = [
    entry.mtimeMs,
    entry.bytes,
    entry.tokens,
    entry.estimated ? 1 : 0,
    entry.kind,
  ];
  const hasExtras =
    entry.moduleInfo !== undefined ||
    entry.generatedHeader !== undefined ||
    entry.referencedPaths !== undefined ||
    entry.contentSimhash !== undefined;
  if (!hasExtras) return wire;

  wire.push(entry.moduleInfo ? packModuleInfo(entry.moduleInfo) : 0);
  if (entry.generatedHeader !== undefined || entry.referencedPaths !== undefined || entry.contentSimhash !== undefined) {
    wire.push(entry.generatedHeader === undefined ? null : entry.generatedHeader ? 1 : 0);
  }
  if (entry.referencedPaths !== undefined || entry.contentSimhash !== undefined) {
    wire.push(entry.referencedPaths ?? null);
  }
  if (entry.contentSimhash !== undefined) {
    wire.push(entry.contentSimhash);
  }
  return wire;
}

function unpackEntry(wire: unknown): CacheEntry | undefined {
  if (!Array.isArray(wire) || wire.length < 5) return undefined;
  const mtimeMs = wire[0];
  const bytes = wire[1];
  const tokens = wire[2];
  const estimated = wire[3];
  const kind = wire[4];
  if (
    typeof mtimeMs !== "number" ||
    typeof bytes !== "number" ||
    typeof tokens !== "number" ||
    (estimated !== 0 && estimated !== 1) ||
    typeof kind !== "string" ||
    !FILE_KINDS.has(kind)
  ) {
    return undefined;
  }
  const entry: CacheEntry = {
    mtimeMs,
    bytes,
    tokens,
    estimated: estimated === 1,
    kind: kind as FileKind,
  };
  const mod = wire[5];
  if (Array.isArray(mod)) entry.moduleInfo = unpackModuleInfo(mod as WireModuleInfo);
  if (wire[6] === 0 || wire[6] === 1) entry.generatedHeader = wire[6] === 1;
  if (Array.isArray(wire[7])) entry.referencedPaths = wire[7] as string[];
  if (typeof wire[8] === "number") entry.contentSimhash = wire[8];
  return entry;
}

function isCacheFileV2(v: unknown): v is CacheFileV2 {
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
    if (!isCacheFileV2(parsed)) return new Map(); // format mismatch (or corrupt) — silently discard, per §11
    const map = new Map<string, CacheEntry>();
    for (const [p, wire] of Object.entries(parsed.entries)) {
      const entry = unpackEntry(wire);
      if (entry) map.set(p, entry);
    }
    return map;
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
    const wireEntries: Record<string, WireEntry> = {};
    for (const [p, entry] of entries) {
      wireEntries[p] = packEntry(entry);
    }
    const file: CacheFileV2 = { formatVersion: FORMAT_VERSION, entries: wireEntries };
    await fs.writeFile(path.join(dir, CACHE_FILE_NAME), JSON.stringify(file));
    await ensureGitignored(root);
  } catch {
    // best-effort — see module header; a slow scan beats a failed one
  }
}
