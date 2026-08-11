import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModule, isGraphEligibleExt, tryFastParse } from "./parse.js";

test("isGraphEligibleExt: only the JS/TS family", () => {
  assert.equal(isGraphEligibleExt(".ts"), true);
  assert.equal(isGraphEligibleExt(".tsx"), true);
  assert.equal(isGraphEligibleExt(".js"), true);
  assert.equal(isGraphEligibleExt(".py"), false);
});

test("tryFastParse: simple export function/const/class without imports", () => {
  const info = tryFastParse(
    `export function hello() {}\nexport const world = 1;\nexport class Thing {}\n`,
  );
  assert.deepEqual(info?.exportedNames, new Set(["hello", "world", "Thing"]));
  assert.deepEqual(info?.imports, []);
  assert.deepEqual(info?.reexports, []);
});

test("tryFastParse: declines imports, defaults, re-exports, and CommonJS", () => {
  assert.equal(tryFastParse(`import { x } from "./a";\nexport function f() {}`), null);
  assert.equal(tryFastParse(`export default function f() {}`), null);
  assert.equal(tryFastParse(`export { x } from "./a";`), null);
  assert.equal(tryFastParse(`export * from "./a";`), null);
  assert.equal(tryFastParse(`const x = require("./a");\nmodule.exports = x;`), null);
});

test("parseModule: CommonJS require and module.exports", () => {
  const info = parseModule(
    `
const { foo, bar } = require("./lib");
const whole = require("./whole");
module.exports = { serve, helper };
exports.extra = 1;
`,
    ".cjs",
  )!;
  assert.equal(info.imports.length, 2);
  assert.deepEqual(info.imports[0], { source: "./lib", names: ["foo", "bar"], namespace: false });
  assert.equal(info.imports[1]?.source, "./whole");
  assert.equal(info.imports[1]?.namespace, true);
  assert.deepEqual(info.exportedNames, new Set(["serve", "helper", "extra"]));
});

test("parseModule: module.exports = function marks __default__", () => {
  const info = parseModule(`module.exports = function main() {}`, ".js")!;
  assert.deepEqual(info.exportedNames, new Set(["__default__"]));
});

test("parseModule: dynamic import('./x') is an edge", () => {
  const info = parseModule(`export async function load() { return import("./lazy"); }`, ".ts")!;
  assert.equal(info.imports.length, 1);
  assert.equal(info.imports[0]?.source, "./lazy");
});

test("parseModule: returns null for an unsupported extension", () => {
  assert.equal(parseModule("print(1)", ".py"), null);
});

test("parseModule: named, default, and namespace imports", () => {
  const src = `
import { foo, bar as baz } from "./a";
import def from "./b";
import * as ns from "./c";
`;
  const info = parseModule(src, ".ts")!;
  assert.equal(info.imports.length, 3);
  assert.deepEqual(info.imports[0], { source: "./a", names: ["foo", "bar"], namespace: false });
  assert.deepEqual(info.imports[1], { source: "./b", names: ["__default__"], namespace: false });
  assert.deepEqual(info.imports[2], { source: "./c", names: [], namespace: true });
});

test("parseModule: combined default + named import", () => {
  const info = parseModule(`import def, { a, b as c } from "./mixed";`, ".ts")!;
  assert.equal(info.imports.length, 1);
  assert.deepEqual(new Set(info.imports[0]?.names), new Set(["__default__", "a", "b"]));
});

test("parseModule: local declaration exports (function/const/class)", () => {
  const src = `
export function hello() {}
export const world = 1;
export class Thing {}
`;
  const info = parseModule(src, ".ts")!;
  assert.deepEqual(info.exportedNames, new Set(["hello", "world", "Thing"]));
});

test("parseModule: export default always resolves to __default__, never the local name", () => {
  const info = parseModule(`export default function foo() {}`, ".ts")!;
  assert.deepEqual(info.exportedNames, new Set(["__default__"]));
});

test("parseModule: local named export list, with alias", () => {
  const info = parseModule(`const a = 1, b = 2;\nexport { a, b as renamed };`, ".ts")!;
  assert.deepEqual(info.exportedNames, new Set(["a", "renamed"]));
});

test("parseModule: named re-export and star re-export", () => {
  const src = `
export { x, y as z } from "./d";
export * from "./e";
`;
  const info = parseModule(src, ".ts")!;
  assert.deepEqual(info.exportedNames, new Set(["x", "z"]));
  // one reexport record per specifier (x, y) from ./d, plus one star record for ./e
  assert.equal(info.reexports.length, 3);
  const fromD = info.reexports.filter((r) => r.source === "./d");
  assert.deepEqual(new Set(fromD.flatMap((r) => r.names)), new Set(["x", "y"]));
  assert.deepEqual(
    info.reexports.find((r) => r.source === "./e"),
    { source: "./e", names: [], star: true },
  );
});

test("parseModule: TS interface/type exports are omitted from exportedNames (type-only)", () => {
  const src = `
export interface Bar { x: number }
export type Baz = string;
export enum Color { Red, Green }
export function keep() {}
`;
  const info = parseModule(src, ".ts")!;
  assert.deepEqual(info.exportedNames, new Set(["Color", "keep"]));
});

test("parseModule: JSX in .tsx parses without throwing", () => {
  const info = parseModule(`export const X = () => <div>hi</div>;`, ".tsx")!;
  assert.deepEqual(info.exportedNames, new Set(["X"]));
});
