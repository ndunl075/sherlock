import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, toJsonReport, renderJson } from "./json.js";
import type { Finding } from "../types.js";
import type { Rollup } from "../score/index.js";

const rollup: Rollup = {
  fileCount: 2,
  residentTokens: 100,
  reachableTokens: 200,
  ambientTokens: 0,
  budget: 3000,
  overBudget: false,
  overagePct: 0,
  ranked: [{ path: "a.ts", waste: 10 }],
  recoverableTokens: 10,
};

const findings: Finding[] = [
  {
    path: "a.ts",
    detector: "orphan-module",
    confidence: 0.55,
    reason: "unreachable from any inferred entrypoint via module-graph edges",
    suggest: "review",
  },
];

test("toJsonReport: schemaVersion and required rollup/finding fields (CI contract)", () => {
  const report = toJsonReport("/repo", rollup, findings);
  assert.equal(report.schemaVersion, SCHEMA_VERSION);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.root, "/repo");
  assert.equal(report.rollup.fileCount, 2);
  assert.equal(report.rollup.residentTokens, 100);
  assert.equal(report.rollup.reachableTokens, 200);
  assert.equal(report.rollup.ambientTokens, 0);
  assert.equal(report.rollup.budget, 3000);
  assert.equal(report.rollup.overBudget, false);
  assert.equal(report.rollup.overagePct, 0);
  assert.equal(report.rollup.recoverableTokens, 10);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.detector, "orphan-module");
  assert.equal(report.findings[0]?.suggest, "review");
});

test("renderJson: parses back to the same schemaVersion contract", () => {
  const parsed = JSON.parse(renderJson("/repo", rollup, findings)) as {
    schemaVersion: number;
    findings: Finding[];
  };
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.findings[0]?.path, "a.ts");
});
