// Import/require graph — ARCHITECTURE.md §3 (graph/), feeding
// dead-export and orphan-module.
//
// This does its own full-content read per graph-eligible file rather than
// reusing measure/'s head sample: exports and import statements can appear
// anywhere in a file, not just the first 4KB, and getting that wrong would
// make dead-export's signal actively misleading. It's the one deliberate
// second read pass in the pipeline — see graph/parse.ts for the rest of the
// v1 scope trade-offs (relative imports only, no require()/dynamic import).

import { promises as fs } from "node:fs";
import { parseModule, isGraphEligibleExt } from "./parse.js";
import { resolveRelative } from "../util/posix-path.js";
import { isLikelyEntrypoint } from "../util/entrypoints.js";
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

export async function buildGraph(files: GraphInput[]): Promise<Map<string, GraphSignal>> {
  const eligible = files.filter((f) => isGraphEligibleExt(extnameOf(f.path)));
  const knownPaths = new Set(eligible.map((f) => f.path));

  const edges = new Map<string, Set<string>>();
  const exportsByFile = new Map<string, Set<string>>();
  const usedNamesByTarget = new Map<string, Set<string>>();
  const fullyUsed = new Set<string>();

  const addEdge = (from: string, to: string) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  const addUsed = (target: string, name: string) => {
    if (!usedNamesByTarget.has(target)) usedNamesByTarget.set(target, new Set());
    usedNamesByTarget.get(target)!.add(name);
  };

  for (const file of eligible) {
    let source: string;
    try {
      source = await fs.readFile(file.absPath, "utf8");
    } catch {
      continue; // unreadable — degrade, this file just contributes no graph data
    }

    const info = parseModule(source, extnameOf(file.path));
    if (!info) continue;
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
  }

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

  return result;
}
