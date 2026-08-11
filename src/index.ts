// Pipeline — ARCHITECTURE.md §2.
//
//   discover ─→ classify ─→ measure ─→ detect ─→ score ─→ report
//
// Single pass over the tree; everything downstream of discover() operates on
// the same in-memory FileRecord[]. Detectors (detect/) run last, over the
// completed record set, and never re-read the disk themselves.

import { promises as fs } from "node:fs";
import path from "node:path";
import { discover, type DiscoveredFile } from "./discover/index.js";
import { classify, needsContentSniff } from "./classify/index.js";
import { assignTiers } from "./measure/tier.js";
import { measureTokens } from "./measure/tokens.js";
import { looksGenerated } from "./measure/header.js";
import { extractResolvedLinks } from "./measure/links.js";
import { computeSimhash } from "./measure/simhash.js";
import { loadHistory, isGitRepo } from "./history/index.js";
import { buildGraph, type GraphInput } from "./graph/index.js";
import { runAll } from "./detect/index.js";
import { computeRollup, type Rollup } from "./score/index.js";
import { loadConfig } from "./config/index.js";
import { loadCache, saveCache, isCacheValid, type CacheEntry } from "./cache/index.js";
import { runPool } from "./util/pool.js";
import { type Ctx, type FileRecord, type Finding } from "./types.js";

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
  const graphInputs: GraphInput[] = discovered.map((f) => ({
    path: f.path,
    absPath: f.absPath,
    tier: tiers.get(f.path) ?? 1,
    bytes: f.bytes,
    mtimeMs: f.mtimeMs,
  }));
  const getCachedModuleInfo = (p: string, bytes: number, mtimeMs: number) => {
    const entry = cache.get(p);
    if (!entry || entry.bytes !== bytes || entry.mtimeMs !== mtimeMs || !entry.moduleInfo) return undefined;
    return {
      imports: entry.moduleInfo.imports,
      reexports: entry.moduleInfo.reexports,
      exportedNames: new Set(entry.moduleInfo.exportedNames),
    };
  };
  t = performance.now();
  const [history, gitAvailable, graphResult] = await Promise.all([
    loadHistory(absRoot),
    isGitRepo(absRoot),
    buildGraph(graphInputs, { getCached: getCachedModuleInfo }),
  ]);
  mark("history+git+buildGraph", t);
  const { signals: graph, moduleInfos } = graphResult;

  const newCache = new Map<string, CacheEntry>();
  t = performance.now();

  // Bounded, not unbounded Promise.all — see graph/index.ts's comment on
  // runPool for why: fully unbounded concurrency across every discovered
  // file hits the OS's open-file-descriptor ceiling on large repos and fails
  // silently (EMFILE), not loudly.
  const files: FileRecord[] = await runPool(discovered, async (f: DiscoveredFile) => {
    const kind = kindOf(f.path);
    const tier = tiers.get(f.path) ?? 1;

    const cached = cache.get(f.path);
    let tokens: number;
    let estimated: boolean;
    let generatedHeader: boolean | undefined;
    let referencedPaths: string[] | undefined;
    let contentSimhash: number | undefined;

    if (isCacheValid(cached, f.bytes, f.mtimeMs, kind)) {
      // cache hit — no read, no tokenization, no header/link/simhash pass; this is §5's "warm run"
      ({ tokens, estimated, generatedHeader, referencedPaths, contentSimhash } = cached);
    } else {
      const measured = await measureTokens(f, tier, kind);
      tokens = measured.tokens;
      estimated = measured.estimated;
      if (kind === "generated") generatedHeader = looksGenerated(measured.headSample);
      if (kind === "doc") {
        const links = extractResolvedLinks(measured.headSample, f.path);
        if (links.length > 0) referencedPaths = links;
        contentSimhash = computeSimhash(measured.headSample);
      }
    }

    const cacheEntry: CacheEntry = { mtimeMs: f.mtimeMs, bytes: f.bytes, tokens, estimated, kind };
    if (generatedHeader !== undefined) cacheEntry.generatedHeader = generatedHeader;
    if (referencedPaths !== undefined) cacheEntry.referencedPaths = referencedPaths;
    if (contentSimhash !== undefined) cacheEntry.contentSimhash = contentSimhash;
    const info = moduleInfos.get(f.path);
    if (info) {
      cacheEntry.moduleInfo = { imports: info.imports, reexports: info.reexports, exportedNames: [...info.exportedNames] };
    }
    newCache.set(f.path, cacheEntry);

    const hist = history.get(f.path);
    const record: FileRecord = {
      path: f.path,
      bytes: f.bytes,
      tokens,
      estimated,
      kind,
      tier,
    };
    if (hist?.lastCommit !== undefined) record.lastCommit = hist.lastCommit;
    if (hist?.commits90d !== undefined) record.commits90d = hist.commits90d;
    if (generatedHeader !== undefined) record.generatedHeader = generatedHeader;
    if (referencedPaths !== undefined) record.referencedPaths = referencedPaths;
    if (contentSimhash !== undefined) record.contentSimhash = contentSimhash;
    // the aggregate orphan/deadExports signals are never cached, only the per-file parse above — see cache/index.ts
    const g = graph.get(f.path);
    if (g) {
      record.orphanModule = g.orphan;
      if (g.deadExports.length > 0) record.deadExportSymbols = g.deadExports;
    }
    return record;
  });
  mark("measure loop (runPool)", t);

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
