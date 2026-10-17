import { createHash } from "node:crypto";
import type { CallSite, SymbolInfo } from "@hive/shared";
import { analyzeFile, type FileAnalysis } from "./analyze.js";

interface Entry {
  hash: string;
  analysis: FileAnalysis;
}

const ANALYZABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Cross-file symbol index. `update` merges: files not mentioned keep their last analysis. */
export class CallGraph {
  private entries = new Map<string, Entry>();

  update(files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      if (!ANALYZABLE.test(path)) continue;
      const hash = createHash("sha1").update(content).digest("hex");
      const prev = this.entries.get(path);
      if (prev && prev.hash === hash) continue;
      this.entries.set(path, { hash, analysis: analyzeFile(path, content) });
    }
  }

  remove(path: string): void {
    this.entries.delete(path);
  }

  files(): string[] {
    return [...this.entries.keys()];
  }

  symbolsOf(path: string): SymbolInfo[] {
    return this.entries.get(path)?.analysis.symbols ?? [];
  }

  callsOf(path: string): CallSite[] {
    return this.entries.get(path)?.analysis.calls ?? [];
  }

  /** Every call site in the project whose callee is `symbol`. */
  callersOf(symbol: string): CallSite[] {
    const out: CallSite[] = [];
    for (const { analysis } of this.entries.values()) {
      for (const c of analysis.calls) if (c.callee === symbol) out.push(c);
    }
    return out;
  }

  /** Names of symbols called from inside `symbol` (any file that declares it). */
  calleesOf(symbol: string): string[] {
    const out = new Set<string>();
    for (const { analysis } of this.entries.values()) {
      if (!analysis.symbols.some((s) => s.name === symbol)) continue;
      for (const c of analysis.calls) if (c.caller === symbol) out.add(c.callee);
    }
    return [...out];
  }

  /** Files that declare a top-level symbol with this name. */
  filesDeclaring(symbol: string): string[] {
    const out: string[] = [];
    for (const [path, { analysis }] of this.entries) {
      if (analysis.symbols.some((s) => s.name === symbol)) out.push(path);
    }
    return out;
  }

  symbolAt(path: string, line: number): SymbolInfo | null {
    const symbols = this.symbolsOf(path);
    let best: SymbolInfo | null = null;
    for (const s of symbols) {
      if (s.startLine <= line && line <= s.endLine) {
        if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
      }
    }
    return best;
  }
}
