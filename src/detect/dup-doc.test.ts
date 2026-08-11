import { test } from "node:test";
import assert from "node:assert/strict";
import { dupDocDetector } from "./dup-doc.js";
import type { FileRecord } from "../types.js";

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "x", bytes: 100, tokens: 100, estimated: false, kind: "doc", tier: 1, ...overrides };
}

const ctx = { root: "/", gitAvailable: false };

test("dup-doc: ignores docs without a fingerprint", () => {
  const files = [record({ path: "a.md" }), record({ path: "b.md" })];
  assert.deepEqual(dupDocDetector.run(files, ctx), []);
});

test("dup-doc: identical fingerprints are flagged, later path is the one reported", () => {
  const files = [
    record({ path: "a.md", contentSimhash: 0b1010_1010 }),
    record({ path: "b.md", contentSimhash: 0b1010_1010 }),
  ];
  const findings = dupDocDetector.run(files, ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.path, "b.md");
  assert.match(findings[0]?.reason ?? "", /100% overlap with a\.md/);
  assert.equal(findings[0]?.suggest, "review");
});

test("dup-doc: fingerprints far apart are not flagged", () => {
  const files = [
    record({ path: "a.md", contentSimhash: 0x0000_0000 }),
    record({ path: "b.md", contentSimhash: 0xffff_ffff }),
  ];
  assert.deepEqual(dupDocDetector.run(files, ctx), []);
});

test("dup-doc: never compares non-doc kinds even with a stray contentSimhash", () => {
  const files = [
    record({ path: "a.ts", kind: "source", contentSimhash: 0b1010 }),
    record({ path: "b.md", kind: "doc", contentSimhash: 0b1010 }),
  ];
  assert.deepEqual(dupDocDetector.run(files, ctx), []);
});
