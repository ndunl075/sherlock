import { test } from "node:test";
import assert from "node:assert/strict";
import { staleDocDetector } from "./stale-doc.js";
import type { FileRecord } from "../types.js";

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "x", bytes: 100, tokens: 100, estimated: false, kind: "doc", tier: 1, ...overrides };
}

const ctx = { root: "/", gitAvailable: false };

test("stale-doc: ignores files with no extracted links", () => {
  const files = [record({ path: "README.md" })];
  assert.deepEqual(staleDocDetector.run(files, ctx), []);
});

test("stale-doc: ignores a doc whose links all resolve", () => {
  const files = [
    record({ path: "README.md", referencedPaths: ["CONTRIBUTING.md"] }),
    record({ path: "CONTRIBUTING.md" }),
  ];
  assert.deepEqual(staleDocDetector.run(files, ctx), []);
});

test("stale-doc: flags a doc with one dangling link out of two", () => {
  const files = [
    record({ path: "README.md", referencedPaths: ["CONTRIBUTING.md", "docs/gone.md"] }),
    record({ path: "CONTRIBUTING.md" }),
  ];
  const findings = staleDocDetector.run(files, ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.suggest, "review");
  assert.match(findings[0]?.reason ?? "", /references 1 of 2 linked path\(s\)/);
});

test("stale-doc: higher miss rate yields higher confidence", () => {
  const allMissing = record({ path: "a.md", referencedPaths: ["m", "n", "o"] }); // 3/3 missing
  const oneMissing = record({ path: "b.md", referencedPaths: ["x", "y", "z"] }); // 1/3 missing (only z)
  const files = [allMissing, oneMissing, record({ path: "x" }), record({ path: "y" })];
  const findings = staleDocDetector.run(files, ctx);
  const a = findings.find((f) => f.path === "a.md");
  const b = findings.find((f) => f.path === "b.md");
  assert.ok((a?.confidence ?? 0) > (b?.confidence ?? 0));
});
