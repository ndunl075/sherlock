// `vendored` detector — ARCHITECTURE.md §6.
//
// Signal: committed deps, bundled SDKs (already folded into FileRecord.kind
// by classify/). Confidence source: path + no-git-churn — a vendored file
// that's never touched is almost certainly an inert bundle; one with recent
// commits might be hand-patched in place, which is a smell but not the same
// claim, so it gets a lower confidence rather than being excluded.

import type { Detector, FileRecord, Finding } from "../types.js";

const NO_CHURN_CONFIDENCE = 0.9;
const PATH_ONLY_CONFIDENCE = 0.7;
const RECENTLY_CHURNED_CONFIDENCE = 0.45;

function classify(file: FileRecord): { confidence: number; reason: string } {
  if (file.commits90d === undefined || file.commits90d === 0) {
    return {
      confidence: file.lastCommit === undefined ? PATH_ONLY_CONFIDENCE : NO_CHURN_CONFIDENCE,
      reason:
        file.lastCommit === undefined
          ? "vendored path, untracked by git"
          : "vendored path, no commits in the last 90 days",
    };
  }
  return {
    confidence: RECENTLY_CHURNED_CONFIDENCE,
    reason: "vendored path, but recently modified — may be hand-patched rather than untouched",
  };
}

export const vendoredDetector: Detector = {
  id: "vendored",
  run(files: FileRecord[]): Finding[] {
    const findings: Finding[] = [];
    for (const file of files) {
      if (file.kind !== "vendored") continue;
      const { confidence, reason } = classify(file);
      findings.push({ path: file.path, detector: "vendored", confidence, reason, suggest: "ignore" });
    }
    return findings;
  },
};
