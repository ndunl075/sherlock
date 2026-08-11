import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph, type GraphInput } from "./index.js";

async function fixture(): Promise<{ root: string; files: GraphInput[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-graph-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });

  const specs: [string, string][] = [
    ["src/index.ts", `import { used } from "./lib";\nused();\n`],
    ["src/lib.ts", `export function used() {}\nexport function deadFn() {}\n`],
    ["src/orphan.ts", `export function nothing() {}\n`],
    ["src/reexported.ts", `export { used as reused } from "./lib";\n`],
  ];
  const files: GraphInput[] = [];
  for (const [rel, content] of specs) {
    const abs = path.join(root, ...rel.split("/"));
    await fs.writeFile(abs, content);
    const st = await fs.stat(abs);
    files.push({ path: rel, absPath: abs, tier: 1, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return { root, files };
}

test("buildGraph: entrypoint is never orphan and never dead-export-flagged", async () => {
  const { root, files } = await fixture();
  try {
    const { signals } = await buildGraph(files);
    const entry = signals.get("src/index.ts");
    assert.equal(entry?.orphan, false);
    assert.deepEqual(entry?.deadExports, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildGraph: a file reachable from an entrypoint is not orphan", async () => {
  const { root, files } = await fixture();
  try {
    const { signals } = await buildGraph(files);
    assert.equal(signals.get("src/lib.ts")?.orphan, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildGraph: an unreferenced export is flagged dead, a used one is not", async () => {
  const { root, files } = await fixture();
  try {
    const { signals } = await buildGraph(files);
    assert.deepEqual(signals.get("src/lib.ts")?.deadExports, ["deadFn"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildGraph: a file nothing imports is orphan", async () => {
  const { root, files } = await fixture();
  try {
    const { signals } = await buildGraph(files);
    assert.equal(signals.get("src/orphan.ts")?.orphan, true);
    assert.deepEqual(signals.get("src/orphan.ts")?.deadExports, ["nothing"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildGraph: a NodeNext-style '.js' specifier resolves against a '.ts' source file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-graph-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const files: GraphInput[] = [];
    for (const [rel, content] of [
      ["src/index.ts", `import { thing } from "./types.js";\nthing();\n`],
      ["src/types.ts", `export function thing() {}\n`],
    ] as [string, string][]) {
      const abs = path.join(root, ...rel.split("/"));
      await fs.writeFile(abs, content);
      const st = await fs.stat(abs);
      files.push({ path: rel, absPath: abs, tier: 1, bytes: st.size, mtimeMs: st.mtimeMs });
    }
    const { signals } = await buildGraph(files);
    assert.equal(signals.get("src/types.ts")?.orphan, false);
    assert.deepEqual(signals.get("src/types.ts")?.deadExports, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildGraph: a re-exported name resolves the source edge and counts as used there", async () => {
  const { root, files } = await fixture();
  try {
    const { signals } = await buildGraph(files);
    // reexported.ts's own export ("reused") is never imported by anyone -> dead
    assert.deepEqual(signals.get("src/reexported.ts")?.deadExports, ["reused"]);
    // lib.ts's "used" is referenced both directly (index.ts) and via the re-export -> not dead
    assert.deepEqual(signals.get("src/lib.ts")?.deadExports, ["deadFn"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildGraph: returns a moduleInfo per eligible file for the caller to cache", async () => {
  const { root, files } = await fixture();
  try {
    const { moduleInfos } = await buildGraph(files);
    assert.equal(moduleInfos.size, files.length);
    assert.deepEqual(moduleInfos.get("src/lib.ts")?.exportedNames, new Set(["used", "deadFn"]));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildGraph: getCached is used instead of reading the file, and its result flows through unchanged", async () => {
  const { root, files } = await fixture();
  try {
    const cachedInfo = { imports: [], reexports: [], exportedNames: new Set(["fake"]) };
    let calls = 0;
    const { signals, moduleInfos } = await buildGraph(files, {
      getCached: (p) => {
        if (p !== "src/orphan.ts") return undefined;
        calls++;
        return cachedInfo;
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(moduleInfos.get("src/orphan.ts"), cachedInfo);
    // the cached info's export ("fake") isn't imported anywhere -> still flagged dead, proving it was actually used
    assert.deepEqual(signals.get("src/orphan.ts")?.deadExports, ["fake"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
