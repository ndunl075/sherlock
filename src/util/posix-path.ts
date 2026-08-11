// Shared posix-relative-path helpers. FileRecord.path is always repo-relative
// posix (§4), so every module that resolves one path against another —
// @import resolution in measure/tier.ts, link resolution in detect/stale-doc.ts —
// needs the same normalize/dirname logic. One place for it.

export function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
}

/** Resolve a reference found inside `fromPath` (repo-relative, posix) against that file's directory. */
export function resolveRelative(raw: string, fromPath: string): string | null {
  if (raw.startsWith("~")) return null; // home-relative — outside repo scope
  if (raw.startsWith("/")) return normalizePosix(raw.slice(1));
  return normalizePosix(`${dirOf(fromPath)}/${raw}`);
}
