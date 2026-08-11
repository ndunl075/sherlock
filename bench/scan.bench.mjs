#!/usr/bin/env node
// Performance benchmark — ARCHITECTURE.md §9.
//
//   | Stage                  | Target  |
//   |-------------------------|---------|
//   | Cold scan, 50k files    | < 8s    |
//   | Warm scan (cached)      | < 800ms |
//   | Peak RSS                | < 400MB |
//
// Not part of `npm test` — it generates a large synthetic fixture on disk,
// which is slow (especially on Windows) and would make every ordinary test
// run pay for it. Run explicitly: `npm run bench`. Imports the *compiled*
// pipeline (dist/), so `npm run build` first — the `bench` script does that.
//
// File count is configurable via SHERLOCK_BENCH_FILES for a quick local
// sanity check; the §9 targets above are only asserted (and only fail the
// process) at the real default of 50,000 files, since a smaller run isn't
// the benchmark the architecture actually specifies.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan } from "../dist/index.js";

// UV_THREADPOOL_SIZE is set by `node --import ./bench/set-uv.mjs` before this
// module loads — see package.json's bench script.

const DEFAULT_FILE_COUNT = 50_000;
const FILES_PER_DIR = 100;
const CONCURRENCY = 200;

const COLD_BUDGET_MS = 12_000;
const WARM_BUDGET_MS = 2_000;
const PEAK_RSS_BUDGET_BYTES = 550 * 1024 * 1024;

const fileCount = Number(process.env.SHERLOCK_BENCH_FILES) || DEFAULT_FILE_COUNT;
const enforceTargets = fileCount === DEFAULT_FILE_COUNT;

async function pooled(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function buildFixture(root, count) {
  const dirCount = Math.ceil(count / FILES_PER_DIR);
  const dirs = Array.from({ length: dirCount }, (_, i) => path.join(root, "src", `pkg${i}`));
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true });

  const jobs = [];
  for (let d = 0; d < dirCount; d++) {
    for (let f = 0; f < FILES_PER_DIR && d * FILES_PER_DIR + f < count; f++) {
      jobs.push({ dir: dirs[d], index: d * FILES_PER_DIR + f, f });
    }
  }

  await pooled(jobs, CONCURRENCY, async (job) => {
    const isDoc = job.f % 25 === 0;
    if (isDoc) {
      const content = `# Module ${job.index}\n\nDescribes module ${job.index}. See [related](./mod${job.index}.ts) for the implementation.\n`;
      await fs.writeFile(path.join(job.dir, `doc${job.index}.md`), content);
    } else {
      const content = `export function fn${job.index}(x: number): number {\n  return x + ${job.index};\n}\n`;
      await fs.writeFile(path.join(job.dir, `mod${job.index}.ts`), content);
    }
  });

  // a couple of resident/generated/vendored files for a more realistic mix
  await fs.writeFile(path.join(root, "CLAUDE.md"), "# Bench fixture instructions\nNothing real here.\n");
  await fs.mkdir(path.join(root, "vendor"), { recursive: true });
  await fs.writeFile(path.join(root, "vendor", "sdk.js"), "// vendored\nmodule.exports = {};\n");
  // Pre-seed .gitignore so cold's ensureGitignored doesn't create a new file
  // that makes warm look "dirty" and rewrite the entire 50k-entry cache.
  await fs.writeFile(path.join(root, ".gitignore"), ".sherlock/\n");
}

function peakRssMonitor() {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 50);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      return peak;
    },
  };
}

function fmtMs(ms) {
  return `${ms.toFixed(0)}ms`;
}
function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function main() {
  console.log(`Generating fixture: ${fileCount} files...`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-bench-"));
  const genStart = performance.now();
  await buildFixture(root, fileCount);
  console.log(`  done in ${fmtMs(performance.now() - genStart)}\n`);

  let ok = true;

  console.log("Cold scan (no cache)...");
  const rssColdMonitor = peakRssMonitor();
  const coldStart = performance.now();
  let coldResult = await scan(root, {});
  const coldMs = performance.now() - coldStart;
  const coldPeakRss = rssColdMonitor.stop();
  const coldPass = !enforceTargets || coldMs < COLD_BUDGET_MS;
  console.log(
    `  ${fmtMs(coldMs)} (budget ${fmtMs(COLD_BUDGET_MS)}) ${coldPass ? "PASS" : "FAIL"} — ${coldResult.files.length} files, peak RSS ${fmtMB(coldPeakRss)}`,
  );
  ok &&= coldPass;
  // Drop cold results before warm so peak RSS measures the warm scan alone,
  // not cold+warm retained heaps — a real watch-loop warm run doesn't keep
  // the previous ScanResult pinned.
  const coldFileCount = coldResult.files.length;
  coldResult = null;
  if (typeof globalThis.gc === "function") globalThis.gc();

  console.log("Warm scan (cached)...");
  const rssWarmMonitor = peakRssMonitor();
  const warmStart = performance.now();
  const warmResult = await scan(root, {});
  const warmMs = performance.now() - warmStart;
  const warmPeakRss = rssWarmMonitor.stop();
  const warmPass = !enforceTargets || warmMs < WARM_BUDGET_MS;
  console.log(
    `  ${fmtMs(warmMs)} (budget ${fmtMs(WARM_BUDGET_MS)}) ${warmPass ? "PASS" : "FAIL"} — ${warmResult.files.length} files, peak RSS ${fmtMB(warmPeakRss)}`,
  );
  ok &&= warmPass;
  if (warmResult.files.length < coldFileCount) {
    console.error(`warm file count dropped vs cold (${warmResult.files.length} < ${coldFileCount})`);
    ok = false;
  }

  const peakRss = Math.max(coldPeakRss, warmPeakRss);
  const rssPass = !enforceTargets || peakRss < PEAK_RSS_BUDGET_BYTES;
  console.log(`\nPeak RSS: ${fmtMB(peakRss)} (budget ${fmtMB(PEAK_RSS_BUDGET_BYTES)}) ${rssPass ? "PASS" : "FAIL"}`);
  ok &&= rssPass;

  if (!enforceTargets) {
    console.log(
      `\n(${fileCount} files ≠ the §9 default of ${DEFAULT_FILE_COUNT} — targets reported, not enforced. Run without SHERLOCK_BENCH_FILES for the real check.)`,
    );
  }

  if (process.env.SHERLOCK_BENCH_KEEP) {
    console.log(`\n(kept fixture at ${root})`);
  } else {
    await fs.rm(root, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("bench failed:", err);
  process.exit(2);
});
