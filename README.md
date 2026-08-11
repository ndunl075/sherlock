# Sherlock

**A context budget linter.** It scans your repo and tells you which files are
quietly taxing every AI coding session — dead code, generated blobs, redundant
docs — so you can trim what Claude Code, Cursor, or Codex has to read before
every request.

> **Status: v1 complete.**
> Scanner, nine detectors, JSON/ignore-patch output, and cache are in. Performance
> budgets live in [ARCHITECTURE.md §9](ARCHITECTURE.md#9-performance-budget) and
> are checked with `npm run bench`.

---

## The idea

Every agent session pays for context in three different ways, and most people
only ever notice the third:

| | What it is | You pay | Fix |
|---|---|---|---|
| **Resident** | `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, their imports, MCP tool schemas | every single turn | cut or split it |
| **Reachable** | what search and grep surface, that the agent then reads | per unlucky retrieval | ignore patterns |
| **Ambient** | tree listings, path noise from a 40k-file `node_modules` | per exploration step | ignore patterns |

The consequence is counterintuitive and it's the whole point of the tool: **a
900-token stale paragraph in your `CLAUDE.md` costs you more than a
50,000-token lockfile.** The lockfile is read approximately never. The paragraph
is read approximately always.

So Sherlock doesn't rank by file size. It ranks by
`tokens × P(the agent never needed it) × how often it's read`.

## Planned output

```
Resident context   4,812 tok   ██████░░░░  (budget 3,000)  +60%
Repo reachable   1.2M tok
Top trim          312k tok recoverable across 47 files

  RESIDENT                                    tokens   conf
  CLAUDE.md §"Legacy API notes"                  912   0.91  refs 4 paths that no longer exist
  CLAUDE.md @imports/style-guide.md            1,204   0.78  94% overlap with CONTRIBUTING.md

  IGNORE                                      tokens   conf
  fixtures/snapshots/**                      184,300   0.97  generated; untouched 340d
  vendor/sdk-bundle.js                        61,220   0.95  vendored; no inbound edges
```

```bash
sherlock                    # ranked report
sherlock --json             # stable schema for CI
sherlock --emit-ignore      # diff against .claudeignore / .cursorignore
sherlock --budget 3000      # exit 1 when resident context is over budget
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
  reasons. The cache stores no snippets. Enforced by test.
- **It makes no network requests, ever.** No telemetry, no update check. The
  package declares zero runtime hosts so you can verify that instead of
  trusting it.

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
