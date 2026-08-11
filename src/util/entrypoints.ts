// Entrypoint inference — shared by detect/cold-and-costly.ts and graph/
// (orphan-module's reachability seed set, dead-export's "public API" guard).
//
// No import graph existed when cold-and-costly needed this, so it's a
// basename allowlist rather than anything derived from package.json
// main/bin or tsconfig — same v1 approximation, now shared instead of
// duplicated now that graph/ needs the identical heuristic.

import type { FileRecord, Tier } from "../types.js";

export const ENTRYPOINT_BASENAMES = new Set([
  "index.ts", "index.js", "index.mjs", "index.cjs",
  "main.ts", "main.js", "main.py", "main.go", "main.rs",
  "__init__.py", "cli.ts", "cli.js", "app.ts", "app.js", "server.ts", "server.js",
]);

// Test files are invoked directly by the test runner, never imported by
// other source — the identical "not imported, still not dead" shape as a
// CLI entrypoint. Without this, orphan-module fires on every *.test.ts in a
// repo that follows this convention — caught by running this tool on its
// own source, which is exactly the kind of thing self-hosting catches.
const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/;

export function isLikelyEntrypoint(relPath: string, tier: Tier): boolean {
  if (tier === 0) return true; // resident files are a different concern, never treated as ordinary source
  const base = relPath.split("/").pop() ?? relPath;
  return ENTRYPOINT_BASENAMES.has(base) || TEST_FILE_RE.test(base);
}

export function isLikelyEntrypointFile(file: Pick<FileRecord, "path" | "tier">): boolean {
  return isLikelyEntrypoint(file.path, file.tier);
}
