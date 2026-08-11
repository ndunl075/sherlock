// Repo walk — ARCHITECTURE.md §3 (discover/) and §12 (security model).
//
// git-aware: honors .gitignore/.claudeignore/.cursorignore stacked per
// directory, plus a baseline ignore list (§discover/ignore.ts) so scanning a
// repo that hasn't gitignored node_modules doesn't choke.
//
// Security invariants enforced here (SECURITY.md):
//  - symlinks are never followed outside the resolved repo root
//  - reads are bounded: max walk depth, max file count — a symlink cycle or a
//    pathologically deep tree degrades the report, it doesn't hang the process

import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { baselineRules, isIgnored, parseIgnoreFile, type IgnoreRule } from "./ignore.js";

export interface DiscoveredFile {
  /** repo-relative, posix separators */
  path: string;
  /** absolute, OS-native separators — for reading only, never surfaced in output */
  absPath: string;
  bytes: number;
  /** mtime in epoch ms — cache/'s invalidation key alongside path+bytes */
  mtimeMs: number;
}

export interface DiscoverOptions {
  maxDepth?: number;
  maxFiles?: number;
  /** Files above this size are skipped before any downstream reader sees them. */
  maxFileBytes?: number;
  /** Total size of discovered files; later files are skipped once this is reached. */
  maxTotalBytes?: number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_FILES = 200_000;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".claudeignore", ".cursorignore"];

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

async function loadDirRules(absDir: string, relDir: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const name of IGNORE_FILE_NAMES) {
    try {
      const content = await fs.readFile(path.join(absDir, name), "utf8");
      rules.push(...parseIgnoreFile(content, relDir));
    } catch {
      // absent or unreadable — fine, not every dir has one
    }
  }
  return rules;
}

export async function discover(root: string, opts: DiscoverOptions = {}): Promise<DiscoveredFile[]> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const absRoot = await fs.realpath(path.resolve(root));

  const results: DiscoveredFile[] = [];
  let totalBytes = 0;
  const visitedReal = new Set<string>([absRoot]);

  type Frame = { absDir: string; relDir: string; depth: number; rules: IgnoreRule[] };
  const stack: Frame[] = [{ absDir: absRoot, relDir: "", depth: 0, rules: baselineRules() }];

  while (stack.length > 0) {
    if (results.length >= maxFiles) break;
    const frame = stack.pop();
    if (!frame) break;
    const { absDir, relDir, depth, rules } = frame;

    const ownRules = await loadDirRules(absDir, relDir);
    const rulesHere = ownRules.length > 0 ? [...rules, ...ownRules] : rules;

    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue; // permission error etc. — degrade, don't crash the scan
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const entryRel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const entryAbs = path.join(absDir, entry.name);

      let isDir = entry.isDirectory();
      let realAbs = entryAbs;

      if (entry.isSymbolicLink()) {
        try {
          realAbs = await fs.realpath(entryAbs);
        } catch {
          continue; // broken symlink — skip
        }
        const relFromRoot = path.relative(absRoot, realAbs);
        const escapesRoot = relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot);
        if (escapesRoot) continue; // never follow a symlink outside the repo root
        if (visitedReal.has(realAbs)) continue; // cycle guard
        const st = await fs.stat(realAbs).catch(() => null);
        if (!st) continue;
        isDir = st.isDirectory();
      }

      if (isIgnored(rulesHere, entryRel, isDir)) continue;

      if (isDir) {
        if (depth + 1 > maxDepth) continue; // degrade: skip subtree past the depth cap
        visitedReal.add(realAbs);
        stack.push({ absDir: realAbs, relDir: entryRel, depth: depth + 1, rules: rulesHere });
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue; // sockets, FIFOs, etc. — skip
      const st = await fs.stat(realAbs).catch(() => null);
      if (!st || !st.isFile()) continue;
      if (st.size > maxFileBytes || totalBytes + st.size > maxTotalBytes) continue;

      results.push({ path: toPosix(entryRel), absPath: realAbs, bytes: st.size, mtimeMs: st.mtimeMs });
      totalBytes += st.size;
    }
  }

  return results;
}
