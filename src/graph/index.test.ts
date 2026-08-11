import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph } from "./index.js";
import { parsePathAliasConfig } from "./aliases.js";

test("buildGraph: tsconfig path aliases create reachability edges", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-graph-alias-"));
  try {
    await fs.writeFile(
      path.join(root, "entry.ts"),
      `import { helper } from "@/lib/helper";\nexport const run = helper;\n`,
    );
    await fs.mkdir(path.join(root, "src", "lib"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "lib", "helper.ts"), `export function helper() { return 1; }\n`);

    const aliases = parsePathAliasConfig(
      { compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } },
      "",
    )!;

    const result = await buildGraph(
      [
        {
          path: "entry.ts",
          absPath: path.join(root, "entry.ts"),
          tier: 1,
          bytes: 50,
          mtimeMs: 1,
        },
        {
          path: "src/lib/helper.ts",
          absPath: path.join(root, "src", "lib", "helper.ts"),
          tier: 1,
          bytes: 40,
          mtimeMs: 1,
        },
      ],
      { pathAliases: aliases, packageEntrypoints: ["entry.ts"] },
    );

    assert.equal(result.signals.get("src/lib/helper.ts")?.orphan, false);
    assert.deepEqual(result.signals.get("src/lib/helper.ts")?.deadExports ?? [], []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
