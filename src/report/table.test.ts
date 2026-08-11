import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTable } from "./table.js";
import type { FileRecord, Finding } from "../types.js";
import type { Rollup } from "../score/index.js";

const rollup: Rollup = {
  fileCount: 3, residentTokens: 0, reachableTokens: 300, ambientTokens: 0,
  budget: 3000, overBudget: false, overagePct: -100, recoverableTokens: 100,
  ranked: [
    { path: "src/review.ts", waste: 50 },
    { path: "dist/bundle.js", waste: 40 },
    { path: "CLAUDE.md", waste: 10 },
  ],
};
const files: FileRecord[] = [];
const findings: Finding[] = [
  { path: "src/review.ts", detector: "orphan-module", confidence: 0.5, reason: "review", suggest: "review" },
  { path: "dist/bundle.js", detector: "generated", confidence: 0.9, reason: "ignore", suggest: "ignore" },
  { path: "CLAUDE.md", detector: "t0-overweight", confidence: 0.8, reason: "split", suggest: "split" },
];

test("renderTable: groups the top twenty ranked files by suggested action", () => {
  const output = renderTable(rollup, files, findings);
  assert.ok(output.indexOf("  IGNORE") < output.indexOf("  SPLIT"));
  assert.ok(output.indexOf("  SPLIT") < output.indexOf("  REVIEW"));
  assert.match(output, /dist\/bundle\.js/);
  assert.match(output, /CLAUDE\.md/);
  assert.match(output, /src\/review\.ts/);
});

test("renderTable: empty findings falls back to resident listing copy, not a missing-detector claim", () => {
  const output = renderTable(
    { ...rollup, ranked: [] },
    [{ path: "CLAUDE.md", bytes: 10, tokens: 100, estimated: false, kind: "doc", tier: 0 }],
    [],
  );
  assert.match(output, /No findings/);
  assert.doesNotMatch(output, /No detectors registered/);
  assert.match(output, /CLAUDE\.md/);
});
