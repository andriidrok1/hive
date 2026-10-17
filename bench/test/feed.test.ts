import { describe, expect, it } from "vitest";
import type { FeedEvent, FeedEventBody, Intent } from "@hive/shared";
import { FeedCounters } from "../src/feed.js";

// A scripted feed shaped like a real hive run of s01: A declares, M declares the same target and
// gets a conflict, briefings go both ways, one ack is "adapted", tests fail, a culprit search names A1 and M3.
function intent(id: string, agentId: string, status: Intent["status"]): Intent {
  return {
    id,
    agentId,
    humanId: agentId.replace("agent-", ""),
    status,
    createdAt: 0,
    updatedAt: 0,
    baseRev: 0,
    target: { file: "src/order.ts", symbol: "orderSummary" },
    action: "modify",
    what: "change orderSummary",
    input: "items, promo, state",
    output: "receipt with tax line",
  };
}

const script: FeedEventBody[] = [
  { type: "agent_status", agentId: "agent-oleg", humanId: "oleg", status: "thinking", task: "t" },
  { type: "llm_call", purpose: "agent:agent-oleg", model: "m", ms: 900, tokensIn: 5000, tokensOut: 120 },
  { type: "agent_status", agentId: "agent-oleg", humanId: "oleg", status: "tool", step: 1 },
  { type: "file_read", agentId: "agent-oleg", path: "src/checkout.ts", rev: 0 },
  { type: "agent_status", agentId: "agent-oleg", humanId: "oleg", status: "tool", step: 2 },
  { type: "intent_declared", intent: intent("A1", "agent-oleg", "approved"), conflicts: [], dependents: [] },
  { type: "llm_call", purpose: "check:contradiction", model: "nano", ms: 400, tokensIn: 800, tokensOut: 20 },
  // the agent loop reports uncached input and cached input separately
  { type: "llm_call", purpose: "agent:agent-masha", model: "m", ms: 700, tokensIn: 1500, tokensOut: 60, tokensCached: 4000 } as FeedEventBody,
  { type: "agent_status", agentId: "agent-masha", humanId: "masha", status: "tool", step: 1 },
  {
    type: "intent_declared",
    intent: intent("M1", "agent-masha", "conflict"),
    conflicts: [{ intentId: "A1", kind: "same_target", reason: "agent-oleg is already changing orderSummary" }],
    dependents: [],
  },
  { type: "briefing_sent", briefing: { id: "br_1", toAgent: "agent-masha", kind: "intent_conflict", summary: "wait", details: {}, requiresAck: true, createdAt: 0 } },
  { type: "briefing_sent", briefing: { id: "br_2", toAgent: "agent-oleg", kind: "intent_conflict", fromAgent: "agent-masha", summary: "conflict", details: {}, requiresAck: true, createdAt: 0 } },
  { type: "briefing_acked", briefingId: "br_1", agentId: "agent-masha", ack: { response: "not_relevant", at: 0 } },
  { type: "briefing_acked", briefingId: "br_2", agentId: "agent-oleg", ack: { response: "adapted", note: "will pass state", at: 0 } },
  { type: "intent_status", intentId: "M1", status: "cancelled" },
  { type: "intent_declared", intent: intent("M3", "agent-masha", "approved"), conflicts: [], dependents: ["agent-oleg"] },
  { type: "briefing_sent", briefing: { id: "br_3", toAgent: "agent-oleg", kind: "intent_declared", summary: "heads up", details: {}, requiresAck: true, createdAt: 0 } },
  { type: "edit_applied", agentId: "agent-oleg", intentId: "A1", path: "src/checkout.ts", rev: 1, added: 3, removed: 1 },
  { type: "edit_applied", agentId: "agent-masha", intentId: "M3", path: "src/order.ts", rev: 2, added: 6, removed: 2 },
  { type: "test_run_started", runId: "r1", rev: 2, reason: "intent A1 finished" },
  { type: "test_run_finished", runId: "r1", rev: 2, result: { ok: false, passed: 20, failed: 3, failures: [], durationMs: 900 } },
  { type: "culprit_search_started", searchId: "cs1", suspects: ["A1", "M3"] },
  { type: "culprit_variant_result", searchId: "cs1", variant: { label: "green+A1", applied: ["A1"], ok: true } },
  { type: "culprit_found", searchId: "cs1", report: { kind: "pair", culprits: ["M3", "A1"], greenRev: 0, variants: [], durationMs: 3000 } },
  { type: "agent_status", agentId: "agent-oleg", humanId: "oleg", status: "done" },
  { type: "agent_status", agentId: "agent-masha", humanId: "masha", status: "done" },
];

