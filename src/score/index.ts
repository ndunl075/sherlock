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

  for (const f of files) {
    if (f.tier === 0) residentTokens += f.tokens;
    else if (f.tier === 1) reachableTokens += f.tokens;
    else ambientTokens += f.tokens;

    const w = waste(f, findings, cadence);
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
