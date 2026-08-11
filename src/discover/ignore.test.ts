import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIgnoreFile, isIgnored, baselineRules } from "./ignore.js";

test("parseIgnoreFile: skips comments and blank lines", () => {
  const rules = parseIgnoreFile("# comment\n\n*.log\n", "");
  assert.equal(rules.length, 1);
});

test("isIgnored: simple extension pattern matches anywhere", () => {
  const rules = parseIgnoreFile("*.log\n", "");
  assert.equal(isIgnored(rules, "debug.log", false), true);
  assert.equal(isIgnored(rules, "nested/dir/debug.log", false), true);
  assert.equal(isIgnored(rules, "debug.txt", false), false);
});

test("isIgnored: anchored pattern only matches from its declaring dir", () => {
  const rules = parseIgnoreFile("/build\n", "");
  assert.equal(isIgnored(rules, "build", true), true);
  assert.equal(isIgnored(rules, "nested/build", true), false);
});

test("isIgnored: dir-only pattern doesn't match a file of the same name", () => {
  const rules = parseIgnoreFile("logs/\n", "");
  assert.equal(isIgnored(rules, "logs", true), true);
  assert.equal(isIgnored(rules, "logs", false), false);
});

test("isIgnored: negation re-includes a previously ignored path", () => {
  const rules = parseIgnoreFile("*.log\n!keep.log\n", "");
  assert.equal(isIgnored(rules, "debug.log", false), true);
  assert.equal(isIgnored(rules, "keep.log", false), false);
});

test("isIgnored: ** matches nested directories", () => {
  const rules = parseIgnoreFile("fixtures/**\n", "");
  assert.equal(isIgnored(rules, "fixtures/a/b/c.json", false), true);
});

test("baselineRules: node_modules and .git are always ignored", () => {
  const rules = baselineRules();
  assert.equal(isIgnored(rules, "node_modules", true), true);
  assert.equal(isIgnored(rules, "packages/app/node_modules", true), true);
  assert.equal(isIgnored(rules, ".git", true), true);
});
