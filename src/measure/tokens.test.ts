import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultTokenizer, measureTokens } from "./tokens.js";

test("defaultTokenizer: roughly scales with text length, never zero for nonempty text", () => {
  assert.equal(defaultTokenizer.countTokens(""), 0);
  const short = defaultTokenizer.countTokens("hello world");
  const long = defaultTokenizer.countTokens("hello world ".repeat(50));
  assert.ok(short > 0);
  assert.ok(long > short * 10);
});

test("measureTokens: small file is read in full and marked exact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-tokens-"));
  try {
    const p = path.join(dir, "small.ts");
    await fs.writeFile(p, "export const x = 1;\n");
    const st = await fs.stat(p);
    const result = await measureTokens({ path: "small.ts", absPath: p, bytes: st.size, mtimeMs: st.mtimeMs }, 1, "source");
    assert.equal(result.estimated, false);
    assert.ok(result.tokens > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("measureTokens: tier 0 files are read in full even when large", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-tokens-"));
  try {
    const p = path.join(dir, "CLAUDE.md");
    await fs.writeFile(p, "word ".repeat(10_000)); // ~50KB, above the sample threshold
    const st = await fs.stat(p);
    const result = await measureTokens({ path: "CLAUDE.md", absPath: p, bytes: st.size, mtimeMs: st.mtimeMs }, 0, "doc");
    assert.equal(result.estimated, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("measureTokens: large tier-1 file is sampled and estimated", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-tokens-"));
  try {
    const p = path.join(dir, "big.md");
    await fs.writeFile(p, "word ".repeat(10_000));
    const st = await fs.stat(p);
    const result = await measureTokens({ path: "big.md", absPath: p, bytes: st.size, mtimeMs: st.mtimeMs }, 1, "doc");
    assert.equal(result.estimated, true);
    assert.ok(result.tokens > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("measureTokens: binary kind is never tokenized", async () => {
  const result = await measureTokens({ path: "logo.png", absPath: "/nonexistent", bytes: 12345, mtimeMs: 0 }, 1, "binary");
  assert.deepEqual(result, { tokens: 0, estimated: true, headSample: "" });
});
