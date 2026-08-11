// Bounded concurrency — ARCHITECTURE.md §9 ("worker pool, os.cpus()").
//
// Found by benchmarking, not by design: `Promise.all(items.map(fn))` over
// every discovered file looks concurrent and correct at hundreds of files,
// and IS — right up until file count crosses the OS's open-file-descriptor
// ceiling. At 48k files on this machine, fully unbounded concurrency across
// graph/'s per-file reads failed 83% of them with EMFILE, silently — each
// failure degrades to "this file contributes nothing," which is a wrong
// dead-export/orphan-module answer on a big repo, not just a slow one. A
// bounded pool keeps the concurrency (still far faster than sequential) below
// wherever that ceiling actually is.

import os from "node:os";

const DEFAULT_LIMIT = Math.max(32, os.cpus().length * 8);

/** Run `fn` over every item with at most `limit` in flight at once. Results come back in the same order as `items`. */
export async function runPool<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  limit: number = DEFAULT_LIMIT,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
