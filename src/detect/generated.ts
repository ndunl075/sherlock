// `generated` detector — ARCHITECTURE.md §6.
//
// Signal: lockfiles, dist/, *.min.*, *.pb.*, snapshots, migrations (already
// folded into FileRecord.kind by classify/) plus a generated-file header
// banner (FileRecord.generatedHeader, precomputed by measure/header.ts).
// Confidence source: path + header sniff — combined below, no I/O here.
//
// Per CONTRIBUTING.md's rules for detectors: pure over (files, ctx), no fs/
// child_process/network, and `reason` is built from templates + metadata
// only — never file content.

import type { Detector, FileRecord, Finding } from "../types.js";

const PATH_ONLY_CONFIDENCE = 0.75;
const PATH_PLUS_HEADER_CONFIDENCE = 0.97;

function reasonFor(file: FileRecord): string {
  if (file.generatedHeader) return "generated file — path pattern and a generated-file header banner";
  return "generated file — matches a known lockfile/build-output path pattern";
}

export const generatedDetector: Detector = {
  id: "generated",
  run(files: FileRecord[]): Finding[] {
    const findings: Finding[] = [];
    for (const file of files) {
      if (file.kind !== "generated") continue;
      const confidence = file.generatedHeader ? PATH_PLUS_HEADER_CONFIDENCE : PATH_ONLY_CONFIDENCE;
      findings.push({
        path: file.path,
        detector: "generated",
        confidence,
        reason: reasonFor(file),
        suggest: "ignore",
      });
    }
    return findings;
  },
};
