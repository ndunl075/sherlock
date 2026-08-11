import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, needsContentSniff, looksBinary } from "./index.js";

test("classify: lockfiles are generated", () => {
  assert.equal(classify("package-lock.json"), "generated");
  assert.equal(classify("yarn.lock"), "generated");
});

test("classify: dist/build paths are generated", () => {
  assert.equal(classify("dist/index.js"), "generated");
  assert.equal(classify("packages/api/build/bundle.js"), "generated");
});

test("classify: vendor/node_modules paths are vendored", () => {
  assert.equal(classify("vendor/sdk-bundle.js"), "vendored");
  assert.equal(classify("node_modules/left-pad/index.js"), "vendored");
});

test("classify: fixtures directories are fixture", () => {
  assert.equal(classify("test/fixtures/sample.json"), "fixture");
  assert.equal(classify("__snapshots__/App.test.js.snap"), "fixture");
});

test("classify: markdown is doc", () => {
  assert.equal(classify("README.md"), "doc");
  assert.equal(classify("docs/guide.mdx"), "doc");
});

test("classify: known extensions are source", () => {
  assert.equal(classify("src/index.ts"), "source");
  assert.equal(classify("main.py"), "source");
});

test("classify: known binary extensions are binary without a sniff", () => {
  assert.equal(classify("logo.png"), "binary");
});

test("classify: content sniff overrides an unknown extension", () => {
  const binary = Buffer.from([0, 1, 2, 3, 255, 254]);
  assert.equal(classify("weird.xyz", binary), "binary");
});

test("needsContentSniff: false for anything path-classifiable", () => {
  assert.equal(needsContentSniff("README.md"), false);
  assert.equal(needsContentSniff("src/index.ts"), false);
  assert.equal(needsContentSniff("vendor/thing.xyz"), false);
});

test("needsContentSniff: true for a genuinely unknown extension outside any signal dir", () => {
  assert.equal(needsContentSniff("weird.xyz"), true);
});

test("looksBinary: NUL byte trips it, plain text doesn't", () => {
  assert.equal(looksBinary(Buffer.from("hello world")), false);
  assert.equal(looksBinary(Buffer.from([104, 0, 105])), true);
});
