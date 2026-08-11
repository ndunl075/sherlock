// `stale-doc` detector — ARCHITECTURE.md §6.
//
// Signal: doc references paths that no longer exist. Confidence source:
// resolved-path hit rate — the fraction of a doc's links that don't resolve
// against the repo's actual file set, computed here (the detector, not
// measure/, decides what "stale" means); measure/links.ts only extracts and
// resolves the candidate paths onto FileRecord.referencedPaths.

import type { Detector, FileRecord, Finding } from "../types.js";

export const staleDocDetector: Detector = {
  id: "stale-doc",
  run(files: FileRecord[]): Finding[] {
    const knownPaths = new Set(files.map((f) => f.path));
    const findings: Finding[] = [];

    for (const file of files) {
      const refs = file.referencedPaths;
      if (!refs || refs.length === 0) continue;

      const missing = refs.filter((p) => !knownPaths.has(p));
      if (missing.length === 0) continue;

      const missRate = missing.length / refs.length;
      const confidence = Math.max(0.4, Math.min(0.95, 0.4 + missRate * 0.55));

      findings.push({
        path: file.path,
        detector: "stale-doc",
        confidence,
        reason: `references ${missing.length} of ${refs.length} linked path(s) that no longer exist in this repo`,
        suggest: "review",
      });
    }

    return findings;
  },
};
