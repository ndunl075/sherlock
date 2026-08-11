# Sherlock — Architecture

A context budget linter. Scans a repo and reports which files are quietly taxing
every AI coding session, so you can trim what the agent reads before each request.

> This document is written under its own rules: dense, no filler, no restated code.
> Target ≤ 2.5k tokens. If a section can't earn its tokens, it gets cut.

---

## 1. Problem model

An agent session spends tokens in three distinct ways. Most tools conflate them;
Sherlock does not, because the remedy differs for each.

| Tier | What it is | Cost cadence | Fix |
|---|---|---|---|
| **T0 Resident** | Auto-loaded on every request: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, their `@imports`, MCP tool schemas | Every turn × every session | Cut or split the file |
| **T1 Reachable** | What search/glob/grep surfaces and the agent then reads: source, docs, fixtures | Per unlucky retrieval | Ignore-file patterns |
| **T2 Ambient** | Tree listings, `ls` output, path noise from 40k-file `node_modules` | Per exploration step | Ignore + directory collapse |

**Waste = tokens × P(the agent never needed it) × cadence.** A 900-token stale
paragraph in `CLAUDE.md` outranks a 50k-token lockfile, because the lockfile is
read approximately never and the paragraph is read approximately always.

---

## 2. Pipeline

```
discover ─→ classify ─→ measure ─→ detect ─→ score ─→ report
  fs walk    file kind   tokens    signals   rank    tty/json/ignore-patch
  (git-aware)                        ↑
                                 git log
                                 import graph
```

Single pass over the tree; detectors run over a shared in-memory `FileRecord[]`.
No detector re-reads the disk.

---

## 3. Modules

```
src/
  cli.ts            arg parse, exit codes, tty detection
  discover/         walk + ignore-stack resolution (gitignore, claudeignore, cursorignore)
  classify/         file kind: source | generated | vendored | doc | fixture | binary
  measure/
    tokens.ts       tokenizer + sampling estimator
    tier.ts         T0/T1/T2 assignment (resolves @imports transitively)
  detect/           one file per signal; all implement Detector
  graph/            import/require graph via tree-sitter, for reachability
  history/          git log adapter: churn, last-touched, add-only files
  score/            waste model, ranking, budget rollups
  report/           table.ts | json.ts | ignore.ts (emits .claudeignore diff)
```

---

## 4. Core contracts

Two interfaces hold the system together. Everything else is an implementation
detail behind them.

```ts
interface FileRecord {
  path: string;              // repo-relative, posix
  bytes: number;
  tokens: number;            // exact or estimated (see §5)
  estimated: boolean;
  kind: FileKind;
  tier: 0 | 1 | 2;
  lastCommit?: number;       // epoch s; undefined = untracked
  commits90d?: number;
}

interface Detector {
  id: string;                            // 'generated', 'dead-export', 'dup-doc'
  run(files: FileRecord[], ctx: Ctx): Finding[];
}

interface Finding {
  path: string;
  detector: string;
  confidence: number;   // 0..1 — P(safe to trim)
  reason: string;       // one line, shown verbatim to the user
  suggest: 'ignore' | 'split' | 'delete' | 'review';
}
```

A detector is pure over `(files, ctx)`. That makes each one unit-testable with a
synthetic `FileRecord[]` and no fixture repo on disk.

---

## 5. Token measurement

Exact tokenization of a 2GB monorepo is the obvious wrong default.

- **Tier 0 files:** always tokenized exactly. They're few and they matter most.
- **Everything else:** byte→token ratio sampled per file kind (first 8KB + a
  middle 8KB slice), then extrapolated. Empirically within ~4% for text.
- **Binary/minified:** flagged, not tokenized. Reported as raw bytes.
- Results cached in `.sherlock/cache.json`, keyed by `path + mtime + size`.
  Warm runs are ~10x faster and are the common case in a watch loop.

Tokenizer is behind a `Tokenizer` port. Default implementation targets Claude's
counting; the ratio only shifts a few percent across major model families, and
ranking — not absolute count — is what drives every decision here.

---

## 6. Detectors (v1)

| id | Signal | Confidence source |
|---|---|---|
| `generated` | lockfiles, `dist/`, `*.min.*`, `*.pb.*`, snapshots, migrations | path + header sniff (`@generated`) |
| `vendored` | committed deps, bundled SDKs | path + no-git-churn |
| `dead-export` | exported symbol with zero graph inbound edges | import graph completeness |
| `orphan-module` | file unreachable from any entrypoint | entrypoint inference quality |
| `dup-doc` | near-duplicate prose across `*.md` | simhash bucket + Jaccard shingles |
| `stale-doc` | doc references paths that no longer exist | resolved-path hit rate |
| `bloat-outlier` | tokens in top 1% for its kind | distribution |
| `cold-and-costly` | large, untouched >180d, not an entrypoint | git history depth |
| `t0-overweight` | resident context over a per-file budget | exact |

Adding a detector = one file in `detect/` + one line in its registry. That is the
only extension point that needs to stay easy.

**Anti-goal:** Sherlock never deletes. It ranks, explains, and emits a patch you
apply. A linter that silently removes "dead" code is a linter nobody runs twice.

---

## 7. Scoring

```
waste(f) = tokens(f) × maxConfidence(findings(f)) × cadence(tier(f))
cadence  = { 0: 1.0, 1: 0.15, 2: 0.05 }
```

Cadence weights are heuristic priors, tunable in `.sherlockrc`. They encode the
one non-obvious claim in §1 — resident tokens are worth ~7x reachable ones — and
they're config, not constants, because that ratio is workload-dependent.

Rollup reports **budget**, not just a list:

```
Resident context   4,812 tok   ██████░░░░  (budget 3,000)  +60%
Repo reachable   1.2M tok
Top trim          312k tok recoverable across 47 files
```

---

## 8. Output

- **TTY:** ranked table, top 20, grouped by suggested action.
- **`--json`:** full `Finding[]` + rollup. Stable schema — this is the CI contract.
- **`--emit-ignore`:** unified diff against `.claudeignore` / `.cursorignore`.
- **`--budget <n>`:** exit 1 when resident tokens exceed `n`. The CI gate.

Exit codes: `0` clean · `1` budget exceeded · `2` scan error.

---

## 9. Performance budget

Self-imposed, enforced by benchmark test on a 50k-file fixture:

| Stage | Target |
|---|---|
| Cold scan, 50k files | < 8s |
| Warm scan (cached) | < 800ms |
| Peak RSS | < 400MB |

Discovery and measurement are concurrent (worker pool, `os.cpus()`); detectors
are sequential over the completed record set, since they're cheap once I/O is done.

---

## 10. Decisions

| Choice | Why | Cost accepted |
|---|---|---|
| TypeScript / Node | `npx sherlock` — zero-install for the JS-heavy target audience | Slower cold start than Go |
| tree-sitter for the graph | one grammar interface across languages | per-language grammar deps |
| Sampled tokenization | 10x speed for ~4% error | not exact outside T0 |
| No auto-fix | trust; a wrong delete ends adoption | user must apply the patch |
| Cache in `.sherlock/` | gitignored, per-clone, no global state | cold on fresh clone |

---

## 11. Not in v1

Editor extensions · server/daemon mode · cross-repo aggregation · non-Claude/Cursor
config formats · semantic dead-code (type-aware, needs a full type checker) ·
telemetry of any kind.
