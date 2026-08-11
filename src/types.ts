// Core contracts — ARCHITECTURE.md §4.
//
// FileRecord and Detector/Finding are the two interfaces that hold the system
// together. Everything else (discover, classify, measure, score, report) is an
// implementation detail behind them. Detector/Finding is also part of the
// public surface (§11) — additive fields only, no breaking changes without a
// major bump.

/** How a file is classified for measurement and scoring purposes. */
export type FileKind =
  | "source"
  | "generated"
  | "vendored"
  | "doc"
  | "fixture"
  | "binary";

/** Context tier — ARCHITECTURE.md §1. */
export type Tier = 0 | 1 | 2;

export interface FileRecord {
  /** repo-relative, posix separators, no leading slash */
  path: string;
  bytes: number;
  /** exact or estimated — see §5 */
  tokens: number;
  estimated: boolean;
  kind: FileKind;
  tier: Tier;
  /** epoch seconds; undefined = untracked by git */
  lastCommit?: number;
  commits90d?: number;
  /** true when the head of the file matched a generated-file banner (`@generated`, `DO NOT EDIT`, ...) */
  generatedHeader?: boolean;
  /** repo-relative paths this doc's markdown links resolve to (doc kind only); existence is the detector's job */
  referencedPaths?: string[];
  /** 32-bit simhash of the doc's shingled prose (doc kind only, omitted when too short to fingerprint) */
  contentSimhash?: number;
  /** unreachable from any inferred entrypoint via the import graph (JS/TS family only, see graph/) */
  orphanModule?: boolean;
  /** exported symbol names with zero inbound references anywhere in the repo (JS/TS family only) */
  deadExportSymbols?: string[];
}

/** Shared read-only context passed to every detector. */
export interface Ctx {
  /** absolute path to the repo root being scanned */
  root: string;
  /** git is available and the root is inside a git working tree */
  gitAvailable: boolean;
  /** budget config, if any (from CLI flag or .sherlockrc) */
  budget?: number;
  /** epoch seconds treated as "now" — injectable so age-based detectors are deterministic in tests */
  now?: number;
  /** cadence weights, from .sherlockrc if set — see DEFAULT_CADENCE and §7 */
  cadence?: Record<Tier, number>;
}

export interface Detector {
  /** stable id, e.g. 'generated', 'dead-export', 'dup-doc' */
  id: string;
  run(files: FileRecord[], ctx: Ctx): Finding[];
}

export type Suggestion = "ignore" | "split" | "delete" | "review";

export interface Finding {
  path: string;
  detector: string;
  /** P(safe to trim), 0..1 — drives ranking. Never derived from file content. */
  confidence: number;
  /** one line, shown verbatim to the user — templates + metadata only, never file content */
  reason: string;
  suggest: Suggestion;
}

/** Per-tier cadence weights used by the waste model — ARCHITECTURE.md §7. */
export const DEFAULT_CADENCE: Record<Tier, number> = {
  0: 1.0,
  1: 0.15,
  2: 0.05,
};

/** Default resident-context budget in tokens, used when no --budget/.sherlockrc is set. */
export const DEFAULT_BUDGET = 3000;
