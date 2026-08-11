import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRollup, waste, maxConfidence } from "./index.js";
import type { FileRecord, Finding } from "../types.js";

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "x", bytes: 100, tokens: 100, estimated: false, kind: "source", tier: 1, ...overrides };
}

test("waste: zero confidence findings contribute nothing", () => {
  const f = record({ tokens: 1000, tier: 0 });
  assert.equal(waste(f, []), 0);
});

test("waste: applies cadence weight per tier", () => {
  const t0 = record({ path: "a", tokens: 1000, tier: 0 });
  const t1 = record({ path: "b", tokens: 1000, tier: 1 });
  const findings: Finding[] = [
    { path: "a", detector: "d", confidence: 1, reason: "r", suggest: "review" },
    { path: "b", detector: "d", confidence: 1, reason: "r", suggest: "review" },
  ];
  assert.ok(waste(t0, findings) > waste(t1, findings));
});

test("maxConfidence: takes the highest confidence across findings for a path", () => {
  const findings: Finding[] = [
    { path: "a", detector: "d1", confidence: 0.3, reason: "r", suggest: "review" },
    { path: "a", detector: "d2", confidence: 0.9, reason: "r", suggest: "review" },
  ];
  assert.equal(maxConfidence("a", findings), 0.9);
});

test("computeRollup: buckets tokens by tier and flags budget overage", () => {
  const files = [
    record({ path: "CLAUDE.md", tokens: 4000, tier: 0 }),
    record({ path: "src/a.ts", tokens: 500, tier: 1 }),
    record({ path: "vendor/x.js", tokens: 200, tier: 2 }),
  ];
  const rollup = computeRollup(files, [], 3000);
  assert.equal(rollup.residentTokens, 4000);
  assert.equal(rollup.reachableTokens, 500);
  assert.equal(rollup.ambientTokens, 200);
  assert.equal(rollup.overBudget, true);
  assert.equal(rollup.overagePct, Math.round(((4000 - 3000) / 3000) * 100));
});

test("computeRollup: ranked list is sorted by waste, highest first", () => {
  const files = [record({ path: "a", tokens: 100, tier: 1 }), record({ path: "b", tokens: 900, tier: 1 })];
  const findings: Finding[] = [
    { path: "a", detector: "d", confidence: 1, reason: "r", suggest: "review" },
    { path: "b", detector: "d", confidence: 1, reason: "r", suggest: "review" },
  ];
  const rollup = computeRollup(files, findings, 3000);
  assert.equal(rollup.ranked[0]?.path, "b");
  assert.equal(rollup.ranked[1]?.path, "a");
});
