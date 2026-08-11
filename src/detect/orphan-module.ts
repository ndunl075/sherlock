// `orphan-module` detector — ARCHITECTURE.md §6.
//
// Signal: file unreachable from any entrypoint. Confidence source:
// entrypoint inference quality — capped moderate here on purpose, since v1's
// entrypoint set (graph/, util/entrypoints.ts) is a basename allowlist, not
// package.json main/bin or tsconfig resolution. A real entrypoint with an
// unconventional name reads as orphaned; that's the false-positive shape
// this detector's confidence is admitting to.

import type { Detector, FileRecord, Finding } from "../types.js";

const CONFIDENCE = 0.55;

export const orphanModuleDetector: Detector = {
  id: "orphan-module",
  run(files: FileRecord[]): Finding[] {
    const findings: Finding[] = [];
    for (const file of files) {
      if (!file.orphanModule) continue;
      findings.push({
        path: file.path,
        detector: "orphan-module",
        confidence: CONFIDENCE,
        reason: "unreachable from any inferred entrypoint via relative import edges",
        suggest: "review",
      });
    }
    return findings;
  },
};
