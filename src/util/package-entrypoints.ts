// package.json entrypoint extraction — seeds orphan-module reachability and
// cold-and-costly's "never flag an entrypoint" guard. Reads string fields only
// (main / bin / exports / local paths mentioned in scripts); never loads or
// executes anything from the scanned tree.

/** Normalize a package.json path field to repo-relative posix (no leading `./`). */
export function normalizePackagePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^(?:node:|https?:|file:)/i.test(trimmed)) return undefined;
  if (trimmed.startsWith("/") || trimmed.includes("://")) return undefined;
  // Conditional-export keys like "import" / "require" / "default" are objects,
  // not strings — string values here are paths (or occasionally package names).
  if (!trimmed.startsWith(".") && !trimmed.includes("/") && !trimmed.includes("\\")) {
    // Bare "index.js" is fine; bare "lodash" is a package name — skip those
    // without a path separator or extension.
    if (!/\.[a-zA-Z0-9]+$/.test(trimmed)) return undefined;
  }
  return trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
}

function collectFromExports(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const n = normalizePackagePath(value);
    if (n) out.add(n);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromExports(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectFromExports(item, out);
    }
  }
}

/** Local file paths referenced in npm script strings (`node ./x.js`, `--import ./y.mjs`). */
const SCRIPT_PATH_RE =
  /(?:^|[\s=])((?:\.\.?\/)?[\w@./+-]+\.(?:mjs|cjs|js|ts|tsx|jsx))\b/g;

function collectFromScripts(scripts: unknown, out: Set<string>): void {
  if (!scripts || typeof scripts !== "object") return;
  for (const value of Object.values(scripts as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    SCRIPT_PATH_RE.lastIndex = 0;
    for (const match of value.matchAll(SCRIPT_PATH_RE)) {
      const n = normalizePackagePath(match[1] ?? "");
      if (n) out.add(n);
    }
  }
}

/**
 * When package.json points at `dist/foo.js` but discover baseline-ignores
 * `dist/`, also try the common `src/` twin so bin/main still seed the graph.
 */
function expandDistToSrcCandidates(spec: string): string[] {
  const base = spec.replace(/^\.\//, "");
  const out = [base];
  if (!base.startsWith("dist/")) return out;
  const rest = base.slice("dist/".length);
  out.push(`src/${rest}`);
  for (const [from, to] of [
    [".js", ".ts"],
    [".mjs", ".ts"],
    [".cjs", ".ts"],
    [".js", ".mjs"],
    [".mjs", ".mjs"],
  ] as const) {
    if (rest.endsWith(from)) {
      out.push(`src/${rest.slice(0, -from.length)}${to}`);
    }
  }
  return out;
}

/**
 * Collect runtime entry paths declared in a package.json object.
 * Returns normalized repo-relative paths; callers resolve against the file set.
 */
export function collectPackageEntrypoints(pkg: unknown): string[] {
  if (!pkg || typeof pkg !== "object") return [];
  const record = pkg as Record<string, unknown>;
  const out = new Set<string>();

  if (typeof record.main === "string") {
    const n = normalizePackagePath(record.main);
    if (n) out.add(n);
  }

  if (typeof record.bin === "string") {
    const n = normalizePackagePath(record.bin);
    if (n) out.add(n);
  } else if (record.bin && typeof record.bin === "object" && !Array.isArray(record.bin)) {
    for (const value of Object.values(record.bin as Record<string, unknown>)) {
      if (typeof value === "string") {
        const n = normalizePackagePath(value);
        if (n) out.add(n);
      }
    }
  }

  if (record.exports !== undefined) collectFromExports(record.exports, out);
  collectFromScripts(record.scripts, out);

  const expanded = new Set<string>();
  for (const p of out) {
    for (const c of expandDistToSrcCandidates(p)) expanded.add(c);
  }
  return [...expanded];
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string> = { ".js": ".ts", ".jsx": ".tsx", ".mjs": ".ts", ".cjs": ".ts" };

/** Resolve a package.json path field against paths that exist in the scan. */
export function resolveAgainstKnownPaths(
  spec: string,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  for (const candidate of expandDistToSrcCandidates(spec)) {
    if (knownPaths.has(candidate)) return candidate;

    for (const [jsExt, tsExt] of Object.entries(JS_TO_TS)) {
      if (candidate.endsWith(jsExt)) {
        const swapped = candidate.slice(0, -jsExt.length) + tsExt;
        if (knownPaths.has(swapped)) return swapped;
      }
    }

    for (const ext of RESOLVE_EXTS) {
      if (knownPaths.has(candidate + ext)) return candidate + ext;
      const indexed = `${candidate}/index${ext}`;
      if (knownPaths.has(indexed)) return indexed;
    }
  }
  return undefined;
}
