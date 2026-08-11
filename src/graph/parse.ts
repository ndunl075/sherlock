// tree-sitter parsing — ARCHITECTURE.md §3 (graph/), §10 ("one grammar
// interface across languages").
//
// v1 scope: JS/TS family only (.ts/.tsx/.js/.jsx/.mjs/.cjs). Parses ES module
// import/export, CommonJS `require()` / `module.exports` / `exports.*`, and
// dynamic `import()`. Path aliases (tsconfig `paths`) are resolved in graph/
// via aliases.ts — this module only extracts raw specifiers.

import Parser from "tree-sitter";
import TypeScriptLanguages from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";

const { typescript, tsx } = TypeScriptLanguages;

const EXT_LANGUAGE = new Map<string, unknown>([
  [".ts", typescript],
  [".tsx", tsx],
  [".js", JavaScript],
  [".jsx", JavaScript],
  [".mjs", JavaScript],
  [".cjs", JavaScript],
]);

export function isGraphEligibleExt(ext: string): boolean {
  return EXT_LANGUAGE.has(ext);
}

// One Parser instance per language, reused across every file of that
// language rather than constructed per call — Parser() has real
// construction overhead (native/WASM resource binding), which is invisible
// on a handful of files and dominates the cost of a full-repo scan once
// there are thousands. Caught by the §9 benchmark: a "warm" scan wasn't
// meaningfully faster than cold, because graph/ (deliberately uncached, see
// cache/index.ts) was still paying per-file Parser construction on every run.
const parserCache = new Map<unknown, Parser>();

function getParser(language: unknown): Parser {
  let parser = parserCache.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language as Parameters<Parser["setLanguage"]>[0]);
    parserCache.set(language, parser);
  }
  return parser;
}

export interface ModuleImport {
  source: string; // raw specifier, unresolved
  /** symbol names pulled in; '__default__' for a default import */
  names: string[];
  /** `import * as x` — target should be treated as fully used, not just these names */
  namespace: boolean;
}

export interface ModuleReexport {
  source: string;
  names: string[]; // specific re-exported symbol names ('__default__' possible); empty when star is true
  star: boolean; // `export * from '...'`
}

export interface ModuleInfo {
  imports: ModuleImport[];
  reexports: ModuleReexport[];
  exportedNames: Set<string>;
}

function stringFieldText(node: Parser.SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  const fragment = node.namedChildren.find((c) => c.type === "string_fragment");
  return fragment?.text;
}

function isDefaultExport(node: Parser.SyntaxNode): boolean {
  return node.children.some((c) => c.type === "default");
}

const DECLARATION_NAME_TYPES = new Set([
  "function_declaration",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);

function namesFromDeclaration(decl: Parser.SyntaxNode): string[] {
  // Type-only exports (interface/type) are erased at runtime and inflate
  // dead-export noise when nothing imports them by name — skip for the graph.
  if (decl.type === "interface_declaration" || decl.type === "type_alias_declaration") {
    return [];
  }
  if (DECLARATION_NAME_TYPES.has(decl.type)) {
    const name = decl.childForFieldName("name");
    return name ? [name.text] : [];
  }
  if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
    const names: string[] = [];
    for (const child of decl.namedChildren) {
      if (child.type !== "variable_declarator") continue;
      const name = child.childForFieldName("name");
      if (name?.type === "identifier") names.push(name.text);
    }
    return names;
  }
  return [];
}

