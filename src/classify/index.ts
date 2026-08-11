// File kind classification — ARCHITECTURE.md §3 (classify/).
//
// Path-based first (cheap, no I/O); binary detection needs a content sniff of
// the first few KB, which measure/ already reads for sampling, so classify()
// takes an optional peek buffer rather than opening the file itself — keeps
// this module I/O-free and unit-testable on bare paths.

import type { FileKind } from "../types.js";

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
]);

const GENERATED_DIR_SEGMENTS = new Set(["dist", "build", "generated", "out", ".next", "target"]);
const GENERATED_SUFFIXES = [".pb.go", ".pb.js", ".pb.cc", ".pb.h"];

const VENDORED_DIR_SEGMENTS = new Set(["vendor", "third_party", "node_modules"]);

const FIXTURE_DIR_SEGMENTS = new Set(["fixtures", "__fixtures__", "testdata", "snapshots", "__snapshots__"]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tar", ".7z", ".rar",
  ".pdf", ".exe", ".dll", ".so", ".dylib",
  ".wasm", ".node", ".sqlite", ".db",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp",
  ".rb", ".php", ".cs", ".swift", ".scala", ".sh", ".ps1",
  ".json", ".yaml", ".yml", ".toml", ".css", ".scss", ".html",
]);

function segments(relPath: string): string[] {
  return relPath.split("/").slice(0, -1);
}

function extname(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

function basename(relPath: string): string {
  return relPath.split("/").pop() ?? relPath;
}

/** Minified assets are reported by raw byte size, never tokenized. */
export function isMinifiedPath(relPath: string): boolean {
  return /\.min\.[^/]+$/i.test(relPath);
}

/** Cheap heuristic: a chunk with a NUL byte, or a high ratio of non-text bytes, reads as binary. */
export function looksBinary(sample: Buffer): boolean {
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;
  let nonText = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) nonText++;
  }
  return nonText / sample.length > 0.3;
}

/** True when classify() can't decide from the path alone and needs a content sniff. */
export function needsContentSniff(relPath: string): boolean {
  const ext = extname(relPath);
  if (BINARY_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext) || SOURCE_EXTENSIONS.has(ext)) return false;
  if (LOCKFILE_NAMES.has(basename(relPath))) return false;
  if (isMinifiedPath(relPath) || GENERATED_SUFFIXES.some((suf) => relPath.endsWith(suf))) return false;
  const dirs = segments(relPath);
  if (dirs.some((d) => GENERATED_DIR_SEGMENTS.has(d) || VENDORED_DIR_SEGMENTS.has(d) || FIXTURE_DIR_SEGMENTS.has(d))) {
    return false;
  }
  return true;
}

export function classify(relPath: string, contentSample?: Buffer): FileKind {
  const ext = extname(relPath);
  const dirs = segments(relPath);
  const name = basename(relPath);

  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  if (contentSample && looksBinary(contentSample)) return "binary";

  if (LOCKFILE_NAMES.has(name)) return "generated";
  if (isMinifiedPath(relPath) || GENERATED_SUFFIXES.some((suf) => relPath.endsWith(suf))) return "generated";
  if (dirs.some((d) => GENERATED_DIR_SEGMENTS.has(d))) return "generated";

  if (dirs.some((d) => VENDORED_DIR_SEGMENTS.has(d))) return "vendored";

  if (dirs.some((d) => FIXTURE_DIR_SEGMENTS.has(d))) return "fixture";

  if (DOC_EXTENSIONS.has(ext)) return "doc";

  if (SOURCE_EXTENSIONS.has(ext)) return "source";

  // unknown extension, textual content, no other signal — best-effort default
  return "source";
}