function replay(bodies: FeedEventBody[]): FeedCounters {
  const c = new FeedCounters();
  bodies.forEach((b, i) => c.ingest({ id: i + 1, ts: i, ...b } as FeedEvent));
  return c;
}

describe("FeedCounters on a scripted hive run", () => {
  const c = replay(script);

  it("counts tool calls and tokens from agent_status and llm_call", () => {
    expect(c.toolCalls).toBe(3);
    expect(c.llmCalls).toBe(3);
    expect(c.agentLlmCalls).toBe(2);
    expect(c.tokensIn).toBe(5000 + 800 + 1500 + 4000); // cached tokens count toward the total prompt size
    expect(c.tokensCached).toBe(4000);
    expect(c.tokensOut).toBe(200);
  });

  it("treats an llm_call without tokensCached as fully uncached", () => {
    const c0 = replay([{ type: "llm_call", purpose: "agent:a", model: "m", ms: 1, tokensIn: 300, tokensOut: 10 }]);
    expect(c0.tokensIn).toBe(300);
    expect(c0.tokensCached).toBe(0);
  });

  it("counts the conflict caught before code from intent_declared", () => {
    expect(c.intentsDeclared).toBe(3);
    expect(c.conflictsCaught).toBe(1);
  });

  it("also counts a conflict when only the intent status says so", () => {
    const only = replay([{ type: "intent_declared", intent: intent("M1", "agent-masha", "conflict"), conflicts: [], dependents: [] }]);
    expect(only.conflictsCaught).toBe(1);
    const none = replay([{ type: "intent_declared", intent: intent("A1", "agent-oleg", "approved"), conflicts: [], dependents: [] }]);
    expect(none.conflictsCaught).toBe(0);
  });

  it("counts briefings and adapted acks", () => {
    expect(c.briefingsSent).toBe(3);
    expect(c.acksAdapted).toBe(1);
  });

  it("counts culprit searches and judges the report by owners", () => {
    expect(c.culpritSearches).toBe(1);
    expect(c.lastCulpritOwners()).toEqual(["agent-oleg", "agent-masha"]);
    expect(c.culpritCorrect(["agent-oleg", "agent-masha"])).toBe(true);
    expect(c.culpritCorrect(["agent-masha", "agent-oleg"])).toBe(true);
    expect(c.culpritCorrect(["agent-oleg"])).toBe(false);
    expect(c.culpritCorrect([])).toBe(false);
  });

  it("reports null culprit correctness when no report arrived", () => {
    const before = replay(script.slice(0, 22));
    expect(before.culpritSearches).toBe(1);
    expect(before.culpritCorrect(["agent-oleg", "agent-masha"])).toBeNull();
  });

  it("keeps unknown culprit intent ids as-is instead of dropping them", () => {
    const c2 = replay([{ type: "culprit_found", searchId: "x", report: { kind: "single", culprits: ["Z9"], greenRev: 0, variants: [], durationMs: 1 } }]);
    expect(c2.lastCulpritOwners()).toEqual(["Z9"]);
    expect(c2.culpritCorrect(["agent-oleg"])).toBe(false);
  });

  it("ignores malformed frames the same way the subscription does", () => {
    const c3 = new FeedCounters();
    expect(() => c3.ingest(JSON.parse('{"id":1,"ts":0,"type":"something_new"}') as FeedEvent)).not.toThrow();
    expect(c3.events).toBe(1);
  });
});
