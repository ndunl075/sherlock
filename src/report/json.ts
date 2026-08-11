// --json output — ARCHITECTURE.md §8, §11.
//
// This is the CI contract: stable schema, versioned via schemaVersion,
// additive fields only. Don't rename or remove a field here without bumping
// schemaVersion and treating it as a breaking (major) change.

import type { Finding } from "../types.js";
import type { Rollup } from "../score/index.js";

export const SCHEMA_VERSION = 1;

export interface JsonReport {
  schemaVersion: typeof SCHEMA_VERSION;
  root: string;
  rollup: {
    fileCount: number;
    residentTokens: number;
    reachableTokens: number;
    ambientTokens: number;
    budget: number;
    overBudget: boolean;
    overagePct: number;
    recoverableTokens: number;
  };
  findings: Finding[];
}

export function toJsonReport(root: string, rollup: Rollup, findings: Finding[]): JsonReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    root,
    rollup: {
      fileCount: rollup.fileCount,
      residentTokens: rollup.residentTokens,
      reachableTokens: rollup.reachableTokens,
      ambientTokens: rollup.ambientTokens,
      budget: rollup.budget,
      overBudget: rollup.overBudget,
      overagePct: rollup.overagePct,
      recoverableTokens: rollup.recoverableTokens,
    },
    findings,
  };
}

export function renderJson(root: string, rollup: Rollup, findings: Finding[]): string {
  return JSON.stringify(toJsonReport(root, rollup, findings), null, 2);
}
