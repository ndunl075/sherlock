import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIgnorePatch } from "./ignore.js";
import type { Finding } from "../types.js";

const finding = (path: string, suggest: Finding["suggest"] = "ignore"): Finding => ({
  path, detector: "generated", confidence: 1, reason: "generated", suggest,
});

test("renderIgnorePatch: makes a new .claudeignore diff from unique ignore findings", () => {
  assert.equal(
    renderIgnorePatch(undefined, [finding("dist/"), finding("dist/"), finding("vendor/sdk.ts"), finding("README.md", "review")]),
    "--- /dev/null\n+++ b/.claudeignore\n@@ -0,0 +1,2 @@\n+dist/\n+vendor/sdk.ts\n",
  );
});

test("renderIgnorePatch: preserves existing lines and does not re-add them", () => {
  assert.equal(
    renderIgnorePatch("# generated\ndist/\n", [finding("dist/"), finding("vendor/sdk.ts")]),
    "--- a/.claudeignore\n+++ b/.claudeignore\n@@ -1,2 +1,3 @@\n # generated\n dist/\n+vendor/sdk.ts\n",
  );
});

test("renderIgnorePatch: is empty when there is nothing safe to add", () => {
  assert.equal(renderIgnorePatch("dist/\n", [finding("dist/"), finding("README.md", "review")]), "");
});

test("renderIgnorePatch: can target Cursor's ignore file", () => {
  assert.match(renderIgnorePatch(undefined, [finding("dist/")], ".cursorignore"), /\+\+\+ b\/\.cursorignore/);
});
