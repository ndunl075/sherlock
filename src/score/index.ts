// Waste model, ranking, budget rollups — ARCHITECTURE.md §7.
//
// waste(f) = tokens(f) × maxConfidence(findings(f)) × cadence(tier(f))
//
// cadence defaults to DEFAULT_CADENCE but is a computeRollup() parameter —
// §7 calls the weights "config, not constants" and .sherlockrc (config/) can
// override them per repo.

import { DEFAULT_BUDGET, DEFAULT_CADENCE, type FileRecord, type Finding, type Tier } from "../types.js";

export function maxConfidence(path: string, findings: Finding[]): number {
  let max = 0;
  for (const f of findings) {
    if (f.path === path && f.confidence > max) max = f.confidence;
  }
  return max;
}

export function waste(file: FileRecord, findings: Finding[], cadence: Record<Tier, number> = DEFAULT_CADENCE): number {
  return file.tokens * maxConfidence(file.path, findings) * cadence[file.tier];
}

export interface Rollup {
  fileCount: number;
  residentTokens: number;
  reachableTokens: number;
  ambientTokens: number;
  budget: number;
  overBudget: boolean;
  overagePct: number;
  /** files ranked by waste(), highest first — empty until detectors exist */
  ranked: { path: string; waste: number }[];
  recoverableTokens: number;
}

/** One max-confidence-per-path pass over findings, so computeRollup() is O(files + findings) instead of O(files × findings). */
function maxConfidenceByPath(findings: Finding[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const f of findings) {
    const cur = map.get(f.path) ?? 0;
    if (f.confidence > cur) map.set(f.path, f.confidence);
  }
  return map;
}

export function computeRollup(
  files: FileRecord[],
  findings: Finding[],
  budget: number = DEFAULT_BUDGET,
  cadence: Record<Tier, number> = DEFAULT_CADENCE,
): Rollup {
  let residentTokens = 0;
  let reachableTokens = 0;
  let ambientTokens = 0;

  const ranked: { path: string; waste: number }[] = [];

  // Found by the §9 benchmark: calling waste()/maxConfidence() per file here
  // re-scans the entire findings array every time. On a repo where most
  // files get flagged (e.g. every file orphaned because none import each
  // other), files × findings is billions of iterations — a JS "hang" that's
  // really just a real, deterministic O(n²) computation finishing very slowly.
  const confByPath = maxConfidenceByPath(findings);

  for (const f of files) {
    if (f.tier === 0) residentTokens += f.tokens;
    else if (f.tier === 1) reachableTokens += f.tokens;
    else ambientTokens += f.tokens;

    const w = f.tokens * (confByPath.get(f.path) ?? 0) * cadence[f.tier];
    if (w > 0) ranked.push({ path: f.path, waste: w });
  }

  ranked.sort((a, b) => b.waste - a.waste);
  // waste() applies a fractional cadence weight, so the sum needs rounding — token counts are
  // otherwise always whole numbers throughout FileRecord/Rollup.
  const recoverableTokens = Math.round(ranked.reduce((sum, r) => sum + r.waste, 0));

  const overBudget = residentTokens > budget;
  const overagePct = budget > 0 ? Math.round(((residentTokens - budget) / budget) * 100) : 0;

  return {
    fileCount: files.length,
    residentTokens,
    reachableTokens,
    ambientTokens,
    budget,
    overBudget,
    overagePct,
    ranked,
    recoverableTokens,
  };
}
