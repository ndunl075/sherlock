import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isGitRepo, loadHistory } from "./index.js";

const execFileAsync = promisify(execFile);

test("isGitRepo: false for a plain directory, true for an initialized git repo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-hist-"));
  try {
    assert.equal(await isGitRepo(root), false);
    await execFileAsync("git", ["init"], { cwd: root });
    assert.equal(await isGitRepo(root), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadHistory: empty map when not a git repo (degrades, never throws)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-hist-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "hi");
    const hist = await loadHistory(root);
    assert.equal(hist.size, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadHistory: records lastCommit for a committed file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-hist-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await fs.writeFile(path.join(root, "tracked.txt"), "hello");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });

    const hist = await loadHistory(root);
    const info = hist.get("tracked.txt");
    assert.ok(info?.lastCommit !== undefined);
    assert.ok((info?.commits90d ?? 0) >= 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
