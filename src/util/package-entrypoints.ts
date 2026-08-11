// package.json entrypoint extraction — seeds orphan-module reachability and
// cold-and-costly's "never flag an entrypoint" guard. Reads string fields only
// (main / bin / exports); never loads or executes anything from the scanned tree.

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

  return [...out];
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string> = { ".js": ".ts", ".jsx": ".tsx", ".mjs": ".ts", ".cjs": ".ts" };

/** Resolve a package.json path field against paths that exist in the scan. */
export function resolveAgainstKnownPaths(
  spec: string,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  const base = spec.replace(/^\.\//, "");
  if (knownPaths.has(base)) return base;

  for (const [jsExt, tsExt] of Object.entries(JS_TO_TS)) {
    if (base.endsWith(jsExt)) {
      const swapped = base.slice(0, -jsExt.length) + tsExt;
      if (knownPaths.has(swapped)) return swapped;
    }
  }

  for (const ext of RESOLVE_EXTS) {
    if (knownPaths.has(base + ext)) return base + ext;
    const indexed = `${base}/index${ext}`;
    if (knownPaths.has(indexed)) return indexed;
  }
  return undefined;
}
