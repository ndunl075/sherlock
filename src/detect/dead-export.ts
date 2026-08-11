// `dead-export` detector — ARCHITECTURE.md §6.
//
// Signal: exported symbol with zero graph inbound edges. Confidence source:
// import graph completeness — v1's graph (graph/) only resolves relative
// specifiers and ES module syntax (no require(), no dynamic import(), no
// path aliases), so a symbol used only through one of those reads as dead.
// Confidence scales with how many dead symbols a file has (more of them
// dead reads as a stronger signal than one oddly-unused symbol) and stays
// capped well under 1.0 for the graph-completeness caveat above.

import type { Detector, FileRecord, Finding } from "../types.js";

const BASE_CONFIDENCE = 0.5;
const PER_SYMBOL_BONUS = 0.08;
const MAX_CONFIDENCE = 0.8;

export const deadExportDetector: Detector = {
  id: "dead-export",
  run(files: FileRecord[]): Finding[] {
    const findings: Finding[] = [];
    for (const file of files) {
      const dead = file.deadExportSymbols;
      if (!dead || dead.length === 0) continue;

      const confidence = Math.min(MAX_CONFIDENCE, BASE_CONFIDENCE + dead.length * PER_SYMBOL_BONUS);
      findings.push({
        path: file.path,
        detector: "dead-export",
        confidence,
        reason: `${dead.length} exported symbol(s) have zero inbound references anywhere in this repo (relative imports only, v1)`,
        suggest: "review",
      });
    }
    return findings;
  },
};
