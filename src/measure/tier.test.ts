import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assignTiers } from "./tier.js";
import { classify } from "../classify/index.js";
import type { DiscoveredFile } from "../discover/index.js";

async function fixture(): Promise<{ root: string; files: DiscoveredFile[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-tier-"));
  await fs.mkdir(path.join(root, "imports"), { recursive: true });
  await fs.mkdir(path.join(root, "vendor"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });

  const specs: [string, string][] = [
    ["CLAUDE.md", "root instructions\n@imports/style.md\n"],
    ["imports/style.md", "style guide contents"],
    ["vendor/sdk.js", "// vendored"],
    ["src/index.ts", "export const x = 1;"],
  ];
  const files: DiscoveredFile[] = [];
  for (const [rel, content] of specs) {
    const abs = path.join(root, ...rel.split("/"));
    await fs.writeFile(abs, content);
    const st = await fs.stat(abs);
    files.push({ path: rel, absPath: abs, bytes: st.size });
  }
  return { root, files };
}

test("assignTiers: CLAUDE.md and its @import resolve to tier 0", async () => {
  const { root, files } = await fixture();
  try {
    const kindOf = (p: string) => classify(p);
    const tiers = await assignTiers(files, kindOf);
    assert.equal(tiers.get("CLAUDE.md"), 0);
    assert.equal(tiers.get("imports/style.md"), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("assignTiers: vendored files land in tier 2, ordinary source in tier 1", async () => {
  const { root, files } = await fixture();
  try {
    const kindOf = (p: string) => classify(p);
    const tiers = await assignTiers(files, kindOf);
    assert.equal(tiers.get("vendor/sdk.js"), 2);
    assert.equal(tiers.get("src/index.ts"), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
