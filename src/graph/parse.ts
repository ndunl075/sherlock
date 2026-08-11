// tree-sitter parsing — ARCHITECTURE.md §3 (graph/), §10 ("one grammar
// interface across languages").
//
// v1 scope, deliberately narrow: JS/TS family only (.ts/.tsx/.js/.jsx/.mjs/
// .cjs), ES module import/export syntax only. No CommonJS `require()`, no
// dynamic `import()`, no path-alias resolution (tsconfig `paths`, webpack
// aliases) — only relative specifiers (`./x`, `../x`) get resolved. Each of
// those is a real gap for some repos; each is also a bounded, well-understood
// one to close later behind this same interface without touching callers.

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

/** Parse one file's ES module surface: what it imports, what it re-exports, what it exports. Returns null for unsupported extensions. */
export function parseModule(source: string, ext: string): ModuleInfo | null {
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

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "import_statement") visitImport(node);
    else if (node.type === "export_statement") visitExport(node);
    for (const child of node.namedChildren) visit(child);
  }

  visit(tree.rootNode);
  return { imports, reexports, exportedNames };
}
