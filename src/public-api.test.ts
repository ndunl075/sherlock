import { test } from "node:test";
import assert from "node:assert/strict";
import { scan } from "./index.js";
import type { Detector, Finding } from "./index.js";

test("package entry point exposes the documented public contracts", () => {
  const detector: Detector = {
    id: "example",
    run: (): Finding[] => [],
  };
  assert.equal(detector.id, "example");
  assert.equal(typeof scan, "function");
});
