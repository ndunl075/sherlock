// Pipeline — ARCHITECTURE.md §2.
//
//   discover ─→ classify ─→ measure ─→ detect ─→ score ─→ report
//
// Single pass over the tree; everything downstream of discover() operates on
// the same in-memory FileRecord[]. detect/ is empty in this slice (no
// detectors registered yet) — findings is always [] until that lands.

import { promises as fs } from "node:fs";
import path from "node:path";
import { discover, type DiscoveredFile } from "./discover/index.js";
import { classify, needsContentSniff } from "./classify/index.js";
import { assignTiers } from "./measure/tier.js";
import { measureTokens } from "./measure/tokens.js";
import { loadHistory } from "./history/index.js";
import { computeRollup, type Rollup } from "./score/index.js";
import { DEFAULT_BUDGET, type FileRecord, type Finding } from "./types.js";

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
  const history = await loadHistory(absRoot);

  const files: FileRecord[] = await Promise.all(
    discovered.map(async (f: DiscoveredFile) => {
      const kind = kindOf(f.path);
      const tier = tiers.get(f.path) ?? 1;
      const { tokens, estimated } = await measureTokens(f, tier, kind);
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
      return record;
    }),
  );

  // detect/ — no detectors registered yet
  const findings: Finding[] = [];

  const rollup = computeRollup(files, findings, opts.budget ?? DEFAULT_BUDGET);

  return { root: absRoot, files, findings, rollup };
}
