#!/usr/bin/env node
// CLI — ARCHITECTURE.md §3 (cli.ts), §8 (output), §9 exit codes.
//
// Exit codes: 0 clean · 1 budget exceeded (only when --budget is passed
// explicitly — a bare `sherlock` never fails the process) · 2 scan error.

import process from "node:process";
import { scan } from "./index.js";
import { renderTable } from "./report/table.js";
import { renderJson } from "./report/json.js";
import { DEFAULT_BUDGET } from "./types.js";

interface Args {
  root: string;
  json: boolean;
  budget?: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: ".", json: false, help: false };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--budget") {
      const next = argv[++i];
      const n = Number(next);
      if (!next || Number.isNaN(n)) {
        throw new Error(`--budget expects a number, got ${JSON.stringify(next)}`);
      }
      args.budget = n;
    } else if (a?.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (a) {
      positionals.push(a);
    }
  }

  if (positionals[0]) args.root = positionals[0];
  return args;
}

const HELP = `sherlock — a context budget linter

Usage:
  sherlock [path]              ranked report for the repo at [path] (default: cwd)
  sherlock --json [path]       full Finding[] + rollup as stable JSON
  sherlock --budget <n> [path] exit 1 when resident context exceeds n tokens

Options:
  --json          machine-readable output (stable schema, see ARCHITECTURE.md §11)
  --budget <n>    resident-context budget in tokens; CI gate when set
  -h, --help      show this help
`;

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    const result = await scan(args.root, { budget: args.budget ?? DEFAULT_BUDGET });

    if (args.json) {
      process.stdout.write(`${renderJson(result.root, result.rollup, result.findings)}\n`);
    } else {
      process.stdout.write(`${renderTable(result.rollup, result.files, result.findings)}\n`);
    }

    if (args.budget !== undefined && result.rollup.overBudget) return 1;
    return 0;
  } catch (err) {
    process.stderr.write(`sherlock: scan failed: ${(err as Error).message}\n`);
    return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`sherlock: unexpected error: ${(err as Error)?.stack ?? err}\n`);
    process.exit(2);
  },
);
