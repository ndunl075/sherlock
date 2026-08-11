// Pipeline — ARCHITECTURE.md §2.
//
//   discover ─→ classify ─→ measure ─→ detect ─→ score ─→ report
//
// Single pass over the tree; everything downstream of discover() operates on
// the same in-memory FileRecord[]. Detectors (detect/) run last, over the
// completed record set, and never re-read the disk themselves.
//
// Measure/graph ordering is deliberate for I/O: exact-eligible files are
// measured and (when graph-eligible) parsed in one pass so tree-sitter work
// overlaps disk reads instead of waiting for every exact measure to finish.
// Sampled files and history load in parallel with the remaining graph
// aggregate; records are assembled only after both finish.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discover, type DiscoveredFile } from "./discover/index.js";
import { classify, needsContentSniff } from "./classify/index.js";
import { assignTiers } from "./measure/tier.js";
import { measureTokens, willMeasureExact, type MeasureResult } from "./measure/tokens.js";
import { looksGenerated } from "./measure/header.js";
import { extractResolvedLinks } from "./measure/links.js";
import { computeSimhash } from "./measure/simhash.js";
import { loadHistory, isGitRepo } from "./history/index.js";
import { buildGraph, type GraphInput } from "./graph/index.js";
import { isGraphEligibleExt, parseModule, type ModuleInfo } from "./graph/parse.js";
import { runAll } from "./detect/index.js";
import { computeRollup, type Rollup } from "./score/index.js";
import { loadConfig } from "./config/index.js";
import { loadCache, saveCache, isCacheValid, type CacheEntry } from "./cache/index.js";
import { runPool } from "./util/pool.js";
import { collectPackageEntrypoints, resolveAgainstKnownPaths } from "./util/package-entrypoints.js";
import { type Ctx, type FileKind, type FileRecord, type Finding, type Tier } from "./types.js";

// Public semver surface — ARCHITECTURE.md §11. Keep these root exports
// additive: detector packages must not need to reach into internal modules.
export type { Detector, Finding } from "./types.js";

const SNIFF_BYTES = 512;
/** Higher than util/pool's default — exact measure+parse interleaves tiny-file IO with tree-sitter CPU. */
const MEASURE_PARSE_CONCURRENCY = Math.max(64, os.cpus().length * 16);

/**
 * libuv's default threadpool is 4. Our measure/discover pools schedule far more
 * concurrent fs.readFile/stat work than that, so without a bump every "parallel"
 * read still queues on four workers — invisible at hundreds of files, dominant
 * at 50k (§9). Set before the first fs op in this process; no-ops if the user
 * already chose a value.
 */
function ensureUvThreadpool(): void {
  if (process.env.UV_THREADPOOL_SIZE) return;
  process.env.UV_THREADPOOL_SIZE = String(MEASURE_PARSE_CONCURRENCY);
}

