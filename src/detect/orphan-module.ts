// `orphan-module` detector — ARCHITECTURE.md §6.
//
// Signal: file unreachable from any entrypoint. Confidence source:
// entrypoint inference quality — basename allowlist + package.json
// main/bin/exports (graph/). Unconventional entrypoints that aren't declared
// still false-positive; confidence stays moderate for that.

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
        reason: "unreachable from any inferred entrypoint via module-graph edges",
        suggest: "review",
      });
    }
    return findings;
  },
};
