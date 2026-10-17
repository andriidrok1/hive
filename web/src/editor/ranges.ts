import type { Intent, SymbolInfo } from "@hive/shared";
import { intentColor } from "../state";
import { findSymbols } from "../symbols";

export interface IntentRange {
  intent: Intent;
  startLine: number;
  endLine: number;
  color: string;
  label: string;
}

export function intentLabel(i: Intent): string {
  return `${i.agentId}: ${i.what} → ${i.output}`;
}

// Map the intents of a file to line ranges. Server symbols win; the regex fallback runs on the live text.
export function intentRanges(intents: Intent[], content: string, serverSymbols: SymbolInfo[] | null): IntentRange[] {
  const symbols = serverSymbols && serverSymbols.length > 0 ? serverSymbols : findSymbols(content);
  const lineCount = content.split("\n").length;
  const out: IntentRange[] = [];
  for (const intent of intents) {
    const s = symbols.find((x) => x.name === intent.target.symbol);
    if (!s) continue;
    out.push({
      intent,
      startLine: Math.min(s.startLine, lineCount),
      endLine: Math.min(s.endLine, lineCount),
      color: intentColor(intent.status, intent.agentId),
      label: intentLabel(intent),
    });
  }
  return out.sort((a, b) => a.startLine - b.startLine || a.intent.createdAt - b.intent.createdAt);
}
