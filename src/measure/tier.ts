// T0/T1/T2 assignment — ARCHITECTURE.md §1, §3 (measure/tier.ts).
//
// T0 (resident): CLAUDE.md / AGENTS.md / .cursorrules anywhere in the tree,
// plus their `@relative/path.md` imports resolved transitively.
// T2 (ambient): vendored/generated kinds — the tree-noise files nobody reads
// on purpose but that show up in every listing. Everything else is T1.
//
// This is a v1 approximation of §1's ambient tier, which is really about
// directory-listing cost rather than any single file's kind; refine once
// detectors need finer ambient signal.

import { promises as fs } from "node:fs";
import type { FileKind, Tier } from "../types.js";
import type { DiscoveredFile } from "../discover/index.js";
import { resolveRelative } from "../util/posix-path.js";

const RESIDENT_BASENAMES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".cursorrules"]);
const IMPORT_RE = /@([^\s()<>"'`]+\.mdx?)/g;
const AMBIENT_KINDS: ReadonlySet<FileKind> = new Set(["vendored", "generated"]);

export async function assignTiers(
  files: DiscoveredFile[],
  kindOf: (relPath: string) => FileKind,
): Promise<Map<string, Tier>> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const tiers = new Map<string, Tier>();
  const queue: string[] = [];

  for (const f of files) {
    const base = f.path.split("/").pop() ?? f.path;
    if (RESIDENT_BASENAMES.has(base)) {
      tiers.set(f.path, 0);
      queue.push(f.path);
    }
  }

  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) continue;
    const df = byPath.get(cur);
    if (!df) continue;

    let content: string;
    try {
      content = await fs.readFile(df.absPath, "utf8");
    } catch {
      continue;
    }

    for (const m of content.matchAll(IMPORT_RE)) {
      const raw = m[1];
      if (!raw) continue;
      const resolved = resolveRelative(raw, cur);
      if (resolved && byPath.has(resolved) && tiers.get(resolved) !== 0) {
        tiers.set(resolved, 0);
        queue.push(resolved);
      }
    }
  }

  for (const f of files) {
    if (tiers.has(f.path)) continue;
    tiers.set(f.path, AMBIENT_KINDS.has(kindOf(f.path)) ? 2 : 1);
  }

  return tiers;
}
