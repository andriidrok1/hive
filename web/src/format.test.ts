import { describe, expect, it } from "vitest";
import type { FeedEvent } from "@hive/shared";
import { describeReport, formatEvent } from "./format";
import { MOCK_EVENTS } from "./mock";

// Every member of the FeedEvent union, built by hand so the test fails to compile when the
// contract grows a type the formatter does not handle (formatEvent has an exhaustive switch).
const base = { id: 1, ts: 1_760_700_000_000 };
const samples: Record<FeedEvent["type"], FeedEvent> = {
  agent_status: { ...base, type: "agent_status", agentId: "agent-a", humanId: "a", status: "thinking", task: "do x", step: 2 },
  file_read: { ...base, type: "file_read", agentId: "agent-a", path: "src/x.ts", rev: 3 },
  intent_declared: {
    ...base,
    type: "intent_declared",
    intent: { id: "A1", agentId: "agent-a", humanId: "a", status: "approved", createdAt: 1, updatedAt: 1, baseRev: 0, target: { file: "src/x.ts", symbol: "f" }, action: "modify", what: "change f", input: "", output: "returns y" },
    conflicts: [{ intentId: "B1", kind: "contradiction", reason: "r" }],
    dependents: ["agent-b"],
  },
  intent_status: { ...base, type: "intent_status", intentId: "A1", status: "verified" },
  edit_applied: { ...base, type: "edit_applied", agentId: "agent-a", intentId: "A1", path: "src/x.ts", rev: 4, added: 2, removed: 1 },
  briefing_sent: { ...base, type: "briefing_sent", briefing: { id: "br_1", toAgent: "agent-b", kind: "symbol_changed", summary: "s", details: {}, requiresAck: true, createdAt: 1 } },
  briefing_acked: { ...base, type: "briefing_acked", briefingId: "br_1", agentId: "agent-b", ack: { response: "adapted", note: "n", at: 1 } },
  message_sent: { ...base, type: "message_sent", message: { id: "msg_1", from: "agent-a", to: "agent-b", about: "f", text: "q?", exchange: 1, createdAt: 1 } },
  test_run_started: { ...base, type: "test_run_started", runId: "r1", rev: 4, reason: "A1 finished" },
  test_run_finished: { ...base, type: "test_run_finished", runId: "r1", rev: 4, result: { ok: false, passed: 3, failed: 1, failures: [{ name: "t", message: "m" }], durationMs: 1200 } },
  culprit_search_started: { ...base, type: "culprit_search_started", searchId: "cs1", suspects: ["A1", "B1"] },
  culprit_variant_result: { ...base, type: "culprit_variant_result", searchId: "cs1", variant: { label: "green+A1", applied: ["A1"], ok: true } },
  culprit_found: {
    ...base,
    type: "culprit_found",
    searchId: "cs1",
    report: { kind: "pair", culprits: ["A1", "B1"], greenRev: 0, variants: [{ label: "green+A1", applied: ["A1"], ok: true }, { label: "green+B1", applied: ["B1"], ok: true }], durationMs: 5000 },
  },
  human_action: { ...base, type: "human_action", humanId: "a", action: "paused", target: "agent-a" },
  llm_call: { ...base, type: "llm_call", purpose: "agent:agent-a", model: "gpt-5.4-mini", ms: 900, tokensIn: 100, tokensOut: 20 },
};

describe("formatEvent", () => {
  it("returns readable text for every event type", () => {
    for (const [type, e] of Object.entries(samples)) {
      const line = formatEvent(e);
      expect(line.text.length, type).toBeGreaterThan(8);
      expect(line.tone, type).toBeTruthy();
    }
  });

  it("names the conflict and the pair", () => {
    expect(formatEvent(samples.intent_declared).text).toContain("CONFLICT with B1");
    expect(formatEvent(samples.intent_declared).tone).toBe("conflict");
    expect(formatEvent(samples.culprit_found).text).toBe("culprit: A1 alone ok, B1 alone ok, together red: conflict between A1 and B1");
    expect(formatEvent(samples.test_run_finished).text).toContain("RED");
  });

  it("formats the whole mock script without throwing", () => {
    for (const e of MOCK_EVENTS) expect(formatEvent(e).text).toBeTruthy();
  });

  it("describeReport handles single and unknown", () => {
    expect(describeReport({ kind: "single", culprits: ["A1"], variants: [] })).toContain("A1 breaks");
    expect(describeReport({ kind: "unknown", culprits: [], variants: [] })).toContain("no single culprit");
  });
});
