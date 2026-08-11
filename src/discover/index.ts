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
//
// Directories are processed in parallel batches. A sequential walk was the
// warm-scan bottleneck on the §9 50k-file fixture (~500 dirs × await readdir
// + stats): overlapping directory I/O cuts that without changing the
// ignore/symlink semantics.

import { promises as fs, type Dirent, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { baselineRules, isIgnored, parseIgnoreFile, type IgnoreRule } from "./ignore.js";
import { runPool } from "../util/pool.js";

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
const DIR_CONCURRENCY = Math.max(16, os.cpus().length * 4);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

async function loadDirRules(absDir: string, relDir: string, presentNames: ReadonlySet<string>): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const name of IGNORE_FILE_NAMES) {
    // Only open ignore files that readdir already saw. Blind open-and-catch on
    // every directory is fine on a handful of dirs and catastrophic on a 50k-
    // file tree (hundreds of dirs × 3 failed opens), especially on Windows
    // where ENOENT is expensive. Caught by the §9 warm-scan timing: discover
    // alone was already most of the warm budget before this guard.
    if (!presentNames.has(name)) continue;
    try {
      const content = await fs.readFile(path.join(absDir, name), "utf8");
      rules.push(...parseIgnoreFile(content, relDir));
    } catch {
      // unreadable despite appearing in the listing — degrade, don't crash
    }
  }
  return rules;
}

type Frame = { absDir: string; relDir: string; depth: number; rules: IgnoreRule[] };

interface DirOutcome {
  files: DiscoveredFile[];
  children: Frame[];
}

async function scanDirectory(
  frame: Frame,
  absRoot: string,
  maxDepth: number,
  maxFileBytes: number,
): Promise<DirOutcome> {
  const { absDir, relDir, depth, rules } = frame;
  const files: DiscoveredFile[] = [];
  const children: Frame[] = [];

  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return { files, children }; // permission error etc. — degrade, don't crash the scan
  }

  const presentNames = new Set(entries.map((e) => e.name));
  const ownRules = await loadDirRules(absDir, relDir, presentNames);
  const rulesHere = ownRules.length > 0 ? [...rules, ...ownRules] : rules;

  const fileEntries = entries.filter((entry) => entry.isFile());
  const fileStats = new Map<string, Stats>();
  if (fileEntries.length > 0) {
    const statOne = async (entry: Dirent<string>) => {
      const st = await fs.stat(path.join(absDir, entry.name)).catch(() => null);
      return st ? ([entry.name, st] as const) : undefined;
    };
    const statResults =
      fileEntries.length <= 32
        ? await Promise.all(fileEntries.map(statOne))
        : await runPool(fileEntries, statOne);
    for (const result of statResults) {
      if (result) fileStats.set(result[0], result[1]);
    }
  }

  for (const entry of entries) {
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
      const st = await fs.stat(realAbs).catch(() => null);
      if (!st) continue;
      isDir = st.isDirectory();
    }

    if (isIgnored(rulesHere, entryRel, isDir)) continue;

    if (isDir) {
      if (depth + 1 > maxDepth) continue; // degrade: skip subtree past the depth cap
      children.push({ absDir: realAbs, relDir: entryRel, depth: depth + 1, rules: rulesHere });
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) continue; // sockets, FIFOs, etc. — skip
    const st = entry.isSymbolicLink() ? await fs.stat(realAbs).catch(() => null) : fileStats.get(entry.name) ?? null;
    if (!st || !st.isFile()) continue;
    if (st.size > maxFileBytes) continue;

    files.push({ path: toPosix(entryRel), absPath: realAbs, bytes: st.size, mtimeMs: st.mtimeMs });
  }

  return { files, children };
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

  let frontier: Frame[] = [{ absDir: absRoot, relDir: "", depth: 0, rules: baselineRules() }];

  while (frontier.length > 0) {
    if (results.length >= maxFiles) break;

    const batch = frontier.splice(0, DIR_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map((frame) => scanDirectory(frame, absRoot, maxDepth, maxFileBytes)),
    );

    const next: Frame[] = [];
    for (const outcome of outcomes) {
      for (const f of outcome.files) {
        if (results.length >= maxFiles) break;
        if (totalBytes + f.bytes > maxTotalBytes) continue;
        results.push(f);
        totalBytes += f.bytes;
      }
      for (const child of outcome.children) {
        if (visitedReal.has(child.absDir)) continue; // cycle guard (symlink joins)
        visitedReal.add(child.absDir);
        next.push(child);
      }
    }
    frontier = frontier.concat(next);
  }

  return results;
}
