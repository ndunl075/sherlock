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
import { loadHistory, isGitRepo } from "./history/index.js";
import { runAll } from "./detect/index.js";
import { computeRollup, type Rollup } from "./score/index.js";
import { DEFAULT_BUDGET, type Ctx, type FileRecord, type Finding } from "./types.js";

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
}

export async function scan(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const absRoot = path.resolve(root);
  const discovered = await discover(absRoot);

  const kinds = new Map<string, ReturnType<typeof classify>>();
  for (const f of discovered) {
    const sample = needsContentSniff(f.path) ? await sniff(f.absPath) : undefined;
    kinds.set(f.path, classify(f.path, sample));
  }
  const kindOf = (relPath: string) => kinds.get(relPath) ?? "source";

  const tiers = await assignTiers(discovered, kindOf);
  const [history, gitAvailable] = await Promise.all([loadHistory(absRoot), isGitRepo(absRoot)]);

  const files: FileRecord[] = await Promise.all(
    discovered.map(async (f: DiscoveredFile) => {
      const kind = kindOf(f.path);
      const tier = tiers.get(f.path) ?? 1;
      const { tokens, estimated, headSample } = await measureTokens(f, tier, kind);
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
      if (kind === "generated") record.generatedHeader = looksGenerated(headSample);
      if (kind === "doc") {
        const links = extractResolvedLinks(headSample, f.path);
        if (links.length > 0) record.referencedPaths = links;
      }
      return record;
    }),
  );

  const budget = opts.budget ?? DEFAULT_BUDGET;
  const ctx: Ctx = { root: absRoot, gitAvailable, budget };
  const findings = runAll(files, ctx);

  const rollup = computeRollup(files, findings, budget);

  return { root: absRoot, files, findings, rollup };
}
