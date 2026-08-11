import { test } from "node:test";
import assert from "node:assert/strict";
import { runPool } from "./pool.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("runPool: results come back in the same order as items, regardless of completion order", async () => {
  const items = [30, 10, 20];
  const results = await runPool(items, async (ms) => {
    await delay(ms);
    return ms;
  });
  assert.deepEqual(results, [30, 10, 20]);
});

test("runPool: never exceeds the concurrency limit", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);

  await runPool(
    items,
    async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
    },
    4,
  );

  assert.ok(maxInFlight <= 4, `expected max 4 concurrent, saw ${maxInFlight}`);
});

test("runPool: processes every item exactly once", async () => {
  const items = Array.from({ length: 25 }, (_, i) => i);
  const seen: number[] = [];
  await runPool(
    items,
    async (i) => {
      seen.push(i);
    },
    6,
  );
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test("runPool: limit larger than item count doesn't throw or hang", async () => {
  const results = await runPool([1, 2], async (n) => n * 2, 100);
  assert.deepEqual(results, [2, 4]);
});

test("runPool: empty items resolves immediately with an empty array", async () => {
  const results = await runPool([], async (n: number) => n, 10);
  assert.deepEqual(results, []);
});
