import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discover } from "./index.js";

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-discover-"));
  await fs.mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports = {};");
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const x = 1;");
  await fs.writeFile(path.join(root, ".gitignore"), "*.log\n");
  await fs.writeFile(path.join(root, "debug.log"), "noisy");
  await fs.writeFile(path.join(root, "README.md"), "# hi");
  return root;
}

test("discover: respects baseline ignores and .gitignore, returns posix paths", async () => {
  const root = await makeFixture();
  try {
    const files = await discover(root);
    const paths = files.map((f) => f.path).sort();
    assert.deepEqual(paths, [".gitignore", "README.md", "src/index.ts"]);
    for (const f of files) assert.ok(!f.path.includes("\\"), `expected posix path, got ${f.path}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discover: never follows a symlink that escapes the repo root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-discover-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-outside-"));
  try {
    await fs.writeFile(path.join(outside, "secret.txt"), "do not read");
    const linkPath = path.join(root, "escape");
    try {
      await fs.symlink(outside, linkPath, "junction");
    } catch {
      return; // symlink privilege unavailable in this environment — skip rather than fail CI
    }
    const files = await discover(root);
    assert.equal(files.some((f) => f.path.startsWith("escape")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("discover: skips files over the per-file byte cap before readers can open them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-discover-"));
  try {
    await fs.writeFile(path.join(root, "small.txt"), "small");
    await fs.writeFile(path.join(root, "large.txt"), "this is too large");
    const files = await discover(root, { maxFileBytes: 8 });
    assert.deepEqual(files.map((f) => f.path), ["small.txt"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discover: stops accepting files once the total-byte cap is reached", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-discover-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "1234");
    await fs.writeFile(path.join(root, "b.txt"), "5678");
    const files = await discover(root, { maxTotalBytes: 6 });
    assert.equal(files.length, 1);
    assert.equal(files[0]?.bytes, 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discover: respects maxDepth and maxFiles caps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-discover-"));
  try {
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "root.txt"), "r");
    await fs.writeFile(path.join(root, "a", "mid.txt"), "m");
    await fs.writeFile(path.join(root, "a", "b", "deep.txt"), "d");

    const shallow = await discover(root, { maxDepth: 1 });
    const shallowPaths = shallow.map((f) => f.path).sort();
    assert.ok(shallowPaths.includes("root.txt"));
    assert.ok(shallowPaths.includes("a/mid.txt"));
    assert.equal(shallowPaths.includes("a/b/deep.txt"), false);

    const capped = await discover(root, { maxFiles: 2 });
    assert.equal(capped.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discover: never follows a file symlink that escapes the repo root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-discover-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-outside-"));
  try {
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "do not read");
    const linkPath = path.join(root, "leak.txt");
    try {
      await fs.symlink(secret, linkPath);
    } catch {
      return; // symlink privilege unavailable — skip
    }
    const files = await discover(root);
    assert.equal(files.some((f) => f.path === "leak.txt"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
