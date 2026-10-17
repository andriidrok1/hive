import type { AgentControl, AgentId, FeedEventBody, HiveState, HumanId, IntentId, SymbolInfo } from "@hive/shared";

// In ?mock=1 mode there is no server: human actions are turned into local feed events
// through this sink so the buttons still do something visible.
let mockSink: ((body: FeedEventBody) => void) | null = null;
export function setMockSink(sink: ((body: FeedEventBody) => void) | null): void {
  mockSink = sink;
}

async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export async function fetchState(): Promise<HiveState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`/api/state → ${res.status}`);
  return (await res.json()) as HiveState;
}

export async function fetchFile(path: string): Promise<{ content: string; rev: number; symbols: SymbolInfo[] }> {
  const res = await fetch(`/api/files/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (!res.ok) throw new Error(`/api/files/${path} → ${res.status}`);
  return (await res.json()) as { content: string; rev: number; symbols: SymbolInfo[] };
}

// GET /api/preview: the demo app evaluated on the current project (shape from the server brief).
export interface PreviewData {
  ok: boolean;
  items?: unknown;
  promo?: unknown;
  summary?: { subtotal: number; discount: number; total: number; lines: string[] };
  receipt?: string | null;
  receiptWidth?: number;
  formatPercent?: string | number | null;
  negative?: string | number | null;
  summaryError?: string;
  receiptError?: string;
  error?: string;
}

export async function fetchPreview(): Promise<PreviewData> {
  const res = await fetch("/api/preview");
  if (!res.ok) throw new Error(`/api/preview → ${res.status}`);
  return (await res.json()) as PreviewData;
}

export async function startAgent(args: { agentId: AgentId; humanId: HumanId; task: string }): Promise<void> {
  if (mockSink) {
    mockSink({ type: "agent_status", agentId: args.agentId, humanId: args.humanId, status: "thinking", task: args.task, step: 1 });
    return;
  }
  await post("/api/agents", args);
}

export async function controlAgent(agentId: AgentId, humanId: HumanId, control: AgentControl): Promise<void> {
  if (mockSink) {
    mockSink({ type: "human_action", humanId, action: control, target: agentId });
    mockSink({ type: "agent_status", agentId, humanId, status: control === "pause" ? "paused" : control === "stop" ? "stopped" : "thinking" });
    return;
  }
  await post(`/api/agents/${encodeURIComponent(agentId)}/control`, { humanId, control });
}

export async function sendNote(agentId: AgentId, humanId: HumanId, text: string, urgent = false): Promise<void> {
  if (mockSink) {
    mockSink({ type: "human_action", humanId, action: urgent ? "urgent note" : "note", target: agentId });
    mockSink({
      type: "briefing_sent",
      briefing: {
        id: `br_h${Date.now() % 10_000}`,
        toAgent: agentId,
        kind: "human_note",
        fromHuman: humanId,
        summary: text,
        details: {},
        requiresAck: urgent,
        createdAt: Date.now(),
      },
    });
    return;
  }
  await post(`/api/agents/${encodeURIComponent(agentId)}/note`, { humanId, text, urgent });
}

export async function setIntentOutput(intentId: IntentId, humanId: HumanId, output: string): Promise<void> {
  if (mockSink) {
    mockSink({ type: "human_action", humanId, action: `edited contract of ${intentId}`, target: output.slice(0, 60) });
    return;
  }
  await post(`/api/intents/${encodeURIComponent(intentId)}/output`, { humanId, output });
}

export async function resolveConflict(humanId: HumanId, keep: IntentId, cancel: IntentId): Promise<void> {
  if (mockSink) {
    mockSink({ type: "human_action", humanId, action: `kept ${keep}, cancelled ${cancel}` });
    mockSink({ type: "intent_status", intentId: keep, status: "approved" });
    mockSink({ type: "intent_status", intentId: cancel, status: "cancelled" });
    return;
  }
  await post("/api/intents/resolve", { humanId, keep, cancel });
}

export async function resetHive(mode?: string): Promise<void> {
  if (mockSink) return;
  await post("/api/reset", mode ? { mode } : {});
}
