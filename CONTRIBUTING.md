# Contributing

The v1 scanner, nine detectors, cache, CLI, and §9 bench gate are in place. Two
ways to help, in order of usefulness.

## 1. Argue with the model

[ARCHITECTURE.md](ARCHITECTURE.md) makes claims that are testable against your
repo. The most valuable issue you can open is one of these:

- "Detector X would have fired on a file I actually need." (false positive)
- "The real bloat in my repo is Y, and none of the nine detectors catch it."
- "The resident-vs-reachable weight of ~7x is wrong for my workflow, here's why."

Nine detectors is a guess. Tell me which are dead weight.

## 2. Write a detector

The one extension point designed to stay easy. A detector is a pure function:

```ts
interface Detector {
  id: string;
  run(files: FileRecord[], ctx: Ctx): Finding[];
}
```

One file in `src/detect/`, one line in the registry, one test. Because it's pure
over `(files, ctx)`, the test is a synthetic `FileRecord[]` — no fixture repo on
disk, no I/O, fast.

**Rules a detector must follow.** These come straight from the
[security model](SECURITY.md#design-commitments) and PRs are checked against
them:

- **Never put file content in `Finding.reason`.** Build it from templates and
  metadata. A reason like `` `duplicate of ${otherPath}` `` is fine;
  `` `contains "${line}"` `` is a content leak and will be rejected. Detector
  tests assert reasons are templated (see `generated.test.ts`).
- **No I/O.** Detectors receive completed records. No `fs`, no `child_process`,
  no network — that's not a style preference, it's what keeps `npx sherlock`
  safe to run on an untrusted repo.
- **Confidence must mean something.** `confidence` is *P(safe to trim)*, and it
  drives ranking. If you can't justify the number, it's probably `0.5` and
  probably shouldn't ship.
- **Suggest, don't destroy.** `suggest` is a recommendation the user applies. No
  detector deletes, rewrites, or moves a file.

## Local checks

```bash
npm test          # typecheck + unit tests
npm run bench     # §9 50k-file cold/warm/RSS budgets (slow; not in CI)
```

## Dependencies

The bar is high and deliberately so: every runtime dependency is another party
with read access to users' source trees. Adding one needs a justification in the
PR description, and "it's only 3KB" isn't it. Prefer the standard library.
Dev dependencies are less fraught but still reviewed.

## Pull requests

- One detector or one concern per PR.
- Tests with it, not after it.
- If you change anything under §11 Public surface in ARCHITECTURE.md, say so in
  the PR — that's the semver contract.
- Performance budgets in §9 are enforced by `npm run bench`. If your change
  blows one, that's a conversation, not an automatic no.

## Conduct

Be decent. Disagree about the technical thing, not the person. Behavior that
makes this a worse place to contribute gets you removed.
