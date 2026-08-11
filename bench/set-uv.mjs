// Side-effect import: bump libuv's threadpool before any fs work.
// Used via `node --import ./bench/set-uv.mjs …` so the env var is in place
// before fixture generation or scan() touch the filesystem. Default pool
// size is 4; our discover/measure pools schedule far more concurrent IO.
import os from "node:os";

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.max(64, os.cpus().length * 16));
}
