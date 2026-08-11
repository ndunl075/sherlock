import { test } from "node:test";
import assert from "node:assert/strict";
import { isLikelyEntrypoint } from "./entrypoints.js";

test("isLikelyEntrypoint: known basenames match regardless of directory", () => {
  assert.equal(isLikelyEntrypoint("src/index.ts", 1), true);
  assert.equal(isLikelyEntrypoint("cli.ts", 1), true);
});

test("isLikelyEntrypoint: tier 0 is always an entrypoint", () => {
  assert.equal(isLikelyEntrypoint("CLAUDE.md", 0), true);
});

test("isLikelyEntrypoint: test/spec files are entrypoints — invoked directly, never imported", () => {
  assert.equal(isLikelyEntrypoint("src/graph/parse.test.ts", 1), true);
  assert.equal(isLikelyEntrypoint("src/foo.spec.js", 1), true);
});

test("isLikelyEntrypoint: ordinary source files are not entrypoints", () => {
  assert.equal(isLikelyEntrypoint("src/util/posix-path.ts", 1), false);
});
