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
  assert.ok(paths.includes("lib/index.js"));
  assert.ok(paths.includes("dist/bin.mjs"));
  assert.ok(paths.includes("src/bin.mjs"), "dist/bin.mjs expands to src twin");
  assert.ok(paths.includes("scripts/other.js"));
  assert.ok(paths.includes("lib/index.cjs"));
  assert.ok(paths.includes("dist/cli.js"));
});

test("collectPackageEntrypoints: picks local paths out of scripts", () => {
  const paths = collectPackageEntrypoints({
    scripts: {
      bench: "node --import ./bench/set-uv.mjs bench/scan.bench.mjs",
      dev: "node dist/cli.js",
    },
  });
  assert.ok(paths.includes("bench/set-uv.mjs"));
  assert.ok(paths.includes("bench/scan.bench.mjs"));
  assert.ok(paths.includes("dist/cli.js"));
  assert.ok(paths.includes("src/cli.js") || paths.includes("src/cli.ts"));
});

test("collectPackageEntrypoints: ignores non-objects and empty", () => {
  assert.deepEqual(collectPackageEntrypoints(null), []);
  assert.deepEqual(collectPackageEntrypoints("nope"), []);
  assert.deepEqual(collectPackageEntrypoints({}), []);
});

