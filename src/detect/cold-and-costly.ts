// `cold-and-costly` detector — ARCHITECTURE.md §6.
//
// Signal: large, untouched >180d, not an entrypoint. Confidence source: git
// history depth (FileRecord.lastCommit, from history/). Files git has never
// seen are skipped outright — "cold" is a claim about history, and there's
// none to make it from.
//
// "Not an entrypoint" has no import graph to check against yet (that's
// dead-export/orphan-module's job, deferred — §10 flags tree-sitter as a new
// dependency worth a deliberate call before it lands). v1 approximates it
// with a basename allowlist plus tier 0, which is what's available without
// one — noted as provisional, same as dup-doc's threshold.

import type { Ctx, Detector, FileRecord, Finding } from "../types.js";

const COLD_DAYS = 180;
const COLD_SECONDS = COLD_DAYS * 24 * 60 * 60;
const LARGE_TOKEN_THRESHOLD = 1000;

const ENTRYPOINT_BASENAMES = new Set([
  "index.ts", "index.js", "index.mjs", "index.cjs",
  "main.ts", "main.js", "main.py", "main.go", "main.rs",
  "__init__.py", "cli.ts", "cli.js", "app.ts", "app.js", "server.ts", "server.js",
]);

function isLikelyEntrypoint(file: FileRecord): boolean {
  if (file.tier === 0) return true; // resident files are a different detector's concern, never flagged here
  const base = file.path.split("/").pop() ?? file.path;
  return ENTRYPOINT_BASENAMES.has(base);
}

export const coldAndCostlyDetector: Detector = {
  id: "cold-and-costly",
  run(files: FileRecord[], ctx?: Ctx): Finding[] {
    const now = ctx?.now ?? Math.floor(Date.now() / 1000);
    const findings: Finding[] = [];

    for (const file of files) {
      if (file.kind === "binary") continue; // bytes, not tokens, is the relevant measure — not this detector's job
      if (file.tokens < LARGE_TOKEN_THRESHOLD) continue;
      if (file.lastCommit === undefined) continue;

      const ageSeconds = now - file.lastCommit;
      if (ageSeconds < COLD_SECONDS) continue;
      if (isLikelyEntrypoint(file)) continue;

      const ageDays = Math.floor(ageSeconds / 86_400);
      const ageBonus = Math.min(0.3, ((ageDays - COLD_DAYS) / 365) * 0.3);
      const sizeBonus = Math.min(0.15, file.tokens / 10_000);
      const confidence = Math.max(0.4, Math.min(0.85, 0.4 + ageBonus + sizeBonus));

      findings.push({
        path: file.path,
        detector: "cold-and-costly",
        confidence,
        reason: `${file.tokens} tok, untouched for ~${ageDays} days, no known-entrypoint filename`,
        suggest: "review",
      });
    }

    return findings;
  },
};
