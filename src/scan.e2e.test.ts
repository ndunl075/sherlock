import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scan } from "./index.js";
import { SCHEMA_VERSION } from "./report/json.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-scan-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", main: "./run.js", bin: { tool: "./run.js" } }),
  );
  await fs.writeFile(
    path.join(root, "run.js"),
    `const { helper } = require("./lib");\nmodule.exports = { start: helper };\n`,
  );
  await fs.writeFile(
    path.join(root, "lib.js"),
    `function helper() { return 1; }\nmodule.exports = { helper, unused: 2 };\n`,
  );
  await fs.writeFile(path.join(root, "orphan.cjs"), `module.exports = { alone: true };\n`);
  await fs.writeFile(
    path.join(root, "CLAUDE.md"),
    `# Fixture\n\n${"Resident guidance. ".repeat(80)}\n`,
  );
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "bundle.js"), "/* generated */\n");
  await fs.writeFile(path.join(root, "package-lock.json"), "{}\n");
  return root;
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // No --import path here: on Windows absolute --import paths must be file:// URLs.
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 2, stdout, stderr }));
  });
}

test("scan(): CommonJS require graph + package.json main seed; JSON contract fields present", async () => {
  const root = await makeFixture();
  try {
    const result = await scan(root, { budget: 10 });
    assert.equal(result.budgetExplicit, true);
    assert.ok(result.files.some((f) => f.path === "run.js"));
    assert.ok(result.files.some((f) => f.path === "lib.js"));

    const lib = result.files.find((f) => f.path === "lib.js");
    assert.equal(lib?.orphanModule, false, "lib.js is required from package main");

    const orphan = result.files.find((f) => f.path === "orphan.cjs");
    assert.equal(orphan?.orphanModule, true, "orphan.cjs is unreachable");

    assert.ok(result.findings.some((f) => f.detector === "generated"));
    assert.ok(
      result.rollup.residentTokens > 10,
      `expected resident tokens > 10, got ${result.rollup.residentTokens}`,
    );
    assert.equal(result.rollup.overBudget, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI: --help exits 0; --json prints schemaVersion; --budget gate exits 1", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /sherlock/);

  const root = await makeFixture();
  try {
    const json = await runCli(["--json", root]);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as { schemaVersion: number; findings: unknown[] };
    assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
    assert.ok(Array.isArray(parsed.findings));

    const gated = await runCli(["--budget", "1", root]);
    assert.equal(gated.code, 1, gated.stderr);

    const bad = await runCli(["--json", "--emit-ignore", root]);
    assert.equal(bad.code, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
