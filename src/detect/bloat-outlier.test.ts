import { test } from "node:test";
import assert from "node:assert/strict";
import { bloatOutlierDetector } from "./bloat-outlier.js";
import type { FileRecord } from "../types.js";

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "x", bytes: 100, tokens: 100, estimated: false, kind: "source", tier: 1, ...overrides };
}

function group(kind: FileRecord["kind"], count: number, tokens: (i: number) => number): FileRecord[] {
  return Array.from({ length: count }, (_, i) => record({ path: `${kind}-${i}`, kind, tokens: tokens(i) }));
}

test("bloat-outlier: skips kinds with too few files to be meaningful", () => {
  const files = [record({ tokens: 100_000 }), record({ path: "y", tokens: 50 })];
  assert.deepEqual(bloatOutlierDetector.run(files, { root: "/", gitAvailable: false }), []);
});

test("bloat-outlier: flags the top 1% of a large uniform-ish group", () => {
  // 100 source files, tokens 1..100, plus one wildly larger outlier
  const files = group("source", 100, (i) => i + 1);
  const outlierIndex = files.findIndex((f) => f.path === "source-99");
  files[outlierIndex] = record({ path: "source-99", kind: "source", tokens: 100_000 });

  const findings = bloatOutlierDetector.run(files, { root: "/", gitAvailable: false });
  assert.ok(findings.some((f) => f.path === "source-99"));
  const hit = findings.find((f) => f.path === "source-99");
  assert.equal(hit?.suggest, "review");
  assert.ok((hit?.confidence ?? 0) >= 0.5);
});

test("bloat-outlier: never fires on binary kind", () => {
  const files = group("binary", 50, () => 0);
  assert.deepEqual(bloatOutlierDetector.run(files, { root: "/", gitAvailable: false }), []);
});

test("bloat-outlier: typical files in a large group are not flagged", () => {
  const files = group("doc", 50, (i) => i + 1);
  const findings = bloatOutlierDetector.run(files, { root: "/", gitAvailable: false });
  // only the very top of the distribution should ever be flagged
  assert.ok(findings.length <= 1);
});
