// `bloat-outlier` detector — ARCHITECTURE.md §6.
//
// Signal: tokens in the top 1% for a file's kind. Confidence source:
// distribution — scaled by how far into that top percentile the file sits,
// not a fixed number. Binary files are excluded (their token count is always
// 0; bytes, not tokens, is the relevant measure and isn't this detector's
// job — §5 already reports them as raw bytes).
//
// Skips kinds with too few files to make "top 1%" a meaningful statement;
// one file in a kind is trivially its own 100th percentile.

import type { Detector, FileKind, FileRecord, Finding } from "../types.js";

const MIN_GROUP_SIZE = 20;
const PERCENTILE_THRESHOLD = 0.99;

function percentileRank(tokens: number, sorted: number[]): number {
  // fraction of the group at or below this file's token count
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? 0) <= tokens) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

export const bloatOutlierDetector: Detector = {
  id: "bloat-outlier",
  run(files: FileRecord[]): Finding[] {
    const byKind = new Map<FileKind, number[]>();
    for (const f of files) {
      if (f.kind === "binary") continue;
      const arr = byKind.get(f.kind) ?? [];
      arr.push(f.tokens);
      byKind.set(f.kind, arr);
    }
    for (const arr of byKind.values()) arr.sort((a, b) => a - b);

    const findings: Finding[] = [];
    for (const file of files) {
      if (file.kind === "binary") continue;
      const sorted = byKind.get(file.kind);
      if (!sorted || sorted.length < MIN_GROUP_SIZE) continue;

      const rank = percentileRank(file.tokens, sorted);
      if (rank < PERCENTILE_THRESHOLD) continue;

      const p99Index = Math.floor(sorted.length * PERCENTILE_THRESHOLD);
      const p99Tokens = sorted[Math.min(p99Index, sorted.length - 1)] ?? 0;
      const confidence = Math.max(0.5, Math.min(0.9, 0.5 + (rank - PERCENTILE_THRESHOLD) * 40));

      findings.push({
        path: file.path,
        detector: "bloat-outlier",
        confidence,
        reason: `${file.tokens} tok is in the top 1% of ${file.kind} files in this repo (~${p99Tokens} tok is typical for the ceiling)`,
        suggest: "review",
      });
    }
    return findings;
  },
};
