# Sherlock

**A context budget linter.** It scans your repo and tells you which files are
quietly taxing every AI coding session — dead code, generated blobs, redundant
docs — so you can trim what Claude Code, Cursor, or Codex has to read before
every request.

> **Status: v1.0.0 — published.**
> Scanner, nine detectors, JSON/ignore-patch output, cache, §9 bench, CJS +
> tsconfig paths graph, and contract tests are in. Package is
> [`@ndunl075/sherlock`](https://www.npmjs.com/package/@ndunl075/sherlock) —
> the bare name `sherlock` on npm is a different, unrelated package.

---

## Install

```bash
npx @ndunl075/sherlock
npm i -g @ndunl075/sherlock
```

Requires Node 20+. The CLI binary is still named `sherlock` once installed.
Native `tree-sitter` grammars ship as prebuilds for common platforms.

## Usage

```bash
sherlock                      # ranked report (cwd)
sherlock --json               # stable schema for CI
sherlock --emit-ignore        # diff against .claudeignore / .cursorignore
sherlock --budget 3000        # exit 1 when resident context is over budget
sherlock path/to/repo         # scan a specific root
```

## The idea

Every agent session pays for context in three different ways, and most people
only ever notice the third:

| | What it is | You pay | Fix |
|---|---|---|---|
| **Resident** | Auto-loaded on every request: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, their `@imports` | every single turn | cut or split it |
| **Reachable** | what search and grep surface, that the agent then reads | per unlucky retrieval | ignore patterns |
| **Ambient** | tree listings, path noise from huge dependency trees | per exploration step | ignore patterns (baseline already skips `node_modules`/`dist`/…) |

The consequence is counterintuitive and it's the whole point of the tool: **a
900-token stale paragraph in your `CLAUDE.md` costs you more than a
50,000-token lockfile.** The lockfile is read approximately never. The paragraph
is read approximately always.

So Sherlock doesn't rank by file size. It ranks by
`tokens × P(the agent never needed it) × how often it's read`.

## Example output

```
Resident context  4,812 tok   ██████░░░░  (budget 3,000 tok)  +60%
Repo reachable    1.2M tok
Top trim          312k tok recoverable across 47 files

  IGNORE
  PATH                                              DETECTOR        CONF  REASON
  package-lock.json                                 generated       0.75  generated file — matches a known lockfile/build-output path pattern
  vendor/sdk-bundle.js                              vendored        0.90  vendored path, no commits in the last 90 days

  REVIEW
  PATH                                              DETECTOR        CONF  REASON
  src/legacy/unused.ts                              orphan-module   0.55  unreachable from any inferred entrypoint via relative import/require edges
  docs/old-api.md                                   stale-doc       0.80  references 2 of 3 linked path(s) that no longer exist
```

**Sherlock never deletes anything.** It ranks, explains, and hands you a patch to
apply. A linter that silently removes "dead" code is a linter nobody runs twice.

## Security

Sherlock reads every file in a repo, including ones you'd never paste into a
chat. Three commitments, designed in rather than bolted on
([details](ARCHITECTURE.md#12-security-model)):

- **It never executes anything from the repo it scans.** No plugin loading from
  the target tree, no config in the target tree that grants privilege. Pointing
  it at an untrusted clone is safe.
- **It never emits file contents.** Findings are paths, metadata, and templated
  reasons. The cache stores no snippets. Detector reason templates are covered
  by tests (see `content-leak.test.ts`).
- **It makes no network requests.** No telemetry, no update check, no HTTP client
  in the dependency tree — auditable by inspection, not a separate hosts file.

⚠️ One thing to know: `--json` and `--emit-ignore` list **paths from your repo**.
That's the point of the output, but it means a scan piped into a public CI log
publishes your file tree. Keep scans on private runners.

Found a vulnerability? See [SECURITY.md](SECURITY.md) — please don't open a
public issue.

## Contributing

The extension point that's meant to stay easy is **adding a detector** — one
pure function, `(files, ctx) → Finding[]`, one file, one registry line. Start at
[CONTRIBUTING.md](CONTRIBUTING.md).

Right now the most useful contribution isn't code, it's telling me which of the
nine v1 detectors would actually have caught real bloat in your repo — and which
one is missing.

## License

MIT © 2026 Nicolas Dunlap
