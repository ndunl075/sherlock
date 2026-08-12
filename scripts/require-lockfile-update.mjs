#!/usr/bin/env node
// CI helper: package metadata (scripts, files, exports) does not belong in
// package-lock.json. Require a lockfile change only when dependency sections
// change, so the gate catches real resolution drift without false failures.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const base = process.argv[2];
if (!base) throw new Error("usage: require-lockfile-update.mjs <base-sha>");

const dependencyKeys = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function dependencyShape(pkg) {
  return Object.fromEntries(
    dependencyKeys.map((key) => [
      key,
      Object.fromEntries(Object.entries(pkg[key] ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    ]),
  );
}

const before = JSON.parse(execFileSync("git", ["show", `${base}:package.json`], { encoding: "utf8" }));
const after = JSON.parse(readFileSync("package.json", "utf8"));
if (JSON.stringify(dependencyShape(before)) === JSON.stringify(dependencyShape(after))) process.exit(0);

try {
  execFileSync("git", ["diff", "--quiet", base, "HEAD", "--", "package-lock.json"]);
} catch (error) {
  if (error.status === 1) process.exit(0); // changed lockfile
  throw error;
}

console.error("dependency sections changed without a matching package-lock.json update");
process.exit(1);
