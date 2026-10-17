import type { SymbolInfo } from "@hive/shared";

// Client-side fallback for GET /api/files symbols: top-level declarations by regex,
// end line by brace balance (or until the next declaration).
const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|const|let|var|type|interface|enum)\s+\*?\s*([A-Za-z_$][\w$]*)/;

export function findSymbols(content: string): SymbolInfo[] {
  const lines = content.split("\n");
  const starts: { line: number; kind: SymbolInfo["kind"]; name: string; exported: boolean }[] = [];
  lines.forEach((text, i) => {
    const m = DECL.exec(text);
    if (!m) return;
    const raw = m[1] ?? "";
    const kind: SymbolInfo["kind"] =
      raw === "function" ? "function" : raw === "class" || raw === "enum" ? "class" : raw === "interface" ? "interface" : raw === "type" ? "type" : "const";
    starts.push({ line: i + 1, kind, name: m[2] ?? "", exported: /^export\b/.test(text) });
  });
  return starts.map((s, idx) => {
    const nextStart = starts[idx + 1]?.line ?? lines.length + 1;
    let depth = 0;
    let seenBrace = false;
    let end = s.line;
    for (let ln = s.line; ln < nextStart; ln++) {
      const text = lines[ln - 1] ?? "";
      for (const ch of text) {
        if (ch === "{") {
          depth++;
          seenBrace = true;
        } else if (ch === "}") depth--;
      }
      end = ln;
      if (seenBrace && depth <= 0) break;
      if (!seenBrace && /;\s*$/.test(text)) break;
    }
    // Trim trailing blank lines when we ran up to the next declaration.
    while (end > s.line && (lines[end - 1] ?? "").trim() === "") end--;
    return { name: s.name, kind: s.kind, startLine: s.line, endLine: end, exported: s.exported };
  });
}

export function symbolRange(symbols: SymbolInfo[], name: string): { startLine: number; endLine: number } | null {
  const s = symbols.find((x) => x.name === name);
  return s ? { startLine: s.startLine, endLine: s.endLine } : null;
}
