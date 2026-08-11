// `dup-doc` detector — ARCHITECTURE.md §6.
//
// Signal: near-duplicate prose across *.md. Confidence source: pairwise
// Hamming distance over the 32-bit fingerprints measure/simhash.ts already
// computed (word-shingle simhash). No file content is touched; per §12, the
// detector only ever sees the hash.
//
// v1 is a straight O(n²) pairwise scan, not bucketed — fine for the doc
// counts a repo's *.md tree typically has. Revisit with real bucketing if a
// large repo's doc count ever makes this show up in the §9 perf budget.

import type { Detector, FileRecord, Finding } from "../types.js";
import { hammingDistance } from "../measure/simhash.js";

// Out of 32 bits. Tuned empirically, not derived: with 5-word shingles a
// single edited word already shifts ~8 bits on a short paragraph, while two
// genuinely unrelated docs land close to the ~16-bit random-chance midpoint.
// 10 catches real near-duplicates without drifting into "vaguely similar
// topic" territory — a provisional number pending real-repo validation, per
// CONTRIBUTING.md's "nine detectors is a guess."
const HAMMING_THRESHOLD = 10;

export const dupDocDetector: Detector = {
  id: "dup-doc",
  run(files: FileRecord[]): Finding[] {
    const docs = files.filter(
      (f): f is FileRecord & { contentSimhash: number } => f.kind === "doc" && f.contentSimhash !== undefined,
    );
    const findings: Finding[] = [];

    for (let j = 0; j < docs.length; j++) {
      for (let i = 0; i < j; i++) {
        const a = docs[i];
        const b = docs[j];
        if (!a || !b) continue;
        const dist = hammingDistance(a.contentSimhash, b.contentSimhash);
        if (dist > HAMMING_THRESHOLD) continue;

        const overlapPct = Math.round((1 - dist / 32) * 100);
        const confidence = Math.max(0.5, Math.min(0.95, 1 - dist / 32));
        // earlier file in the discovery order reads as canonical; the later one is flagged as the redundant copy
        findings.push({
          path: b.path,
          detector: "dup-doc",
          confidence,
          reason: `~${overlapPct}% overlap with ${a.path}`,
          suggest: "review",
        });
      }
    }

    return findings;
  },
};