// Top-level `export function/class/const …` with no imports or re-exports.
// The §9 50k fixture (and a lot of real leaf modules) are exactly this shape;
// tree-sitter dominates cold time there, so a conservative regex path pays for
// itself. Anything ambiguous falls through to the full parser.
const FAST_EXPORT_DECL =
  /^export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Return a ModuleInfo without tree-sitter when the source is unambiguously a
 * set of local export declarations. Returns null when the file needs a full
 * parse (imports, re-exports, default exports, export lists, or `export`
 * forms we didn't recognize).
 */
export function tryFastParse(source: string): ModuleInfo | null {
  if (/\bimport\b/.test(source)) return null;
  if (/\bexport\s+default\b/.test(source)) return null;
  if (/\bexport\s*[\*{]/.test(source)) return null;
  if (/\bfrom\s+['"]/.test(source)) return null;
  if (/\brequire\s*\(/.test(source)) return null;
  if (/\bmodule\.exports\b/.test(source) || /\bexports\./.test(source)) return null;

  const exportedNames = new Set<string>();
  FAST_EXPORT_DECL.lastIndex = 0;
  for (const match of source.matchAll(FAST_EXPORT_DECL)) {
    const name = match[1];
    if (name) exportedNames.add(name);
  }

  // An `export` we didn't capture means the shape is richer than this path
  // handles — don't silently drop symbols.
  if (/\bexport\b/.test(source) && exportedNames.size === 0) return null;

  return { imports: [], reexports: [], exportedNames };
}

/** Parse one file's ES module surface: what it imports, what it re-exports, what it exports. Returns null for unsupported extensions. */
export function parseModule(source: string, ext: string): ModuleInfo | null {
  if (!EXT_LANGUAGE.has(ext)) return null;

  const fast = tryFastParse(source);
  if (fast) return fast;

  const language = EXT_LANGUAGE.get(ext);
  if (!language) return null;

  const parser = getParser(language);
  const tree = parser.parse(source);

  const imports: ModuleImport[] = [];
  const reexports: ModuleReexport[] = [];
  const exportedNames = new Set<string>();

  function visitImport(node: Parser.SyntaxNode): void {
    const src = stringFieldText(node.childForFieldName("source"));
    const clause = node.namedChildren.find((c) => c.type === "import_clause");
    if (!src || !clause) return;

    let namespace = false;
    const names: string[] = [];
    for (const part of clause.children) {
      if (part.type === "identifier") names.push("__default__");
      else if (part.type === "namespace_import") namespace = true;
      else if (part.type === "named_imports") {
        for (const spec of part.namedChildren) {
          if (spec.type !== "import_specifier") continue;
          const name = spec.childForFieldName("name");
          if (name) names.push(name.text);
        }
      }
    }
    imports.push({ source: src, names, namespace });
  }

  function visitExport(node: Parser.SyntaxNode): void {
    const src = stringFieldText(node.childForFieldName("source"));
    const clause = node.namedChildren.find((c) => c.type === "export_clause");

    if (src) {
      // re-export, with or without a named clause
      if (clause) {
        for (const spec of clause.namedChildren) {
          if (spec.type !== "export_specifier") continue;
          const imported = spec.childForFieldName("name")?.text;
          const alias = spec.childForFieldName("alias")?.text;
          if (imported) reexports.push({ source: src, names: [imported], star: false });
          if (alias ?? imported) exportedNames.add(alias ?? imported!);
        }
      } else {
        reexports.push({ source: src, names: [], star: true });
      }
      return;
    }

    // default exports always resolve to '__default__' regardless of the local
    // binding name (`export default function foo(){}` is imported as
    // `import anything from './x'`, never by the name "foo")
    if (isDefaultExport(node)) {
      exportedNames.add("__default__");
      return;
    }

    const declaration = node.childForFieldName("declaration");
    if (declaration) {
      for (const name of namesFromDeclaration(declaration)) exportedNames.add(name);
      return;
    }

    if (clause) {
      for (const spec of clause.namedChildren) {
        if (spec.type !== "export_specifier") continue;
        const name = spec.childForFieldName("alias")?.text ?? spec.childForFieldName("name")?.text;
        if (name) exportedNames.add(name);
      }
    }
  }

  function stringFromArgs(args: Parser.SyntaxNode | null): string | undefined {
    if (!args) return undefined;
    const first = args.namedChildren[0];
    if (!first) return undefined;
    if (first.type === "string") return stringFieldText(first);
    // template_string with no substitutions: `./x`
    if (first.type === "template_string" && first.namedChildren.every((c) => c.type === "string_fragment")) {
      return first.namedChildren.map((c) => c.text).join("");
    }
    return undefined;
  }

  function namesFromObjectPattern(pattern: Parser.SyntaxNode): string[] {
    const names: string[] = [];
    for (const child of pattern.namedChildren) {
      if (child.type === "shorthand_property_identifier_pattern") names.push(child.text);
      else if (child.type === "pair_pattern" || child.type === "object_assignment_pattern") {
        const key = child.childForFieldName("key") ?? child.namedChildren[0];
        if (key && (key.type === "property_identifier" || key.type === "identifier")) {
          names.push(key.text);
        }
      }
    }
    return names;
  }

  /** `require('./x')` or `import('./x')` — relative only matter downstream. */
  function visitCallExpression(node: Parser.SyntaxNode): void {
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    if (!fn || !args) return;

    const isRequire = fn.type === "identifier" && fn.text === "require";
    const isDynamicImport = fn.type === "import";
    if (!isRequire && !isDynamicImport) return;

    const src = stringFromArgs(args);
    if (!src) return;

    // Prefer named bindings when the call is the RHS of a destructuring
    // assignment: `const { a, b } = require('./x')`. Otherwise treat as a
    // namespace/default consume so orphan/dead-export don't false-positive.
    const parent = node.parent;
    let names: string[] = [];
    let namespace = true;
    if (parent?.type === "variable_declarator") {
      const binding = parent.childForFieldName("name");
      if (binding?.type === "object_pattern") {
        names = namesFromObjectPattern(binding);
        namespace = names.length === 0;
      } else if (binding?.type === "identifier") {
        names = isDynamicImport ? ["__default__"] : [];
        namespace = !isDynamicImport;
      }
    } else if (isDynamicImport) {
      names = ["__default__"];
      namespace = false;
    }

    imports.push({ source: src, names, namespace });
  }

  function namesFromObjectLiteral(obj: Parser.SyntaxNode): string[] {
    const names: string[] = [];
    for (const child of obj.namedChildren) {
      if (child.type === "shorthand_property_identifier") names.push(child.text);
      else if (child.type === "pair") {
        const key = child.childForFieldName("key");
        if (key && (key.type === "property_identifier" || key.type === "identifier" || key.type === "string")) {
          names.push(key.type === "string" ? (stringFieldText(key) ?? key.text) : key.text);
        }
      }
    }
    return names;
  }

  function describeCjsExportLeft(
    member: Parser.SyntaxNode,
  ): { kind: "default" } | { kind: "named"; name: string } | undefined {
    const obj = member.childForFieldName("object");
    const prop = member.childForFieldName("property");
    if (!obj || !prop) return undefined;

    // exports.foo =
    if (obj.type === "identifier" && obj.text === "exports") {
      return { kind: "named", name: prop.text };
    }

    // module.exports =
    if (obj.type === "identifier" && obj.text === "module" && prop.text === "exports") {
      return { kind: "default" };
    }

    // module.exports.foo =
    if (obj.type === "member_expression") {
      const innerObj = obj.childForFieldName("object");
      const innerProp = obj.childForFieldName("property");
      if (
        innerObj?.type === "identifier" &&
        innerObj.text === "module" &&
        innerProp?.text === "exports"
      ) {
        return { kind: "named", name: prop.text };
      }
    }
    return undefined;
  }

  function visitAssignment(node: Parser.SyntaxNode): void {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || left.type !== "member_expression") return;

    const target = describeCjsExportLeft(left);
    if (!target) return;

    if (target.kind === "default") {
      if (right?.type === "object") {
        for (const name of namesFromObjectLiteral(right)) exportedNames.add(name);
      } else {
        exportedNames.add("__default__");
      }
      return;
    }

    exportedNames.add(target.name);
  }

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "import_statement") visitImport(node);
    else if (node.type === "export_statement") visitExport(node);
    else if (node.type === "call_expression") visitCallExpression(node);
    else if (node.type === "assignment_expression") visitAssignment(node);
    for (const child of node.namedChildren) visit(child);
  }

  visit(tree.rootNode);
  return { imports, reexports, exportedNames };
}
