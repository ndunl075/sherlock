// TTY report — ARCHITECTURE.md §8.
//
// Falls back to a "biggest resident files" listing when no detector fires on
// this repo (findings is empty) so the report stays useful either way.

import type { FileRecord, Finding, Suggestion } from "../types.js";
import type { Rollup } from "../score/index.js";

const BAR_WIDTH = 10;

function formatTokens(n: number): string {
  const rounded = Math.round(n);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M`;
  if (rounded >= 100_000) return `${Math.round(rounded / 1000)}k`;
  return rounded.toLocaleString("en-US");
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
      `${pad("Top trim", 18)}${formatTokens(rollup.recoverableTokens)} tok recoverable across ${rollup.ranked.length} file${rollup.ranked.length === 1 ? "" : "s"}`,
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
    const groups = new Map<Suggestion, Array<{ path: string; detector: string; confidence: number; reason: string }>>();
    for (const r of rollup.ranked.slice(0, 20)) {
      const top = findings.filter((f) => f.path === r.path).sort((a, b) => b.confidence - a.confidence)[0];
      if (!top) continue;
      const group = groups.get(top.suggest) ?? [];
      group.push({ path: r.path, detector: top.detector, confidence: top.confidence, reason: top.reason });
      groups.set(top.suggest, group);
    }
    for (const suggest of ["ignore", "split", "delete", "review"] as const) {
      const group = groups.get(suggest);
      if (!group || group.length === 0) continue;
      lines.push(`  ${suggest.toUpperCase()}`);
      lines.push(`  ${pad("PATH", 50)}${pad("DETECTOR", 16)}${pad("CONF", 6)}REASON`);
      for (const top of group) {
      lines.push(
          `  ${pad(top.path, 50)}${pad(top.detector, 16)}${pad(top.confidence.toFixed(2), 6)}${top.reason}`,
      );
      }
    }
  }

  return lines.join("\n");
}
