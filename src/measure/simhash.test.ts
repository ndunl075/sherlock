import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSimhash, hammingDistance } from "./simhash.js";

const LONG_TEXT =
  "The quick brown fox jumps over the lazy dog near the riverbank while the sun sets slowly behind the distant hills and mountains today.";

test("computeSimhash: too-short text returns undefined", () => {
  assert.equal(computeSimhash("just a few words"), undefined);
});

test("computeSimhash: identical text produces identical fingerprints", () => {
  const a = computeSimhash(LONG_TEXT);
  const b = computeSimhash(LONG_TEXT);
  assert.notEqual(a, undefined);
  assert.equal(a, b);
});

test("computeSimhash: a one-word edit stays far closer than genuinely different text", () => {
  const UNRELATED =
    "Quarterly revenue projections require careful analysis of supply chain logistics across every regional distribution center.";
  const original = computeSimhash(LONG_TEXT)!;
  const oneWordEdited = computeSimhash(LONG_TEXT.replace("fox", "cat"))!;
  const unrelated = computeSimhash(UNRELATED)!;
  assert.ok(hammingDistance(original, oneWordEdited) < hammingDistance(original, unrelated));
});

test("hammingDistance: identical inputs have zero distance", () => {
  assert.equal(hammingDistance(0b1010, 0b1010), 0);
});

test("hammingDistance: counts differing bits", () => {
  assert.equal(hammingDistance(0b0000, 0b1111), 4);
});
