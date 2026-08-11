#!/usr/bin/env node
// CLI — ARCHITECTURE.md §3 (cli.ts), §8 (output), §9 exit codes.
//
// Exit codes: 0 clean · 1 budget exceeded (only when a budget was set
// explicitly — via --budget or .sherlockrc; a bare `sherlock` never fails
// the process) · 2 scan error.

import process from "node:process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { scan } from "./index.js";
import { renderTable } from "./report/table.js";
import { renderJson } from "./report/json.js";
import { renderIgnorePatch } from "./report/ignore.js";

interface Args {
  root: string;
  json: boolean;
  emitIgnore: boolean;
  budget?: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: ".", json: false, emitIgnore: false, help: false };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--emit-ignore") args.emitIgnore = true;
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
  sherlock --emit-ignore [path]  print a .claudeignore patch for safe ignore suggestions
  sherlock --budget <n> [path] exit 1 when resident context exceeds n tokens

Options:
  --json          machine-readable output (stable schema, see ARCHITECTURE.md §11)
  --emit-ignore   unified diff for .claudeignore; never writes to the repo
  --budget <n>    resident-context budget in tokens; CI gate when set
                  (overrides .sherlockrc's "budget" key if both are present)
  -h, --help      show this help

.sherlockrc (JSON, repo root) can also set "budget" and "cadence" — see
ARCHITECTURE.md §11. Either source enables the exit-1 CI gate.
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
    const result = await scan(args.root, args.budget !== undefined ? { budget: args.budget } : {});

    if (args.json && args.emitIgnore) {
      process.stderr.write("--json and --emit-ignore cannot be used together\n");
      return 2;
    }
    if (args.json) {
      process.stdout.write(`${renderJson(result.root, result.rollup, result.findings)}\n`);
    } else if (args.emitIgnore) {
      let existing: string | undefined;
      try {
        existing = await fs.readFile(path.join(result.root, ".claudeignore"), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      process.stdout.write(renderIgnorePatch(existing, result.findings));
    } else {
      process.stdout.write(`${renderTable(result.rollup, result.files, result.findings)}\n`);
    }

    if (result.budgetExplicit && result.rollup.overBudget) return 1;
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
