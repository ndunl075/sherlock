// Import/require graph — ARCHITECTURE.md §3 (graph/), feeding
// dead-export and orphan-module.
//
// Graph needs full file text (exports/imports can appear anywhere, not just
// measure/'s 4KB head sample). The pipeline measures exact-eligible files
// first and passes that in-memory text via GraphInput.source so this module
// does not re-read those paths. Files still missing source (large sampled
// ones, or callers that didn't pre-measure) are read here. Cache hits via
// getCached skip both.
//
// The per-file parse (ModuleInfo — what one file imports/exports) is a pure
// function of that file's own content, exactly as cacheable as tokens; only
// the *aggregate* signals below (orphan, deadExports — reachability and
// usage computed across every file's edges together) can't be, per
// cache/index.ts's header. getCached lets the pipeline skip the read+parse
// on a cache hit while still recomputing the aggregate fresh every run —
// caught by benchmarking: without this, a "warm" scan on a JS/TS-heavy repo
// wasn't meaningfully faster than cold, because this was still re-reading
// and re-parsing every eligible file regardless of cache state.

import { promises as fs } from "node:fs";
import { parseModule, isGraphEligibleExt, type ModuleInfo } from "./parse.js";
import { resolveRelative } from "../util/posix-path.js";
import { isLikelyEntrypoint } from "../util/entrypoints.js";
import { runPool } from "../util/pool.js";
import type { Tier } from "../types.js";

export interface GraphSignal {
  /** unreachable from any inferred entrypoint via import/require edges */
  orphan: boolean;
  /** exported symbol names with zero inbound references anywhere in the repo */
  deadExports: string[];
}

export interface GraphInput {
  path: string;
  absPath: string;
  tier: Tier;
  bytes: number;
  mtimeMs: number;
  /** In-memory full text from an earlier exact measure — skips the disk read when set */
  source?: string;
}

export interface GraphResult {
  signals: Map<string, GraphSignal>;
  /** every graph-eligible file's parsed ModuleInfo (fresh or cache-reused) — the caller persists these for next run */
  moduleInfos: Map<string, ModuleInfo>;
}

export interface BuildGraphOptions {
  getCached?: (path: string, bytes: number, mtimeMs: number) => ModuleInfo | undefined;
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

// TypeScript's NodeNext module resolution writes import specifiers with a
// ".js" extension that resolve against a ".ts" source file on disk (this
// repo's own source does this everywhere: "./types.js" -> types.ts). Without
// this, every such import would fail to resolve and every imported file
// would read as orphaned — which is exactly what a self-scan first caught.
const JS_TO_TS_EXT: Record<string, string> = { ".js": ".ts", ".jsx": ".tsx", ".mjs": ".ts", ".cjs": ".ts" };

function swapToTsExtension(base: string): string | undefined {
  for (const [jsExt, tsExt] of Object.entries(JS_TO_TS_EXT)) {
    if (base.endsWith(jsExt)) return base.slice(0, -jsExt.length) + tsExt;
  }
  return undefined;
}

function extnameOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

function resolveSpecifier(spec: string, fromPath: string, knownPaths: ReadonlySet<string>): string | undefined {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined; // bare/aliased specifier — not resolved in v1
  const base = resolveRelative(spec, fromPath);
  if (!base) return undefined;
  if (knownPaths.has(base)) return base;

  const tsSwap = swapToTsExtension(base);
  if (tsSwap && knownPaths.has(tsSwap)) return tsSwap;

  for (const ext of RESOLVE_EXTS) {
    if (knownPaths.has(base + ext)) return base + ext;
    const indexed = `${base}/index${ext}`;
    if (knownPaths.has(indexed)) return indexed;
  }
  return undefined;
}

export async function buildGraph(files: GraphInput[], opts: BuildGraphOptions = {}): Promise<GraphResult> {
  const eligible = files.filter((f) => isGraphEligibleExt(extnameOf(f.path)));
  const knownPaths = new Set(eligible.map((f) => f.path));

  const edges = new Map<string, Set<string>>();
  const exportsByFile = new Map<string, Set<string>>();
  const usedNamesByTarget = new Map<string, Set<string>>();
  const fullyUsed = new Set<string>();
  const moduleInfos = new Map<string, ModuleInfo>();

  const addEdge = (from: string, to: string) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  const addUsed = (target: string, name: string) => {
    if (!usedNamesByTarget.has(target)) usedNamesByTarget.set(target, new Set());
    usedNamesByTarget.get(target)!.add(name);
  };

  // Concurrent, bounded — a plain `for...of` with `await` inside here was
  // measured at ~31s of a ~41s cold scan on a 50k-file benchmark (§9),
  // entirely I/O wait with nothing overlapping it. Fully unbounded
  // Promise.all was the first fix and is wrong in a different way: at 48k
  // files it hit EMFILE on 83% of reads, silently — each failure degrades to
  // "this file contributes nothing," a wrong dead-export/orphan-module
  // answer, not just a slow one. runPool keeps concurrency high without
  // crossing that ceiling. Every map/set mutation below happens synchronously
  // once a given file's read+parse resolves, so interleaving is otherwise
  // safe: each file only touches its own moduleInfos/exportsByFile key, and
  // addEdge/addUsed are plain synchronous Map/Set operations.
  await runPool(eligible, async (file) => {
    let info = opts.getCached?.(file.path, file.bytes, file.mtimeMs);
    if (!info) {
      let source = file.source;
      if (source === undefined) {
        try {
          source = await fs.readFile(file.absPath, "utf8");
        } catch {
          return; // unreadable — degrade, this file just contributes no graph data
        }
      }
      const parsed = parseModule(source, extnameOf(file.path));
      if (!parsed) return;
      info = parsed;
    }

    moduleInfos.set(file.path, info);
    exportsByFile.set(file.path, info.exportedNames);

    for (const imp of info.imports) {
      const target = resolveSpecifier(imp.source, file.path, knownPaths);
      if (!target) continue;
      addEdge(file.path, target);
      if (imp.namespace) fullyUsed.add(target);
      for (const name of imp.names) addUsed(target, name);
    }
    for (const re of info.reexports) {
      const target = resolveSpecifier(re.source, file.path, knownPaths);
      if (!target) continue;
      addEdge(file.path, target);
      if (re.star) fullyUsed.add(target);
      for (const name of re.names) addUsed(target, name);
    }
  });

  // reachability BFS from every inferred entrypoint, over the eligible set only
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const file of eligible) {
    if (isLikelyEntrypoint(file.path, file.tier)) {
      reachable.add(file.path);
      queue.push(file.path);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) continue;
    for (const next of edges.get(cur) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  const result = new Map<string, GraphSignal>();
  for (const file of eligible) {
    const isEntrypoint = isLikelyEntrypoint(file.path, file.tier);
    const orphan = !isEntrypoint && !reachable.has(file.path);

    const exported = exportsByFile.get(file.path);
    let deadExports: string[] = [];
    if (exported && exported.size > 0 && !isEntrypoint && !fullyUsed.has(file.path)) {
      const used = usedNamesByTarget.get(file.path);
      deadExports = [...exported].filter((name) => !used?.has(name));
    }

    result.set(file.path, { orphan, deadExports });
  }

  return { signals: result, moduleInfos };
}
