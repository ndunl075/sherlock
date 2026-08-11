import { test } from "node:test";
import assert from "node:assert/strict";
import { t0OverweightDetector } from "./t0-overweight.js";
import type { FileRecord } from "../types.js";

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "x", bytes: 100, tokens: 100, estimated: false, kind: "doc", tier: 0, ...overrides };
}

test("t0-overweight: ignores non-resident tiers regardless of size", () => {
  const files = [record({ tier: 1, tokens: 5000 })];
  const findings = t0OverweightDetector.run(files, { root: "/", gitAvailable: false, budget: 1000 });
  assert.deepEqual(findings, []);
});

test("t0-overweight: ignores a T0 file under the per-file threshold", () => {
  const files = [record({ tier: 0, tokens: 200 })]; // 20% of a 1000 budget, threshold is 30%
  const findings = t0OverweightDetector.run(files, { root: "/", gitAvailable: false, budget: 1000 });
  assert.deepEqual(findings, []);
});

test("t0-overweight: flags a T0 file over the per-file threshold with suggest 'split'", () => {
  const files = [record({ path: "CLAUDE.md", tier: 0, tokens: 900 })]; // 90% of a 1000 budget
  const findings = t0OverweightDetector.run(files, { root: "/", gitAvailable: false, budget: 1000 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.suggest, "split");
  assert.match(findings[0]?.reason ?? "", /~90% of the 1000-token resident budget/);
});

test("t0-overweight: falls back to DEFAULT_BUDGET when ctx.budget is unset", () => {
  const files = [record({ tier: 0, tokens: 2000 })];
  const findings = t0OverweightDetector.run(files, { root: "/", gitAvailable: false });
  assert.equal(findings.length, 1);
});
