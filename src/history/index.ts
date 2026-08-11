// git log adapter — ARCHITECTURE.md §3 (history/), §12 security model.
//
// Read via execFile with an argument array, never a shell string, so a
// branch or path containing `;` is inert (SECURITY.md). Two git log passes:
// one full-history pass for lastCommit per path (first line seen per path,
// since log is newest-first), one --since=90.days.ago pass for churn count.
//
// v1 note: the full-history pass is unbounded and will get slow on repos with
// very long histories. Acceptable for the vertical slice; revisit against the
// §9 performance budget once it's benchmarked.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const RECORD_SEP = "";

export interface HistoryInfo {
  lastCommit?: number;
  commits90d?: number;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function runLog(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch {
    return ""; // degrade — history is enrichment, never required for a scan to succeed
  }
}

function parseNameOnlyLog(stdout: string, onRecord: (path: string, epochSeconds: number) => void): void {
  let currentTs: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith(RECORD_SEP)) {
      const ts = Number(line.slice(1));
      currentTs = Number.isFinite(ts) ? ts : null;
      continue;
    }
    const p = line.trim();
    if (p === "" || currentTs === null) continue;
    onRecord(p, currentTs);
  }
}

async function lastCommitByPath(root: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const stdout = await runLog(root, [
    "log",
    "--name-only",
    "--diff-filter=ACMR",
    `--pretty=format:${RECORD_SEP}%ct`,
  ]);
  parseNameOnlyLog(stdout, (path, ts) => {
    if (!map.has(path)) map.set(path, ts); // newest-first log — first hit is the last commit
  });
  return map;
}

async function commits90dByPath(root: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const stdout = await runLog(root, [
    "log",
    "--since=90.days.ago",
    "--name-only",
    "--diff-filter=ACMR",
    `--pretty=format:${RECORD_SEP}%ct`,
  ]);
  parseNameOnlyLog(stdout, (path) => {
    map.set(path, (map.get(path) ?? 0) + 1);
  });
  return map;
}

export async function loadHistory(root: string): Promise<Map<string, HistoryInfo>> {
  const result = new Map<string, HistoryInfo>();
  if (!(await isGitRepo(root))) return result;

  const [lastCommit, commits90d] = await Promise.all([lastCommitByPath(root), commits90dByPath(root)]);

  const paths = new Set<string>([...lastCommit.keys(), ...commits90d.keys()]);
  for (const p of paths) {
    const info: HistoryInfo = {};
    const lc = lastCommit.get(p);
    const c90 = commits90d.get(p);
    if (lc !== undefined) info.lastCommit = lc;
    if (c90 !== undefined) info.commits90d = c90;
    result.set(p, info);
  }
  return result;
}
