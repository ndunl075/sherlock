import { test } from "node:test";
import assert from "node:assert/strict";
import { generatedDetector } from "./generated.js";
import type { FileRecord } from "../types.js";

function record(overrides: Partial<FileRecord>): FileRecord {
  return { path: "x", bytes: 100, tokens: 100, estimated: false, kind: "source", tier: 1, ...overrides };
}

test("generated detector: ignores non-generated kinds", () => {
  const files = [record({ path: "src/a.ts", kind: "source" })];
  assert.deepEqual(generatedDetector.run(files, { root: "/", gitAvailable: false }), []);
});

test("generated detector: path-only match gets the lower confidence tier", () => {
  const files = [record({ path: "package-lock.json", kind: "generated" })];
  const findings = generatedDetector.run(files, { root: "/", gitAvailable: false });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.suggest, "ignore");
  assert.equal(findings[0]?.confidence, 0.75);
});

test("generated detector: path + header banner gets a higher confidence tier", () => {
  const files = [record({ path: "src/client.pb.go", kind: "generated", generatedHeader: true })];
  const findings = generatedDetector.run(files, { root: "/", gitAvailable: false });
  assert.equal(findings[0]?.confidence, 0.97);
});

test("generated detector: reason never contains raw file content, only templated metadata", () => {
  const files = [record({ path: "dist/bundle.js", kind: "generated" })];
  const findings = generatedDetector.run(files, { root: "/", gitAvailable: false });
  assert.match(findings[0]?.reason ?? "", /^generated file —/);
});
