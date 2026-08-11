// Doc link extraction — ARCHITECTURE.md §6, `stale-doc` detector's signal
// source ("resolved-path hit rate").
//
// Runs during measure/ against the head sample already read for
// tokenization, same pattern as header.ts — extracts markdown link targets,
// resolves them against the doc's own path, and hands the detector a plain
// list of candidate repo-relative paths. The detector does the actual
// existence check (it has the full FileRecord[] to check against); this
// module only knows how to read links out of markdown.

import { resolveRelative } from "../util/posix-path.js";

const LINK_RE = /\]\(([^)]+)\)/g;

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

/** Raw (unresolved) relative link targets found in markdown link syntax `[text](target)`. */
export function extractLinkTargets(content: string): string[] {
  const targets: string[] = [];
  for (const m of content.matchAll(LINK_RE)) {
    let raw = m[1]?.trim();
    if (!raw) continue;
    const spaceIdx = raw.search(/\s/); // strip an optional `"Title"` suffix
    if (spaceIdx !== -1) raw = raw.slice(0, spaceIdx);
    if (raw.startsWith("#")) continue; // in-page anchor, not a path
    if (isExternal(raw)) continue;
    const hashIdx = raw.indexOf("#");
    const pathPart = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
    if (pathPart !== "") targets.push(pathPart);
  }
  return targets;
}

/** Link targets from `content` (the doc at `fromPath`), resolved to repo-relative posix paths. */
export function extractResolvedLinks(content: string, fromPath: string): string[] {
  const resolved: string[] = [];
  for (const raw of extractLinkTargets(content)) {
    const r = resolveRelative(raw, fromPath);
    if (r) resolved.push(r);
  }
  return resolved;
}
