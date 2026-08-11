// Detector registry — ARCHITECTURE.md §6.
//
// "Adding a detector = one file in detect/ + one line in its registry."
// runAll() is what the pipeline calls; it's the only extension point that
// needs to stay easy (CONTRIBUTING.md).

import type { Ctx, Detector, FileRecord, Finding } from "../types.js";
import { generatedDetector } from "./generated.js";
import { vendoredDetector } from "./vendored.js";
import { t0OverweightDetector } from "./t0-overweight.js";
import { bloatOutlierDetector } from "./bloat-outlier.js";
import { staleDocDetector } from "./stale-doc.js";
import { dupDocDetector } from "./dup-doc.js";

export const detectors: Detector[] = [
  generatedDetector,
  vendoredDetector,
  t0OverweightDetector,
  bloatOutlierDetector,
  staleDocDetector,
  dupDocDetector,
  // one line per new detector — see CONTRIBUTING.md
];

export function runAll(files: FileRecord[], ctx: Ctx): Finding[] {
  const findings: Finding[] = [];
  for (const detector of detectors) {
    findings.push(...detector.run(files, ctx));
  }
  return findings;
}
