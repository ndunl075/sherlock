import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, loadConfig } from "./index.js";
import { DEFAULT_BUDGET, DEFAULT_CADENCE } from "../types.js";

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

async function captureStderrAsync<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

test("parseConfig: non-object input falls back to defaults and warns", () => {
  const { result: config, stderr } = captureStderr(() => parseConfig("not an object"));
  assert.deepEqual(config, { budget: DEFAULT_BUDGET, budgetExplicit: false, cadence: DEFAULT_CADENCE });
  assert.match(stderr, /must contain a JSON object/);
});

test("parseConfig: valid budget is applied and marked explicit", () => {
  const config = parseConfig({ budget: 5000 });
  assert.equal(config.budget, 5000);
  assert.equal(config.budgetExplicit, true);
});

test("parseConfig: invalid budget is ignored, stays implicit", () => {
  const { result: config } = captureStderr(() => parseConfig({ budget: -1 }));
  assert.equal(config.budget, DEFAULT_BUDGET);
  assert.equal(config.budgetExplicit, false);
});

test("parseConfig: partial cadence override merges with defaults", () => {
  const config = parseConfig({ cadence: { "0": 2.0 } });
  assert.equal(config.cadence[0], 2.0);
  assert.equal(config.cadence[1], DEFAULT_CADENCE[1]);
  assert.equal(config.cadence[2], DEFAULT_CADENCE[2]);
});

test("parseConfig: invalid cadence tier key is ignored, valid ones still applied", () => {
  const { result: config } = captureStderr(() => parseConfig({ cadence: { "0": 0.9, "5": 1.0 } }));
  assert.equal(config.cadence[0], 0.9);
  assert.equal(Object.keys(config.cadence).length, 3); // no stray "5" key
});

test("parseConfig: unknown top-level key warns but doesn't throw, other keys still apply", () => {
  const { result: config, stderr } = captureStderr(() =>
    parseConfig({ budget: 4000, plugins: ["evil.js"], command: "rm -rf /" }),
  );
  assert.equal(config.budget, 4000);
  assert.match(stderr, /unknown key "plugins"/);
  assert.match(stderr, /unknown key "command"/);
});

test("loadConfig: no .sherlockrc present returns defaults silently", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-config-"));
  try {
    const config = await loadConfig(dir);
    assert.deepEqual(config, { budget: DEFAULT_BUDGET, budgetExplicit: false, cadence: DEFAULT_CADENCE });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig: reads a valid .sherlockrc", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-config-"));
  try {
    await fs.writeFile(path.join(dir, ".sherlockrc"), JSON.stringify({ budget: 8000 }));
    const config = await loadConfig(dir);
    assert.equal(config.budget, 8000);
    assert.equal(config.budgetExplicit, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig: invalid JSON degrades to defaults instead of throwing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-config-"));
  try {
    await fs.writeFile(path.join(dir, ".sherlockrc"), "{ not valid json");
    const { result: config } = await captureStderrAsync(() => loadConfig(dir));
    assert.deepEqual(config, { budget: DEFAULT_BUDGET, budgetExplicit: false, cadence: DEFAULT_CADENCE });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
