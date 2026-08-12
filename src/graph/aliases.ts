// tsconfig/jsconfig `paths` alias resolution — feeds graph/ so bare
// specifiers like `@/lib/foo` resolve the same way TypeScript does for
// relative reachability. Reads JSON only; never executes config. `extends`
// is followed only when the target stays inside the repo root (no
// node_modules / outside-tree config execution surface).

import { promises as fs } from "node:fs";
import path from "node:path";

export interface PathAliasRule {
  /** pattern as written, e.g. `@/*` or `@lib` */
  pattern: string;
  /** substitution targets relative to baseUrl, e.g. `src/*` */
  targets: string[];
}

export interface PathAliasConfig {
  /** repo-relative posix directory that paths are resolved against */
  baseUrl: string;
  rules: PathAliasRule[];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripJsonComments(text: string): string {
  // tsconfig allows // and /* */ comments and trailing commas — strip a
  // conservative subset so JSON.parse can read real-world configs.
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "," ) {
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\r" || text[j] === "\n")) {
        j++;
      }
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeBundlerTarget(value: string): string | undefined {
  const normalized = toPosix(value).replace(/^\.\//, "").replace(/\/$/, "");
  return normalized && !path.posix.isAbsolute(normalized) && !normalized.startsWith("../") ? normalized : undefined;
}

function bundlerRule(find: string, replacement: string): PathAliasRule | undefined {
  const target = normalizeBundlerTarget(replacement);
  if (!find || !target) return undefined;
  if (find.endsWith("$")) return { pattern: find.slice(0, -1), targets: [target] };
  return { pattern: `${find.replace(/\/$/, "")}/*`, targets: [`${target}/*`] };
}

function staticReplacement(expression: string): string | undefined {
  const literal = expression.match(/^\s*["']([^"']+)["']\s*$/)?.[1];
  if (literal) return literal;
  const resolved = expression.match(/(?:path\.)?resolve\(\s*__dirname\s*,\s*["']([^"']+)["']\s*\)/)?.[1];
  if (resolved) return resolved;
  return expression.match(/fileURLToPath\(\s*new URL\(\s*["']([^"']+)["']/)?.[1];
}

/** Extract literal Vite/Webpack aliases without importing or executing config code. */
export function parseBundlerAliases(source: string): PathAliasConfig | undefined {
  const rules: PathAliasRule[] = [];
  const objectBlock = source.match(/\balias\s*:\s*\{([\s\S]*?)\}/)?.[1];
  if (objectBlock) {
    const pair = /["']([^"']+)["']\s*:\s*((?:path\.)?resolve\(\s*__dirname\s*,\s*["'][^"']+["']\s*\)|fileURLToPath\(\s*new URL\(\s*["'][^"']+["'][\s\S]*?\)\s*\)|["'][^"']+["'])/g;
    for (const match of objectBlock.matchAll(pair)) {
      const replacement = staticReplacement(match[2] ?? "");
      const rule = replacement ? bundlerRule(match[1] ?? "", replacement) : undefined;
      if (rule) rules.push(rule);
    }
  }

  const arrayBlock = source.match(/\balias\s*:\s*\[([\s\S]*?)\]/)?.[1];
  if (arrayBlock) {
    for (const match of arrayBlock.matchAll(/\{([\s\S]*?)\}/g)) {
      const find = match[1]?.match(/\bfind\s*:\s*["']([^"']+)["']/)?.[1];
      const expression = match[1]?.match(/\breplacement\s*:\s*([^,}\n]+)/)?.[1];
      const replacement = expression ? staticReplacement(expression) : undefined;
      const rule = find && replacement ? bundlerRule(find, replacement) : undefined;
      if (rule) rules.push(rule);
    }
  }

  if (rules.length === 0) return undefined;
  rules.sort((a, b) => b.pattern.length - a.pattern.length);
  return { baseUrl: "", rules };
}

/** Pure parse of one tsconfig-shaped object (already JSON). */
export function parsePathAliasConfig(
  raw: unknown,
  configDirPosix: string,
): PathAliasConfig | undefined {
  const root = asRecord(raw);
  const compilerOptions = asRecord(root?.compilerOptions);
  if (!compilerOptions) return undefined;

  const pathsRaw = asRecord(compilerOptions.paths);
  if (!pathsRaw) return undefined;

  const baseUrlField =
    typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  const baseUrl = toPosix(
    path.posix.normalize(
      path.posix.join(configDirPosix || ".", toPosix(baseUrlField).replace(/^\.\//, "")),
    ),
  ).replace(/^\.\//, "");

  const rules: PathAliasRule[] = [];
  for (const [pattern, targets] of Object.entries(pathsRaw)) {
    if (typeof pattern !== "string" || !pattern) continue;
    const list = Array.isArray(targets) ? targets : [targets];
    const normalized = list
      .filter((t): t is string => typeof t === "string" && t.length > 0)
      .map((t) => toPosix(t));
    if (normalized.length === 0) continue;
    rules.push({ pattern, targets: normalized });
  }
  if (rules.length === 0) return undefined;
  // Longer patterns first so `@/foo/*` wins over `@/*` when both match.
  rules.sort((a, b) => b.pattern.length - a.pattern.length);
  return { baseUrl: baseUrl === "." ? "" : baseUrl, rules };
}

/**
 * Map a bare specifier through tsconfig paths. Returns a repo-relative
 * posix path (may lack extension); caller resolves against known files.
 */
export function applyPathAlias(spec: string, config: PathAliasConfig): string | undefined {
  if (spec.startsWith("./") || spec.startsWith("../") || path.posix.isAbsolute(spec)) {
    return undefined;
  }

  for (const rule of config.rules) {
    const star = rule.pattern.indexOf("*");
    let mapped: string | undefined;
    if (star === -1) {
      if (spec === rule.pattern) mapped = rule.targets[0];
    } else {
      const prefix = rule.pattern.slice(0, star);
      const suffix = rule.pattern.slice(star + 1);
      if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
      const mid = spec.slice(prefix.length, spec.length - suffix.length);
      const target = rule.targets[0];
      if (!target) continue;
      mapped = target.includes("*") ? target.replace("*", mid) : target + mid;
    }
    if (!mapped) continue;
    const joined = toPosix(
      path.posix.normalize(
        config.baseUrl ? path.posix.join(config.baseUrl, mapped) : mapped,
      ),
    ).replace(/^\.\//, "");
    if (joined.startsWith("..")) return undefined; // escaped repo via alias — refuse
    return joined;
  }
  return undefined;
}

async function readJsonConfig(absPath: string): Promise<unknown | undefined> {
  try {
    const text = await fs.readFile(absPath, "utf8");
    return JSON.parse(stripJsonComments(text)) as unknown;
  } catch {
    return undefined;
  }
}

function resolveExtends(
  extendsField: string,
  fromDirAbs: string,
  absRoot: string,
): string | undefined {
  // Only relative extends inside the repo. Package extends (`@tsconfig/node20`)
  // would load from node_modules — out of scope and a trust boundary.
  if (!extendsField.startsWith("./") && !extendsField.startsWith("../")) return undefined;
  const resolved = path.resolve(fromDirAbs, extendsField);
  const rootResolved = path.resolve(absRoot);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return undefined;
  }
  return resolved.endsWith(".json") ? resolved : `${resolved}.json`;
}

/**
 * Load path aliases from tsconfig.json / jsconfig.json at the repo root
 * (and relative extends within the tree). Returns undefined when absent.
 */
export async function loadPathAliases(absRoot: string): Promise<PathAliasConfig | undefined> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const absConfig = path.join(absRoot, name);
    const visited = new Set<string>();
    let current: string | undefined = absConfig;
    let mergedPaths: Record<string, unknown> | undefined;
    let baseUrl: string | undefined;
    let configDirPosix = "";

    while (current && !visited.has(current)) {
      visited.add(current);
      const raw = await readJsonConfig(current);
      if (raw === undefined) break;
      const record = asRecord(raw);
      const compilerOptions = asRecord(record?.compilerOptions);
      const dirAbs = path.dirname(current);
      configDirPosix = toPosix(path.relative(absRoot, dirAbs)) || "";

      if (compilerOptions) {
        if (typeof compilerOptions.baseUrl === "string" && baseUrl === undefined) {
          baseUrl = compilerOptions.baseUrl;
        }
        const paths = asRecord(compilerOptions.paths);
        if (paths) {
          mergedPaths = { ...paths, ...(mergedPaths ?? {}) };
        }
      }

      const extendsField = record?.extends;
      if (typeof extendsField === "string") {
        current = resolveExtends(extendsField, dirAbs, absRoot);
      } else {
        current = undefined;
      }
    }

    if (!mergedPaths) continue;
    return parsePathAliasConfig(
      { compilerOptions: { baseUrl: baseUrl ?? ".", paths: mergedPaths } },
      configDirPosix,
    );
  }
  return undefined;
}

const BUNDLER_CONFIG_NAMES = [
  "vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs", "vite.config.cts", "vite.config.cjs",
  "webpack.config.ts", "webpack.config.js", "webpack.config.mts", "webpack.config.mjs", "webpack.config.cts", "webpack.config.cjs",
];
const MAX_BUNDLER_CONFIG_BYTES = 1024 * 1024;

/** Load static Vite/Webpack aliases from root config files, never executing target-repo code. */
export async function loadBundlerAliases(absRoot: string): Promise<PathAliasConfig | undefined> {
  const rules: PathAliasRule[] = [];
  for (const name of BUNDLER_CONFIG_NAMES) {
    try {
      const absPath = path.join(absRoot, name);
      const stat = await fs.stat(absPath);
      if (!stat.isFile() || stat.size > MAX_BUNDLER_CONFIG_BYTES) continue;
      const config = parseBundlerAliases(await fs.readFile(absPath, "utf8"));
      if (config) rules.push(...config.rules);
    } catch {
      // Absent/unreadable configs are normal; this enrichment must not fail a scan.
    }
  }
  if (rules.length === 0) return undefined;
  rules.sort((a, b) => b.pattern.length - a.pattern.length);
  return { baseUrl: "", rules };
}
