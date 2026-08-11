// Ignore-stack resolution — ARCHITECTURE.md §3 (discover/) and §12 (security model).
//
// A pragmatic subset of gitignore syntax: comments, blank lines, negation
// (`!pattern`), anchoring (`/pattern`), dir-only (`pattern/`), `*`, `?`, and
// `**`. It is not a full implementation of git's matching spec (no character
// classes, no `\`-escapes beyond what's needed for the tests below) — that
// covers the patterns real repos actually write. .gitignore, .claudeignore,
// and .cursorignore are all parsed with the same rules.

export interface IgnoreRule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
  /** posix path, relative to repo root, of the directory the rule file lives in ('' = root) */
  declDir: string;
}

/** Directories ignored unconditionally, regardless of any ignore file present. */
const BASELINE_IGNORE_DIRS = [
  ".git",
  "node_modules",
  ".sherlock",
  "dist",
  "build",
  "coverage",
  ".nyc_output",
];

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Translate one gitignore-style pattern (already stripped of leading `!`/trailing dir-slash) into a RegExp body. */
function patternToRegexSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      // "**" — consume any run of "**" plus adjacent slashes as "match zero or more path segments"
      let j = i + 2;
      while (pattern[j] === "*") j++;
      const leadingSlash = out.endsWith("/");
      const trailingSlash = pattern[j] === "/";
      if (leadingSlash && trailingSlash) {
        out = out.slice(0, -1) + "(?:/.*)?";
        j++;
      } else if (leadingSlash) {
        out += ".*";
      } else if (trailingSlash) {
        out += ".*";
        j++;
      } else {
        out += ".*";
      }
      i = j;
      continue;
    }
    if (c === "*") {
      out += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    out += escapeRegExpLiteral(c ?? "");
    i++;
  }
  return out;
}

/** Parse one ignore file's contents into rules attributed to the directory it was found in. */
export function parseIgnoreFile(content: string, declDir: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine;
    if (line.trim() === "" || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    // trailing unescaped whitespace is trimmed by git; we approximate with a plain trim
    line = line.replace(/\s+$/, "");
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    }
    if (line.includes("/")) anchored = true; // a mid-pattern slash also anchors, per gitignore rules
    if (line === "") continue;

    const body = patternToRegexSource(line);
    const source = anchored ? `^${body}$` : `(?:^|.*/)${body}$`;
    rules.push({ regex: new RegExp(source), negate, dirOnly, declDir });
  }
  return rules;
}

/**
 * Test whether relPath (posix, relative to repo root, no leading slash) is ignored
 * given the accumulated rule stack (root-most rules first, deepest last — later
 * rules win ties, matching git precedence).
 */
export function isIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const base = rule.declDir === "" ? relPath : relPath.slice(rule.declDir.length + 1);
    if (rule.declDir !== "" && !relPath.startsWith(rule.declDir + "/")) continue;
    if (base === undefined || base === "") continue;
    if (rule.regex.test(base)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

/** Baseline rules that apply everywhere, independent of any ignore file. */
export function baselineRules(): IgnoreRule[] {
  return BASELINE_IGNORE_DIRS.map((name) => ({
    regex: new RegExp(`(?:^|.*/)${escapeRegExpLiteral(name)}$`),
    negate: false,
    dirOnly: true,
    declDir: "",
  }));
}
