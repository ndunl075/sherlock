import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyPathAlias,
  loadBundlerAliases,
  loadPathAliases,
  parseBundlerAliases,
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

test("parseBundlerAliases: Vite object aliases support literal, path.resolve, and URL forms", () => {
  const cfg = parseBundlerAliases(`
    export default defineConfig({ resolve: { alias: {
      "@": path.resolve(__dirname, "src"),
      "~": fileURLToPath(new URL("./app", import.meta.url)),
      "literal": "./shared",
      "outside": "../private",
    } } });
  `)!;
  assert.equal(applyPathAlias("@/lib/x", cfg), "src/lib/x");
  assert.equal(applyPathAlias("~/ui/button", cfg), "app/ui/button");
  assert.equal(applyPathAlias("literal/math", cfg), "shared/math");
  assert.equal(applyPathAlias("outside/nope", cfg), undefined);
});

test("parseBundlerAliases: Vite array aliases support exact webpack-style keys", () => {
  const cfg = parseBundlerAliases(`
    resolve: { alias: [
      { find: "@", replacement: "./src" },
      { find: "runtime$", replacement: "./runtime/index.ts" },
    ] },
  `)!;
  assert.equal(applyPathAlias("@/lib/x", cfg), "src/lib/x");
  assert.equal(applyPathAlias("runtime", cfg), "runtime/index.ts");
  assert.equal(applyPathAlias("runtime/extra", cfg), undefined);
});

test("loadBundlerAliases: reads Vite and Webpack config as static text, never executes it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-bundler-alias-"));
  try {
    await fs.writeFile(path.join(root, "vite.config.ts"), `export default { resolve: { alias: { "@": "./src" } } };`);
    await fs.writeFile(path.join(root, "webpack.config.cjs"), `throw new Error("must not execute"); module.exports = { resolve: { alias: { "~": "./app" } } };`);
    const cfg = await loadBundlerAliases(root);
    assert.equal(applyPathAlias("@/a", cfg!), "src/a");
    assert.equal(applyPathAlias("~/b", cfg!), "app/b");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