async function sniff(absPath: string): Promise<Buffer | undefined> {
  try {
    const fd = await fs.open(absPath, "r");
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await fd.read(buf, 0, SNIFF_BYTES, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
  } catch {
    return undefined;
  }
}

/** Read package.json main/bin/exports as entrypoint seeds — string fields only, never executed. */
async function loadPackageEntrypointSpecs(absRoot: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(absRoot, "package.json"), "utf8");
    return collectPackageEntrypoints(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export interface ScanOptions {
  budget?: number;
}

export interface ScanResult {
  root: string;
  files: FileRecord[];
  findings: Finding[];
  rollup: Rollup;
  /** true when the effective budget came from --budget or .sherlockrc, not the bare DEFAULT_BUDGET fallback */
  budgetExplicit: boolean;
}

// SHERLOCK_DEBUG_TIMING=1 prints per-stage wall-clock time to stderr. This is
// what actually found the §9 benchmark's three real bugs (tree-sitter
// re-constructing a Parser per file, unbounded concurrency hitting EMFILE
// silently, an O(files × findings) rollup) — bisecting "scan() is slow" by
// guesswork would have taken far longer than instrumenting it once.
const DEBUG_TIMING = process.env.SHERLOCK_DEBUG_TIMING === "1";
function mark(label: string, start: number): void {
  if (DEBUG_TIMING) process.stderr.write(`[timing] ${label}: ${(performance.now() - start).toFixed(0)}ms\n`);
}

interface MeasuredFields {
  tokens: number;
  estimated: boolean;
  generatedHeader?: boolean;
  referencedPaths?: string[];
  contentSimhash?: number;
  /** retained only long enough to feed buildGraph; dropped before FileRecord assembly */
  text?: string;
}

function extnameOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

function deriveSignals(kind: FileKind, measured: MeasureResult, relPath: string): MeasuredFields {
  const fields: MeasuredFields = {
    tokens: measured.tokens,
    estimated: measured.estimated,
  };
  if (kind === "generated") fields.generatedHeader = looksGenerated(measured.headSample);
  if (kind === "doc") {
    const links = extractResolvedLinks(measured.headSample, relPath);
    if (links.length > 0) fields.referencedPaths = links;
    const simhash = computeSimhash(measured.headSample);
    if (simhash !== undefined) fields.contentSimhash = simhash;
  }
  if (measured.text !== undefined) fields.text = measured.text;
  return fields;
}

function assembleRecord(
  f: DiscoveredFile,
  kind: FileKind,
  tier: Tier,
  measured: MeasuredFields,
  hist: { lastCommit?: number; commits90d?: number } | undefined,
  graph: { orphan: boolean; deadExports: string[] } | undefined,
): FileRecord {
  const record: FileRecord = {
    path: f.path,
    bytes: f.bytes,
    tokens: measured.tokens,
    estimated: measured.estimated,
    kind,
    tier,
  };
  if (hist?.lastCommit !== undefined) record.lastCommit = hist.lastCommit;
  if (hist?.commits90d !== undefined) record.commits90d = hist.commits90d;
  if (measured.generatedHeader !== undefined) record.generatedHeader = measured.generatedHeader;
  if (measured.referencedPaths !== undefined) record.referencedPaths = measured.referencedPaths;
  if (measured.contentSimhash !== undefined) record.contentSimhash = measured.contentSimhash;
  if (graph) {
    record.orphanModule = graph.orphan;
    if (graph.deadExports.length > 0) record.deadExportSymbols = graph.deadExports;
  }
  return record;
}

export async function scan(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  ensureUvThreadpool();
  const absRoot = path.resolve(root);
  let t = performance.now();
  const discoveredP = discover(absRoot);
  const configP = loadConfig(absRoot);
  const cacheP = loadCache(absRoot);
  const packageEntrypointsP = loadPackageEntrypointSpecs(absRoot);
  const [discovered, config, cache, packageEntrypointSpecs] = await Promise.all([
    discoveredP.then((v) => {
      mark("discover", t);
      return v;
    }),
    configP,
    cacheP.then((v) => {
      mark("loadCache", t);
      return v;
    }),
    packageEntrypointsP,
  ]);
  mark("discover+config+cache+package.json", t);

  t = performance.now();
  const kinds = new Map<string, ReturnType<typeof classify>>();
  for (const f of discovered) {
    const sample = needsContentSniff(f.path) ? await sniff(f.absPath) : undefined;
    kinds.set(f.path, classify(f.path, sample));
  }
  const kindOf = (relPath: string) => kinds.get(relPath) ?? "source";
  mark("classify", t);

  t = performance.now();
  const tiers = await assignTiers(discovered, kindOf);
  mark("assignTiers", t);

  const getCachedModuleInfo = (p: string, bytes: number, mtimeMs: number) => {
    const entry = cache.get(p);
    if (!entry || entry.bytes !== bytes || entry.mtimeMs !== mtimeMs || !entry.moduleInfo) return undefined;
    return {
      imports: entry.moduleInfo.imports,
      reexports: entry.moduleInfo.reexports,
      exportedNames: new Set(entry.moduleInfo.exportedNames),
    };
  };

  const measuredByPath = new Map<string, MeasuredFields>();
  const prefetched = new Map<string, ModuleInfo>();
  let cacheDirty = false;

  // Phase 1: measure exact-eligible cache misses, and parse graph-eligible
  // sources in the same worker so tree-sitter CPU overlaps remaining reads
  // instead of waiting for the full measure wave to drain.
  t = performance.now();
  const exactToMeasure: DiscoveredFile[] = [];
  const sampledToMeasure: DiscoveredFile[] = [];
  for (const f of discovered) {
    const kind = kindOf(f.path);
    const tier = (tiers.get(f.path) ?? 1) as Tier;
    const cached = cache.get(f.path);
    if (isCacheValid(cached, f.bytes, f.mtimeMs, kind)) {
      const fields: MeasuredFields = {
        tokens: cached.tokens,
        estimated: cached.estimated,
      };
      if (cached.generatedHeader !== undefined) fields.generatedHeader = cached.generatedHeader;
      if (cached.referencedPaths !== undefined) fields.referencedPaths = cached.referencedPaths;
      if (cached.contentSimhash !== undefined) fields.contentSimhash = cached.contentSimhash;
      measuredByPath.set(f.path, fields);
      // Valid token cache without a moduleInfo (older cache shape) still needs a
      // graph parse + rewrite so the next warm run can skip the read.
      if (isGraphEligibleExt(extnameOf(f.path)) && !cached.moduleInfo) cacheDirty = true;
      continue;
    }
    cacheDirty = true;
    if (willMeasureExact(f.bytes, tier, kind, f.path)) exactToMeasure.push(f);
    else sampledToMeasure.push(f);
  }

  await runPool(
    exactToMeasure,
    async (f) => {
      const kind = kindOf(f.path);
      const tier = (tiers.get(f.path) ?? 1) as Tier;
      const measured = await measureTokens(f, tier, kind);
      const fields = deriveSignals(kind, measured, f.path);
      const ext = extnameOf(f.path);
      if (
        fields.text !== undefined &&
        isGraphEligibleExt(ext) &&
        !getCachedModuleInfo(f.path, f.bytes, f.mtimeMs)
      ) {
        const parsed = parseModule(fields.text, ext);
        if (parsed) prefetched.set(f.path, parsed);
      }
      delete fields.text; // drop immediately — never retained across the graph phase
      measuredByPath.set(f.path, fields);
    },
    MEASURE_PARSE_CONCURRENCY,
  );
  mark("measure exact (+parse)", t);

  const graphInputs: GraphInput[] = discovered.map((f) => ({
    path: f.path,
    absPath: f.absPath,
    tier: (tiers.get(f.path) ?? 1) as Tier,
    bytes: f.bytes,
    mtimeMs: f.mtimeMs,
  }));

  // Phase 2: graph aggregate (+ history) in parallel with remaining sampled measures.
  // Prefetched ModuleInfos skip read+parse; cache hits skip too; only large
  // graph-eligible files still read here.
  t = performance.now();
  const [history, gitAvailable, graphResult] = await Promise.all([
    loadHistory(absRoot),
    isGitRepo(absRoot),
    buildGraph(graphInputs, {
      getCached: getCachedModuleInfo,
      prefetched,
      packageEntrypoints: packageEntrypointSpecs,
    }),
    runPool(sampledToMeasure, async (f) => {
      const kind = kindOf(f.path);
      const tier = (tiers.get(f.path) ?? 1) as Tier;
      const measured = await measureTokens(f, tier, kind);
      measuredByPath.set(f.path, deriveSignals(kind, measured, f.path));
    }).then(() => undefined),
  ]);
  mark("history+git+buildGraph+sample measure", t);
  const { signals: graph, moduleInfos } = graphResult;

  // Phase 3: assemble FileRecords (+ cache entries when we'll write).
  t = performance.now();
  const shouldWriteCache = cacheDirty || cache.size !== discovered.length;
  const newCache = shouldWriteCache ? new Map<string, CacheEntry>() : undefined;
  const files: FileRecord[] = discovered.map((f) => {
    const kind = kindOf(f.path);
    const tier = (tiers.get(f.path) ?? 1) as Tier;
    const measured = measuredByPath.get(f.path) ?? { tokens: 0, estimated: true };

    if (newCache) {
      const cacheEntry: CacheEntry = {
        mtimeMs: f.mtimeMs,
        bytes: f.bytes,
        tokens: measured.tokens,
        estimated: measured.estimated,
        kind,
      };
      if (measured.generatedHeader !== undefined) cacheEntry.generatedHeader = measured.generatedHeader;
      if (measured.referencedPaths !== undefined) cacheEntry.referencedPaths = measured.referencedPaths;
      if (measured.contentSimhash !== undefined) cacheEntry.contentSimhash = measured.contentSimhash;
      const info = moduleInfos.get(f.path);
      if (info) {
        cacheEntry.moduleInfo = {
          imports: info.imports,
          reexports: info.reexports,
          exportedNames: [...info.exportedNames],
        };
      }
      newCache.set(f.path, cacheEntry);
    }

    return assembleRecord(f, kind, tier, measured, history.get(f.path), graph.get(f.path));
  });
  mark("assemble records", t);

  // Warm runs with a fully valid cache still used to rewrite the entire
  // .sherlock/cache.json (JSON.stringify of 50k moduleInfo entries) — pure
  // overhead on the §9 warm budget. Skip when nothing changed.
  // JSON.stringify is sync and dominates saveCache, so overlapping it with
  // detectors does not help — keep the write after scoring inputs are ready.
  t = performance.now();
  if (newCache) await saveCache(absRoot, newCache);
  mark("saveCache", t);

  const budget = opts.budget ?? config.budget;
  const budgetExplicit = opts.budget !== undefined || config.budgetExplicit;
  const knownPaths = new Set(files.map((f) => f.path));
  const packageEntrypoints = new Set<string>();
  for (const spec of packageEntrypointSpecs) {
    const resolved = resolveAgainstKnownPaths(spec, knownPaths);
    if (resolved) packageEntrypoints.add(resolved);
  }

  const ctx: Ctx = {
    root: absRoot,
    gitAvailable,
    budget,
    now: Math.floor(Date.now() / 1000),
    cadence: config.cadence,
    packageEntrypoints,
  };
  t = performance.now();
  const findings = runAll(files, ctx);
  mark("runAll (detectors)", t);

  const rollup = computeRollup(files, findings, budget, config.cadence);

  return { root: absRoot, files, findings, rollup, budgetExplicit };
}
