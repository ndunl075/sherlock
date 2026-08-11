import { test } from "node:test";
import assert from "node:assert/strict";
import { vendoredDetector } from "./vendored.js";
import type { FileRecord } from "../types.js";

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "x", bytes: 100, tokens: 100, estimated: false, kind: "source", tier: 1, ...overrides };
}

test("vendored detector: ignores non-vendored kinds", () => {
  const files = [record({ kind: "source" })];
  assert.deepEqual(vendoredDetector.run(files, { root: "/", gitAvailable: false }), []);
});

test("vendored detector: untracked-by-git path gets the base confidence", () => {
  const files = [record({ path: "vendor/sdk.js", kind: "vendored" })];
  const findings = vendoredDetector.run(files, { root: "/", gitAvailable: false });
  assert.equal(findings[0]?.confidence, 0.7);
});

test("vendored detector: tracked with no recent churn gets a higher confidence", () => {
  const files = [record({ path: "vendor/sdk.js", kind: "vendored", lastCommit: 1_600_000_000, commits90d: 0 })];
  const findings = vendoredDetector.run(files, { root: "/", gitAvailable: false });
  assert.equal(findings[0]?.confidence, 0.9);
});

test("vendored detector: recent churn drops confidence sharply", () => {
  const files = [record({ path: "vendor/sdk.js", kind: "vendored", lastCommit: 1_700_000_000, commits90d: 3 })];
  const findings = vendoredDetector.run(files, { root: "/", gitAvailable: false });
  assert.equal(findings[0]?.confidence, 0.45);
});
