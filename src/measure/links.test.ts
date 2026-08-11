import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLinkTargets, extractResolvedLinks } from "./links.js";

test("extractLinkTargets: pulls relative link targets, skips external and anchor-only links", () => {
  const md = `
See [the guide](docs/guide.md) and [external](https://example.com/x)
and [an anchor](#section) and [scoped](../CONTRIBUTING.md#pull-requests).
`;
  assert.deepEqual(extractLinkTargets(md), ["docs/guide.md", "../CONTRIBUTING.md"]);
});

test("extractLinkTargets: strips a trailing title", () => {
  const md = `[link](docs/guide.md "Guide title")`;
  assert.deepEqual(extractLinkTargets(md), ["docs/guide.md"]);
});

test("extractResolvedLinks: resolves relative to the doc's own directory", () => {
  const md = `[link](../CONTRIBUTING.md)`;
  assert.deepEqual(extractResolvedLinks(md, "docs/guide.md"), ["CONTRIBUTING.md"]);
});
