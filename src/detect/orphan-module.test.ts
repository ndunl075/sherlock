import { test } from "node:test";
import assert from "node:assert/strict";
import { orphanModuleDetector } from "./orphan-module.js";
import type { FileRecord } from "../types.js";

const ctx = { root: "/", gitAvailable: false };

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "src/x.ts", bytes: 100, tokens: 100, estimated: false, kind: "source", tier: 1, ...overrides };
}

test("orphan-module: ignores files with no orphan signal", () => {
  assert.deepEqual(orphanModuleDetector.run([record({})], ctx), []);
});

test("orphan-module: ignores files explicitly marked not orphan", () => {
  assert.deepEqual(orphanModuleDetector.run([record({ orphanModule: false })], ctx), []);
});

test("orphan-module: flags a file marked orphan", () => {
  const findings = orphanModuleDetector.run([record({ path: "src/dead.ts", orphanModule: true })], ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.suggest, "review");
  assert.equal(findings[0]?.path, "src/dead.ts");
});
