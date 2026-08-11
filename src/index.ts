// Pipeline — ARCHITECTURE.md §2.
//
//   discover ─→ classify ─→ measure ─→ detect ─→ score ─→ report
//
// Single pass over the tree; everything downstream of discover() operates on
// the same in-memory FileRecord[]. Detectors (detect/) run last, over the
// completed record set, and never re-read the disk themselves.
//
// Measure/graph ordering is deliberate for I/O: exact-eligible files are
// measured first so their full text can be handed to buildGraph without a
// second disk read. Sampled files and history load in parallel with graph
// construction; records are assembled only after both finish.

import { promises as fs } from "node:fs";
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
import { isGraphEligibleExt } from "./graph/parse.js";
import { runAll } from "./detect/index.js";
import { computeRollup, type Rollup } from "./score/index.js";
import { loadConfig } from "./config/index.js";
import { loadCache, saveCache, isCacheValid, type CacheEntry } from "./cache/index.js";
import { runPool } from "./util/pool.js";
import { type Ctx, type FileKind, type FileRecord, type Finding, type Tier } from "./types.js";

// Public semver surface — ARCHITECTURE.md §11. Keep these root exports
// additive: detector packages must not need to reach into internal modules.
export type { Detector, Finding } from "./types.js";

const SNIFF_BYTES = 512;

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
  const absRoot = path.resolve(root);
  let t = performance.now();
  const [discovered, config, cache] = await Promise.all([discover(absRoot), loadConfig(absRoot), loadCache(absRoot)]);
  mark("discover+config+cache", t);

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

  // Phase 1: measure exact-eligible cache misses first. Their full text is
  // what buildGraph would otherwise re-read from disk.
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
      continue;
    }
    if (willMeasureExact(f.bytes, tier, kind, f.path)) exactToMeasure.push(f);
    else sampledToMeasure.push(f);
  }

  await runPool(exactToMeasure, async (f) => {
    const kind = kindOf(f.path);
    const tier = (tiers.get(f.path) ?? 1) as Tier;
    const measured = await measureTokens(f, tier, kind);
    measuredByPath.set(f.path, deriveSignals(kind, measured, f.path));
  });
  mark("measure exact", t);

  // Only keep in-memory text for graph-eligible files that still need a parse.
  // Holding every exact file's text until assembly would inflate peak RSS for
  // no benefit on docs/non-JS paths.
  const graphInputs: GraphInput[] = discovered.map((f) => {
    const input: GraphInput = {
      path: f.path,
      absPath: f.absPath,
      tier: (tiers.get(f.path) ?? 1) as Tier,
      bytes: f.bytes,
      mtimeMs: f.mtimeMs,
    };
    const needsParse =
      isGraphEligibleExt(extnameOf(f.path)) && !getCachedModuleInfo(f.path, f.bytes, f.mtimeMs);
    if (needsParse) {
      const text = measuredByPath.get(f.path)?.text;
      if (text !== undefined) input.source = text;
    }
    return input;
  });

  // Phase 2: graph + history in parallel with remaining sampled measures.
  t = performance.now();
  const [history, gitAvailable, graphResult] = await Promise.all([
    loadHistory(absRoot),
    isGitRepo(absRoot),
    buildGraph(graphInputs, { getCached: getCachedModuleInfo }),
    runPool(sampledToMeasure, async (f) => {
      const kind = kindOf(f.path);
      const tier = (tiers.get(f.path) ?? 1) as Tier;
      const measured = await measureTokens(f, tier, kind);
      measuredByPath.set(f.path, deriveSignals(kind, measured, f.path));
    }).then(() => undefined),
  ]);
  mark("history+git+buildGraph+sample measure", t);
  const { signals: graph, moduleInfos } = graphResult;

  // Drop in-memory sources now that parse is done — never land in cache/records (§12).
  for (const input of graphInputs) delete input.source;
  for (const fields of measuredByPath.values()) delete fields.text;

  // Phase 3: assemble FileRecords + cache entries from measured fields + graph.
  t = performance.now();
  const newCache = new Map<string, CacheEntry>();
  const files: FileRecord[] = discovered.map((f) => {
    const kind = kindOf(f.path);
    const tier = (tiers.get(f.path) ?? 1) as Tier;
    const measured = measuredByPath.get(f.path) ?? { tokens: 0, estimated: true };

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

    return assembleRecord(f, kind, tier, measured, history.get(f.path), graph.get(f.path));
  });
  mark("assemble records", t);

  t = performance.now();
  await saveCache(absRoot, newCache);
  mark("saveCache", t);

  const budget = opts.budget ?? config.budget;
  const budgetExplicit = opts.budget !== undefined || config.budgetExplicit;
  const ctx: Ctx = { root: absRoot, gitAvailable, budget, now: Math.floor(Date.now() / 1000), cadence: config.cadence };
  t = performance.now();
  const findings = runAll(files, ctx);
  mark("runAll (detectors)", t);

  const rollup = computeRollup(files, findings, budget, config.cadence);

  return { root: absRoot, files, findings, rollup, budgetExplicit };
}
