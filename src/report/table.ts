// TTY report — ARCHITECTURE.md §8.
//
// Detectors aren't wired yet, so the ranked findings tables from the README
// mockup are empty; this renders the rollup plus a "biggest resident files"
// fallback so the report is still useful before detect/ exists.

import type { FileRecord, Finding } from "../types.js";
import type { Rollup } from "../score/index.js";

const BAR_WIDTH = 10;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString("en-US");
}

function bar(resident: number, budget: number): string {
  const ratio = budget > 0 ? resident / budget : 0;
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(ratio * BAR_WIDTH)));
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function renderTable(rollup: Rollup, files: FileRecord[], findings: Finding[]): string {
  const lines: string[] = [];

  const sign = rollup.overagePct >= 0 ? "+" : "";
  lines.push(
    `${pad("Resident context", 18)}${pad(`${formatTokens(rollup.residentTokens)} tok`, 12)}${bar(
      rollup.residentTokens,
      rollup.budget,
    )}  (budget ${formatTokens(rollup.budget)} tok)  ${sign}${rollup.overagePct}%`,
  );
  lines.push(`${pad("Repo reachable", 18)}${formatTokens(rollup.reachableTokens)} tok`);
  if (rollup.ambientTokens > 0) {
    lines.push(`${pad("Ambient noise", 18)}${formatTokens(rollup.ambientTokens)} tok`);
  }
  if (findings.length > 0) {
    lines.push(
      `${pad("Top trim", 18)}${formatTokens(rollup.recoverableTokens)} tok recoverable across ${rollup.ranked.length} files`,
    );
  }
  lines.push("");

  if (findings.length === 0) {
    lines.push("No detectors registered yet — showing resident files by token cost.");
    const resident = files
      .filter((f) => f.tier === 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 20);
    if (resident.length === 0) {
      lines.push("(no T0 resident files found — no CLAUDE.md / AGENTS.md / .cursorrules in this tree)");
    } else {
      lines.push("");
      lines.push(`  ${pad("RESIDENT", 50)}tokens`);
      for (const f of resident) {
        lines.push(`  ${pad(f.path, 50)}${formatTokens(f.tokens)}${f.estimated ? " ~" : ""}`);
      }
    }
  } else {
    lines.push(`  ${pad("PATH", 50)}${pad("DETECTOR", 16)}${pad("CONF", 6)}REASON`);
    for (const r of rollup.ranked.slice(0, 20)) {
      const top = findings.filter((f) => f.path === r.path).sort((a, b) => b.confidence - a.confidence)[0];
      if (!top) continue;
      lines.push(
        `  ${pad(r.path, 50)}${pad(top.detector, 16)}${pad(top.confidence.toFixed(2), 6)}${top.reason}`,
      );
    }
  }

  return lines.join("\n");
}
