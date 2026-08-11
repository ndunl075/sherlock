#!/usr/bin/env node
// Bin shim — set UV_THREADPOOL_SIZE before loading the CLI module graph so the
// first fs op sees the larger libuv pool (see src/index.ts ensureUvThreadpool).
import os from "node:os";

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.max(64, os.cpus().length * 16));
}

await import("./cli.js");
