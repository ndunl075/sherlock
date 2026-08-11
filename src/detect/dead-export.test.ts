import { test } from "node:test";
import assert from "node:assert/strict";
import { deadExportDetector } from "./dead-export.js";
import type { FileRecord } from "../types.js";

const ctx = { root: "/", gitAvailable: false };

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "src/x.ts", bytes: 100, tokens: 100, estimated: false, kind: "source", tier: 1, ...overrides };
}

test("dead-export: ignores files with no dead symbols", () => {
  assert.deepEqual(deadExportDetector.run([record({})], ctx), []);
});

test("dead-export: flags a file with dead symbols, reason mentions the count only", () => {
  const findings = deadExportDetector.run([record({ deadExportSymbols: ["unused1", "unused2"] })], ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.suggest, "review");
  assert.match(findings[0]?.reason ?? "", /^2 exported symbol\(s\)/);
});

test("dead-export: more dead symbols yields higher confidence, capped", () => {
  const one = deadExportDetector.run([record({ path: "a.ts", deadExportSymbols: ["x"] })], ctx)[0];
  const many = deadExportDetector.run(
    [record({ path: "b.ts", deadExportSymbols: ["a", "b", "c", "d", "e", "f", "g", "h"] })],
    ctx,
  )[0];
  assert.ok((many?.confidence ?? 0) > (one?.confidence ?? 0));
  assert.ok((many?.confidence ?? 0) <= 0.8);
});
