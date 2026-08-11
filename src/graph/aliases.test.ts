import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyPathAlias,
  loadPathAliases,
  parsePathAliasConfig,
} from "./aliases.js";

test("parsePathAliasConfig: baseUrl + wildcard and exact patterns", () => {
  const cfg = parsePathAliasConfig(
    {
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["src/*"],
          "@lib": ["src/lib/index.ts"],
        },
      },
    },
    "",
  )!;
  assert.equal(applyPathAlias("@/util/foo", cfg), "src/util/foo");
  assert.equal(applyPathAlias("@lib", cfg), "src/lib/index.ts");
  assert.equal(applyPathAlias("./relative", cfg), undefined);
  assert.equal(applyPathAlias("unmapped", cfg), undefined);
});

test("parsePathAliasConfig: baseUrl nested under config dir", () => {
  const cfg = parsePathAliasConfig(
    {
      compilerOptions: {
        baseUrl: "./",
        paths: { "~/*": ["./*"] },
      },
    },
    "packages/app",
  )!;
  assert.equal(applyPathAlias("~/x", cfg), "packages/app/x");
});

test("loadPathAliases: reads tsconfig.json from repo root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-alias-"));
  try {
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      `{
        // comment allowed
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["src/*"], },
        }
      }`,
    );
    const cfg = await loadPathAliases(root);
    assert.equal(applyPathAlias("@/a/b", cfg!), "src/a/b");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadPathAliases: absent config returns undefined", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-alias-"));
  try {
    assert.equal(await loadPathAliases(root), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
