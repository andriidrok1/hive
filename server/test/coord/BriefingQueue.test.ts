import { describe, expect, it, vi } from "vitest";
import { BriefingQueue } from "../../src/coord/BriefingQueue.js";
import { eventSink } from "./fakes.js";

const base = { kind: "symbol_changed" as const, summary: "calculateTotal changed", details: { file: "src/checkout.ts", symbol: "calculateTotal" } };

describe("BriefingQueue", () => {
  it("4. delivers once, tracks required acks, validates ack ownership", () => {
    const q = new BriefingQueue();
    const b = q.push({ ...base, toAgent: "agent-b", requiresAck: true });
    expect(b.id).toBe("br_1");
    expect(b.createdAt).toBeGreaterThan(0);

    expect(q.takeUndelivered("agent-a")).toEqual([]);
    expect(q.takeUndelivered("agent-b")).toEqual([b]);
    expect(q.takeUndelivered("agent-b")).toEqual([]);

    expect(q.unackedRequired("agent-b").map((x) => x.id)).toEqual(["br_1"]);
    expect(q.ack("agent-a", "br_1", { response: "adapted" })).toBe(false);
    expect(q.ack("agent-b", "br_nope", { response: "adapted" })).toBe(false);
    expect(q.unackedRequired("agent-b")).toHaveLength(1);
    expect(q.ack("agent-b", "br_1", { response: "adapted", note: "ok" })).toBe(true);
    expect(q.unackedRequired("agent-b")).toEqual([]);
    expect(q.get("br_1")?.ack).toMatchObject({ response: "adapted", note: "ok" });
    expect(q.all()).toHaveLength(1);
  });

  it("unackedRequired includes undelivered briefings; requiresAck=false never blocks", () => {
    const q = new BriefingQueue();
    q.push({ ...base, toAgent: "agent-b", requiresAck: true });
    q.push({ ...base, toAgent: "agent-b", requiresAck: false });
    expect(q.unackedRequired("agent-b").map((x) => x.id)).toEqual(["br_1"]);
  });

  it("clips summary to 400 and diff to 2000 chars", () => {
    const q = new BriefingQueue();
    const b = q.push({ ...base, toAgent: "agent-b", requiresAck: false, summary: "x".repeat(1000), details: { diff: "y".repeat(5000) } });
    expect(b.summary.length).toBeLessThanOrEqual(400);
    expect(b.details.diff?.length).toBeLessThanOrEqual(2000);
  });

  it("upsert replaces a pending briefing with the same agent/kind/sender/file/symbol inside the window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
      const sink = eventSink();
      const q = new BriefingQueue({ onEvent: sink.onEvent });
      const first = q.upsert({ ...base, toAgent: "agent-b", fromAgent: "agent-a", requiresAck: true, summary: "v1", details: { ...base.details, diff: "d1" } });
      vi.advanceTimersByTime(1000);
      const second = q.upsert({ ...base, toAgent: "agent-b", fromAgent: "agent-a", requiresAck: true, summary: "v2", details: { ...base.details, diff: "d2" } });
      expect(second.id).toBe(first.id);
      expect(q.all()).toHaveLength(1);
      expect(q.get(first.id)).toMatchObject({ summary: "v2", details: { diff: "d2" } });
      expect(sink.ofType("briefing_sent")).toHaveLength(1);

      // different sender, different symbol, different agent: separate briefings
      q.upsert({ ...base, toAgent: "agent-b", fromAgent: "agent-m", requiresAck: true, summary: "other actor" });
      q.upsert({ ...base, toAgent: "agent-b", fromAgent: "agent-a", requiresAck: true, summary: "other symbol", details: { file: "src/checkout.ts", symbol: "applyTax" } });
      q.upsert({ ...base, toAgent: "agent-c", fromAgent: "agent-a", requiresAck: true, summary: "other agent" });
      expect(q.all()).toHaveLength(4);

      // outside the window: new briefing
      vi.advanceTimersByTime(3001);
      expect(q.upsert({ ...base, toAgent: "agent-b", fromAgent: "agent-a", requiresAck: true, summary: "v3" }).id).not.toBe(first.id);
      expect(q.all()).toHaveLength(5);

      // delivered ones are never replaced
      const d = q.upsert({ ...base, toAgent: "agent-d", requiresAck: true, summary: "x" });
      q.takeUndelivered("agent-d");
      expect(q.upsert({ ...base, toAgent: "agent-d", requiresAck: true, summary: "y" }).id).not.toBe(d.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("11d. emits briefing_sent on push and briefing_acked on ack, each once", () => {
    const sink = eventSink();
    const q = new BriefingQueue({ onEvent: sink.onEvent });
    const b = q.push({ ...base, toAgent: "agent-b", requiresAck: true });
    q.ack("agent-b", b.id, { response: "not_relevant" });
    q.ack("agent-b", b.id, { response: "not_relevant" }); // idempotent
    expect(sink.events.map((e) => e.type)).toEqual(["briefing_sent", "briefing_acked"]);
    expect(sink.ofType("briefing_sent")[0]?.briefing.id).toBe(b.id);
    expect(sink.ofType("briefing_acked")[0]).toMatchObject({ briefingId: b.id, agentId: "agent-b", ack: { response: "not_relevant" } });
  });
});
