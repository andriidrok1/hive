import ts from "typescript";
import type { CallSite, SymbolInfo } from "@hive/shared";

export interface FileAnalysis {
  symbols: SymbolInfo[];
  calls: CallSite[];
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseSource(path: string, content: string): ts.SourceFile {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindFor(path));
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Symbols (top-level declarations) and call sites of one TypeScript file. */
export function analyzeFile(path: string, content: string): FileAnalysis {
  const sf = parseSource(path, content);
  const symbols: SymbolInfo[] = [];
  const calls: CallSite[] = [];
  const reExported = new Set<string>();

  const pushSymbol = (name: string, kind: SymbolInfo["kind"], node: ts.Node, exported: boolean) => {
    symbols.push({
      name,
      kind,
      startLine: lineOf(sf, node.getStart(sf)),
      endLine: lineOf(sf, node.getEnd()),
      exported,
    });
  };

  const collectCalls = (node: ts.Node, caller: string | null) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        calls.push({ file: path, line: lineOf(sf, callee.getStart(sf)), caller, callee: callee.text });
      }
    }
    ts.forEachChild(node, (child) => collectCalls(child, caller));
  };

  for (const stmt of sf.statements) {
    const exported = hasExportModifier(stmt);
    let owner: string | null = null;

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      owner = stmt.name.text;
      pushSymbol(owner, "function", stmt, exported);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      owner = stmt.name.text;
      pushSymbol(owner, "class", stmt, exported);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      owner = stmt.name.text;
      pushSymbol(owner, "type", stmt, exported);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      owner = stmt.name.text;
      pushSymbol(owner, "interface", stmt, exported);
    } else if (ts.isVariableStatement(stmt)) {
      const names: string[] = [];
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
      }
      for (const name of names) pushSymbol(name, "const", stmt, exported);
      // `const a = ..., b = ...` is rare; attribute calls to the first declared name.
      owner = names[0] ?? null;
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) reExported.add((el.propertyName ?? el.name).text);
      continue;
    }

    collectCalls(stmt, owner);
  }

  for (const s of symbols) if (reExported.has(s.name)) s.exported = true;

  return { symbols, calls };
}

/** Source text of a symbol (its full line range). */
export function symbolText(content: string, sym: SymbolInfo): string {
  const lines = content.split("\n");
  return lines.slice(sym.startLine - 1, sym.endLine).join("\n");
}

/** Print the file without comments and with whitespace collapsed; used to detect comment-only edits. */
export function normalizeCode(path: string, content: string): string {
  const sf = parseSource(path, content);
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printFile(sf).replace(/\s+/g, " ").trim();
}

export interface SymbolSource {
  kind: SymbolInfo["kind"];
  /** Header up to the first `{` (or the whole declaration if it has none), comments stripped, whitespace collapsed. */
  sig: string;
  /** From the first `{` on, comments stripped, whitespace collapsed. */
  body: string;
}

/** Comment-free, whitespace-collapsed source of each top-level symbol, split into signature and body. */
export function symbolSources(path: string, content: string): Map<string, SymbolSource> {
  const sf = parseSource(path, content);
  const printer = ts.createPrinter({ removeComments: true });
  const out = new Map<string, SymbolSource>();
  const put = (name: string, kind: SymbolInfo["kind"], node: ts.Node) => {
    const text = printer.printNode(ts.EmitHint.Unspecified, node, sf).replace(/\s+/g, " ").trim();
    // for `const f = (...) => {...}` this makes the signature everything before the arrow body
    const brace = text.indexOf("{");
    const split = brace === -1 ? text.length : brace;
    out.set(name, { kind, sig: text.slice(0, split).trim(), body: text.slice(split).trim() });
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) put(stmt.name.text, "function", stmt);
    else if (ts.isClassDeclaration(stmt) && stmt.name) put(stmt.name.text, "class", stmt);
    else if (ts.isTypeAliasDeclaration(stmt)) put(stmt.name.text, "type", stmt);
    else if (ts.isInterfaceDeclaration(stmt)) put(stmt.name.text, "interface", stmt);
    else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) if (ts.isIdentifier(decl.name)) put(decl.name.text, "const", decl);
    }
  }
  return out;
}

/** Symbols whose line range overlaps [startLine, endLine] (1-based, inclusive). */
export function symbolsInRange(symbols: SymbolInfo[], startLine: number, endLine: number): SymbolInfo[] {
  return symbols.filter((s) => s.startLine <= endLine && s.endLine >= startLine);
}
