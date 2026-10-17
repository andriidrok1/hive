import type { Intent, IntentId, SymbolInfo } from "@hive/shared";
import { intentColor } from "../state";
import { findSymbols } from "../symbols";

export interface IntentRange {
  intent: Intent;
  startLine: number;
  endLine: number;
  color: string;
  label: string;
  earlier: IntentId[]; // folded older intents of the same agent on this symbol
}

export function intentLabel(i: Intent): string {
  return `${i.agentId}: ${i.what} → ${i.output}`;
}

export function earlierSuffix(earlier: IntentId[]): string {
  return earlier.length ? ` +${earlier.length} earlier` : "";
}

// Map the intents of a file to line ranges. Server symbols win; the regex fallback runs on the live text.
// Callers pass already-filtered intents (see intentsView.visibleIntents) and the folded ids per intent.
export function intentRanges(intents: Intent[], content: string, serverSymbols: SymbolInfo[] | null, earlier: Record<IntentId, IntentId[]> = {}): IntentRange[] {
  const symbols = serverSymbols && serverSymbols.length > 0 ? serverSymbols : findSymbols(content);
  const lineCount = content.split("\n").length;
  const out: IntentRange[] = [];
  for (const intent of intents) {
    const s = symbols.find((x) => x.name === intent.target.symbol);
    if (!s) continue;
    const folded = earlier[intent.id] ?? [];
    out.push({
      intent,
      startLine: Math.min(s.startLine, lineCount),
      endLine: Math.min(s.endLine, lineCount),
      color: intentColor(intent.status, intent.agentId),
      label: intentLabel(intent) + earlierSuffix(folded),
      earlier: folded,
    });
  }
  return out.sort((a, b) => a.startLine - b.startLine || a.intent.createdAt - b.intent.createdAt);
}
