import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCache, saveCache, isCacheValid, type CacheEntry } from "./index.js";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sherlock-cache-"));
}

test("loadCache: no cache file present returns an empty map", async () => {
  const dir = await tmp();
  try {
    const cache = await loadCache(dir);
    assert.equal(cache.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadCache: corrupt JSON is discarded silently, not thrown", async () => {
  const dir = await tmp();
  try {
    await fs.mkdir(path.join(dir, ".sherlock"), { recursive: true });
    await fs.writeFile(path.join(dir, ".sherlock", "cache.json"), "{ not json");
    const cache = await loadCache(dir);
    assert.equal(cache.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadCache: a format version mismatch is discarded, not migrated", async () => {
  const dir = await tmp();
  try {
    await fs.mkdir(path.join(dir, ".sherlock"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".sherlock", "cache.json"),
      JSON.stringify({ formatVersion: 999, entries: { "a.ts": { bytes: 1 } } }),
    );
    const cache = await loadCache(dir);
    assert.equal(cache.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveCache then loadCache: round-trips entries", async () => {
  const dir = await tmp();
  try {
    const entry: CacheEntry = { mtimeMs: 123, bytes: 456, tokens: 10, estimated: false, kind: "source" };
    await saveCache(dir, new Map([["src/a.ts", entry]]));
    const cache = await loadCache(dir);
    assert.deepEqual(cache.get("src/a.ts"), entry);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveCache: adds .sherlock/ to .gitignore on first run, doesn't duplicate on the second", async () => {
  const dir = await tmp();
  try {
    await saveCache(dir, new Map());
    const first = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    assert.match(first, /^\.sherlock\/$/m);

    await saveCache(dir, new Map());
    const second = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    assert.equal(second.match(/\.sherlock\//g)?.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveCache: respects an existing .gitignore that already ignores .sherlock", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n.sherlock/\n");
    await saveCache(dir, new Map());
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    assert.equal(content.match(/\.sherlock\//g)?.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("isCacheValid: matches only when bytes, mtime, and kind all agree", () => {
  const entry: CacheEntry = { mtimeMs: 100, bytes: 50, tokens: 5, estimated: false, kind: "source" };
  assert.equal(isCacheValid(entry, 50, 100, "source"), true);
  assert.equal(isCacheValid(entry, 51, 100, "source"), false);
  assert.equal(isCacheValid(entry, 50, 101, "source"), false);
  assert.equal(isCacheValid(entry, 50, 100, "doc"), false);
  assert.equal(isCacheValid(undefined, 50, 100, "source"), false);
});
