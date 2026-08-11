// `cold-and-costly` detector — ARCHITECTURE.md §6.
//
// Signal: large, untouched >180d, not an entrypoint. Confidence source: git
// history depth (FileRecord.lastCommit, from history/). Files git has never
// seen are skipped outright — "cold" is a claim about history, and there's
// none to make it from.
//
// Entrypoint exclusion uses the shared basename allowlist plus any paths
// declared in package.json main/bin/exports (passed via Ctx.packageEntrypoints).

import type { Ctx, Detector, FileRecord, Finding } from "../types.js";
import { isLikelyEntrypointFile } from "../util/entrypoints.js";

const COLD_DAYS = 180;
const COLD_SECONDS = COLD_DAYS * 24 * 60 * 60;
const LARGE_TOKEN_THRESHOLD = 1000;

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
      if (isLikelyEntrypointFile(file) || ctx?.packageEntrypoints?.has(file.path)) continue;

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
