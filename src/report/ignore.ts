// --emit-ignore output — ARCHITECTURE.md §8.
//
// This deliberately produces a patch instead of editing the scanned repo.
// Sherlock ranks recommendations; applying one stays an explicit user action.

import type { Finding } from "../types.js";

export const IGNORE_FILES = [".claudeignore", ".cursorignore"] as const;

/**
 * Return a deterministic unified diff which adds every path with an `ignore`
 * recommendation that is not already present in the target ignore file.
 */
export function renderIgnorePatch(
  existing: string | undefined,
  findings: Finding[],
  ignoreFile: string = ".claudeignore",
): string {
  const known = new Set(
    (existing ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  const additions = [...new Set(findings.filter((f) => f.suggest === "ignore").map((f) => f.path))]
    .filter((path) => !known.has(path))
    .sort((a, b) => a.localeCompare(b));

  if (additions.length === 0) return "";

  const oldLines = existing === undefined ? 0 : existing.split(/\r?\n/).filter((_, i, lines) => i < lines.length - 1 || lines[i] !== "").length;
  const header = existing === undefined
    ? `--- /dev/null\n+++ b/${ignoreFile}\n@@ -0,0 +1,${additions.length} @@`
    : `--- a/${ignoreFile}\n+++ b/${ignoreFile}\n@@ -1,${oldLines} +1,${oldLines + additions.length} @@`;
  const context = existing === undefined ? [] : existing.replace(/\r?\n$/, "").split(/\r?\n/).map((line) => ` ${line}`);
  return `${header}\n${[...context, ...additions.map((path) => `+${path}`)].join("\n")}\n`;
}
