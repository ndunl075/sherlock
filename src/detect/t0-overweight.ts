// `t0-overweight` detector — ARCHITECTURE.md §6.
//
// Signal: a single resident (tier 0) file eating a large share of the
// resident budget by itself. Confidence source: exact — this is a plain
// token-count-vs-threshold comparison, no sampling or heuristics involved.

import { DEFAULT_BUDGET, type Detector, type FileRecord, type Finding } from "../types.js";

/** A single T0 file above this fraction of the resident budget is flagged. */
const PER_FILE_BUDGET_FRACTION = 0.3;

function confidenceFor(tokens: number, threshold: number): number {
  const overBy = tokens / threshold - 1; // 0 at the threshold, 1.0 at 2x threshold, etc.
  return Math.max(0.5, Math.min(0.95, 0.5 + overBy * 0.25));
}

export const t0OverweightDetector: Detector = {
  id: "t0-overweight",
  run(files: FileRecord[], ctx): Finding[] {
    const budget = ctx?.budget ?? DEFAULT_BUDGET;
    const threshold = budget * PER_FILE_BUDGET_FRACTION;
    const findings: Finding[] = [];

    for (const file of files) {
      if (file.tier !== 0 || file.tokens <= threshold) continue;
      const pct = Math.round((file.tokens / budget) * 100);
      findings.push({
        path: file.path,
        detector: "t0-overweight",
        confidence: confidenceFor(file.tokens, threshold),
        reason: `resident file alone uses ~${pct}% of the ${budget}-token resident budget`,
        suggest: "split",
      });
    }

    return findings;
  },
};
