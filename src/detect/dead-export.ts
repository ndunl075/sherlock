// `dead-export` detector — ARCHITECTURE.md §6.
//
// Signal: exported symbol with zero graph inbound edges. Confidence source:
// import graph completeness — v1's graph (graph/) resolves relative
// specifiers for ES module import/export, CommonJS require/module.exports,
// dynamic import(), tsconfig/jsconfig paths, and static Vite/Webpack aliases.
// Bare package imports and dynamic config still look dead; confidence stays
// capped under 1.0.

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
        reason: `${dead.length} exported symbol(s) have zero inbound module-graph references anywhere in this repo (v1)`,
        suggest: "review",
      });
    }
    return findings;
  },
};
