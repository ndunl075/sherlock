import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPackageEntrypoints, normalizePackagePath } from "./package-entrypoints.js";

test("normalizePackagePath: strips ./ and rejects URLs / absolute paths", () => {
  assert.equal(normalizePackagePath("./bin/cli.js"), "bin/cli.js");
  assert.equal(normalizePackagePath("dist/index.js"), "dist/index.js");
  assert.equal(normalizePackagePath("https://example.com/x.js"), undefined);
  assert.equal(normalizePackagePath("/abs/path.js"), undefined);
  assert.equal(normalizePackagePath("lodash"), undefined);
});

test("collectPackageEntrypoints: main + bin object + nested exports", () => {
  const paths = collectPackageEntrypoints({
    main: "./lib/index.js",
    bin: { sherlock: "./dist/bin.mjs", other: "scripts/other.js" },
    exports: {
      ".": { import: "./lib/index.js", require: "./lib/index.cjs" },
      "./cli": "./dist/cli.js",
    },
  });
  assert.deepEqual(
    new Set(paths),
    new Set(["lib/index.js", "dist/bin.mjs", "scripts/other.js", "lib/index.cjs", "dist/cli.js"]),
  );
});

test("collectPackageEntrypoints: ignores non-objects and empty", () => {
  assert.deepEqual(collectPackageEntrypoints(null), []);
  assert.deepEqual(collectPackageEntrypoints("nope"), []);
  assert.deepEqual(collectPackageEntrypoints({}), []);
});
