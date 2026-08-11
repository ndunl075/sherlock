import { test } from "node:test";
import assert from "node:assert/strict";
import { coldAndCostlyDetector } from "./cold-and-costly.js";
import type { FileRecord } from "../types.js";

const NOW = 1_700_000_000;
const DAY = 86_400;

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "src/legacy.ts", bytes: 10_000, tokens: 2000, estimated: false, kind: "source", tier: 1, ...overrides };
}

test("cold-and-costly: ignores files with no git history at all", () => {
  const files = [record({})]; // no lastCommit override — untracked by git
  assert.deepEqual(coldAndCostlyDetector.run(files, { root: "/", gitAvailable: false, now: NOW }), []);
});

test("cold-and-costly: ignores files touched within the last 180 days", () => {
  const files = [record({ lastCommit: NOW - 30 * DAY })];
  assert.deepEqual(coldAndCostlyDetector.run(files, { root: "/", gitAvailable: true, now: NOW }), []);
});

test("cold-and-costly: ignores small files even if ancient", () => {
  const files = [record({ tokens: 50, lastCommit: NOW - 400 * DAY })];
  assert.deepEqual(coldAndCostlyDetector.run(files, { root: "/", gitAvailable: true, now: NOW }), []);
});

test("cold-and-costly: never flags a known entrypoint basename", () => {
  const files = [record({ path: "src/index.ts", lastCommit: NOW - 400 * DAY })];
  assert.deepEqual(coldAndCostlyDetector.run(files, { root: "/", gitAvailable: true, now: NOW }), []);
});

test("cold-and-costly: never flags a tier-0 resident file", () => {
  const files = [record({ path: "CLAUDE.md", tier: 0, lastCommit: NOW - 400 * DAY })];
  assert.deepEqual(coldAndCostlyDetector.run(files, { root: "/", gitAvailable: true, now: NOW }), []);
});

test("cold-and-costly: flags a large, ancient, non-entrypoint file", () => {
  const files = [record({ path: "src/legacy.ts", tokens: 5000, lastCommit: NOW - 400 * DAY })];
  const findings = coldAndCostlyDetector.run(files, { root: "/", gitAvailable: true, now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.suggest, "review");
  assert.match(findings[0]?.reason ?? "", /untouched for ~400 days/);
});
