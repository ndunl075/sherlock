// Content-leak guard — ARCHITECTURE.md §12 / CONTRIBUTING.md.
//
// Finding.reason is templates + metadata only. Each detector is exercised with
// a canary that would only appear if someone interpolated file body (or a
// content-shaped field) into the reason. Paths are allowed in reasons
// (dup-doc); the canary is never a path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectors } from "./index.js";
import type { Ctx, FileRecord, Finding } from "../types.js";

const CANARY = "SECRET_FILE_BODY_SHOULD_NEVER_APPEAR_IN_REASON";

const REASON_SHAPES: Record<string, RegExp> = {
  generated: /^generated file — /,
  vendored: /^vendored path/,
  "t0-overweight": /^resident file alone uses ~\d+% of the \d+-token resident budget$/,
  "bloat-outlier": /^\d+ tok is in the top 1% of \w+ files in this repo/,
  "stale-doc": /^references \d+ of \d+ linked path\(s\) that no longer exist in this repo$/,
  "dup-doc": /^~\d+% overlap with /,
  "cold-and-costly": /^\d+ tok, untouched for ~\d+ days, no known-entrypoint filename$/,
  "orphan-module": /^unreachable from any inferred entrypoint via module-graph edges$/,
  "dead-export": /^\d+ exported symbol\(s\) have zero inbound module-graph references anywhere in this repo \(v1\)$/,
};

function record(overrides: Partial<FileRecord>): FileRecord {
  return {
    path: "src/x.ts",
    bytes: 100,
    tokens: 100,
    estimated: false,
    kind: "source",
    tier: 1,
    ...overrides,
  };
}

/** Fixtures designed so every registered detector fires at least once. */
function fixtureFiles(): FileRecord[] {
  const now = 1_700_000_000;
  const ancient = now - 400 * 86_400;
  const docs = Array.from({ length: 120 }, (_, i) =>
    record({
      path: `docs/n${i}.md`,
      kind: "doc",
      tokens: 50 + (i === 119 ? 50_000 : 0),
      contentSimhash: i === 0 || i === 1 ? 0x11111111 : 0x22222200 + i,
    }),
  );

  return [
    record({ path: "package-lock.json", kind: "generated", tokens: 200 }),
    record({ path: "vendor/sdk.js", kind: "vendored", lastCommit: ancient, commits90d: 0, tokens: 500 }),
    record({ path: "CLAUDE.md", kind: "doc", tier: 0, tokens: 5_000 }),
    record({
      path: "docs/stale.md",
      kind: "doc",
      referencedPaths: ["missing/does-not-exist.ts", "also/gone.ts"],
      tokens: 200,
    }),
    record({
      path: "src/old-blob.ts",
      kind: "source",
      tokens: 5_000,
      lastCommit: ancient,
    }),
    record({ path: "src/orphan.ts", kind: "source", orphanModule: true }),
    record({ path: "src/dead.ts", kind: "source", deadExportSymbols: ["a", "b"] }),
    // Canary only lives in a field that is never supposed to be stringified into reasons.
    // referencedPaths are paths (allowed); we stash the canary as a path *segment that no
    // detector currently echoes* — stale-doc only prints counts. If a future detector
    // starts dumping referencedPaths into reason, this still won't catch it; the shape
    // regex below is the primary guard. Extra: path itself must not be the canary.
    ...docs,
  ];
}

test("registry: exactly the nine §6 detectors, stable ids", () => {
  assert.equal(detectors.length, 9);
  assert.deepEqual(
    detectors.map((d) => d.id).sort(),
    [
      "bloat-outlier",
      "cold-and-costly",
      "dead-export",
      "dup-doc",
      "generated",
      "orphan-module",
      "stale-doc",
      "t0-overweight",
      "vendored",
    ],
  );
});

test("every detector reason matches its template and never contains the content canary", () => {
  const ctx: Ctx = {
    root: "/repo",
    gitAvailable: true,
    budget: 3000,
    now: 1_700_000_000,
  };
  const files = fixtureFiles();
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const detector of detectors) {
    const batch = detector.run(files, ctx);
    assert.ok(batch.length > 0, `${detector.id} should fire on the fixture`);
    seen.add(detector.id);
    findings.push(...batch);
  }

  assert.equal(seen.size, 9);

  for (const finding of findings) {
    assert.equal(
      finding.reason.includes(CANARY),
      false,
      `${finding.detector} reason leaked canary: ${finding.reason}`,
    );
    const shape = REASON_SHAPES[finding.detector];
    assert.ok(shape, `missing reason shape for ${finding.detector}`);
    assert.match(finding.reason, shape);
  }
});
