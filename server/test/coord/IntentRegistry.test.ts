import { describe, expect, it, vi } from "vitest";
import type { HiveMode, IntentInput } from "@hive/shared";
import { BriefingQueue } from "../../src/coord/BriefingQueue.js";
import { CallGraph } from "../../src/coord/CallGraph.js";
import { IntentRegistry, isVagueOutput } from "../../src/coord/IntentRegistry.js";
import { CHECK_PROMPTS, FakeLLM } from "../../src/coord/llm.js";
import { ReadLog } from "../../src/core/index.js";
import { CHECKOUT_TS, FakeReadLog, REPORT_TS, eventSink } from "./fakes.js";

const A = "agent-andrii";
const B = "agent-boris";
const M = "agent-masha";

function setup(opts: { conflict?: boolean | ((user: string) => boolean); mode?: HiveMode; files?: Record<string, string>; reservationMs?: number } = {}) {
  const sink = eventSink();
  const graph = new CallGraph();
  graph.update(opts.files ?? { "src/checkout.ts": CHECKOUT_TS, "src/report.ts": REPORT_TS });
  const reads = new FakeReadLog();
  const briefings = new BriefingQueue({ onEvent: sink.onEvent });
  const llm = new FakeLLM((system, user) => {
    if (system !== CHECK_PROMPTS.contradiction) throw new Error("unexpected prompt");
    const c = typeof opts.conflict === "function" ? opts.conflict(user) : !!opts.conflict;
    return { conflict: c, with: [], reason: c ? "promises contradict" : "" };
  });
  const intents = new IntentRegistry({ llm, graph, reads, briefings, onEvent: sink.onEvent, mode: opts.mode ?? "hive", ...(opts.reservationMs !== undefined ? { reservationMs: opts.reservationMs } : {}) });
  return { sink, graph, reads, briefings, llm, intents };
}

const calc = (over: Partial<IntentInput> = {}): IntentInput => ({
  target: { file: "src/checkout.ts", symbol: "calculateTotal" },
  action: "modify",
  what: "add tax to the total",
  input: "items: Item[], promo?: Promo",
  output: "returns subtotal minus discount WITH tax included",
  ...over,
});

const tax = (over: Partial<IntentInput> = {}): IntentInput => ({
  target: { file: "src/checkout.ts", symbol: "applyTax" },
  action: "modify",
  what: "use a per-state tax table",
  input: "items, state, promo?",
  output: "multiplies calculateTotal() by the tax rate of the state",
  ...over,
});

describe("IntentRegistry", () => {
  it("5. ids: agent-andrii gets A1, A2; agent-masha gets M1; letter collisions double up", async () => {
    const { intents } = setup();
    const a1 = await intents.declare(A, "andrii", calc(), 1);
    const a2 = await intents.declare(A, "andrii", tax(), 1);
    const m1 = await intents.declare(M, "masha", calc({ target: { file: "src/report.ts", symbol: "report" } }), 1);
    const al = await intents.declare("agent-alex", "alex", calc({ target: { file: "src/checkout.ts", symbol: "formatPrice" } }), 1);
    expect([a1.intent.id, a2.intent.id, m1.intent.id, al.intent.id]).toEqual(["A1", "A2", "M1", "AA1"]);
    expect(intents.list().map((i) => i.id)).toEqual(["A1", "A2", "M1", "AA1"]);
    expect(intents.get("A1")?.baseRev).toBe(1);
  });

  it("6. vague output rejected with BAD_ARGS; good intent approved when nothing else is active", async () => {
    const { intents, sink, briefings } = setup();
    for (const output of ["works", "it is done now", "fixed and updated", "function works correctly", "x"]) {
      await expect(intents.declare(A, "andrii", calc({ output }), 1)).rejects.toMatchObject({ code: "BAD_ARGS" });
    }
    await expect(intents.declare(A, "andrii", calc({ what: "tax" }), 1)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(isVagueOutput("returns subtotal minus discount")).toBe(false);

    const r = await intents.declare(A, "andrii", calc(), 3);
    expect(r.status).toBe("approved");
    expect(r.conflicts).toEqual([]);
    expect(r.dependents).toEqual([]);
    expect(r.intent).toMatchObject({ id: "A1", agentId: A, humanId: "andrii", status: "approved", baseRev: 3 });
    expect(briefings.all()).toEqual([]);
    expect(sink.events.map((e) => e.type)).toEqual(["intent_declared"]);
  });

  it("7. same-target conflict between two agents; both get an intent_conflict briefing", async () => {
    const { intents, briefings } = setup();
    const a = await intents.declare(A, "andrii", calc(), 1);
    const b = await intents.declare(B, "boris", calc({ what: "round the total to cents", output: "returns the subtotal rounded to whole cents" }), 1);
    expect(a.status).toBe("approved");
    expect(b.status).toBe("conflict");
    expect(b.conflicts).toEqual([{ intentId: "A1", kind: "same_target", reason: expect.stringContaining("calculateTotal") }]);
    expect(intents.get("B1")?.status).toBe("conflict");
    expect(intents.get("A1")?.status).toBe("approved");

    const toB = briefings.takeUndelivered(B);
    const toA = briefings.takeUndelivered(A);
    expect(toB).toHaveLength(1);
    expect(toB[0]).toMatchObject({ kind: "intent_conflict", requiresAck: true, details: { intentId: "B1", symbol: "calculateTotal" } });
    expect(toA).toHaveLength(1);
    expect(toA[0]).toMatchObject({ kind: "intent_conflict", requiresAck: true, fromAgent: B });

    // same agent declaring twice on the same target is not a conflict
    const a2 = await intents.declare(A, "andrii", calc(), 2);
    expect(a2.status).toBe("approved");
  });

  it("8. contradiction via the LLM: both get intent_conflict, status conflict", async () => {
    const { intents, briefings, llm } = setup({ conflict: true });
    const b = await intents.declare(B, "boris", tax(), 1);
    expect(b.status).toBe("approved");
    const a = await intents.declare(A, "andrii", calc(), 2);
    expect(a.status).toBe("conflict");
    expect(a.conflicts).toEqual([{ intentId: "B1", kind: "contradiction", reason: "promises contradict" }]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.system).toBe(CHECK_PROMPTS.contradiction);
    expect(llm.calls[0]?.user).toContain("WITH tax included");
    expect(llm.calls[0]?.user).toContain("multiplies calculateTotal()");
    expect(briefings.takeUndelivered(A).map((x) => x.kind)).toEqual(["intent_conflict"]);
    expect(briefings.takeUndelivered(B).map((x) => x.kind)).toEqual(["intent_conflict"]);
  });

  it("9. no contradiction when the LLM says false; unrelated symbols never reach the LLM", async () => {
    const { intents, llm } = setup({ conflict: false });
    await intents.declare(B, "boris", tax(), 1);
    const a = await intents.declare(A, "andrii", calc(), 2);
    expect(a.status).toBe("approved");
    expect(llm.calls).toHaveLength(1);
    // Receipt is neither caller nor callee of anything
    const m = await intents.declare(M, "masha", calc({ target: { file: "src/checkout.ts", symbol: "Receipt" }, output: "adds a taxCents field to Receipt" }), 3);
    expect(m.status).toBe("approved");
    expect(llm.calls).toHaveLength(1);
  });

  it("8b. done intents still count as promises; a dead LLM fails open", async () => {
    const { intents } = setup({ conflict: true });
    await intents.declare(B, "boris", tax(), 1);
    intents.setStatus("B1", "done");
    const a = await intents.declare(A, "andrii", calc(), 2);
    expect(a.status).toBe("conflict");

    const broken = setup();
    broken.llm = new FakeLLM(() => {
      throw new Error("boom");
    });
    const reg = new IntentRegistry({ llm: broken.llm, graph: broken.graph, reads: broken.reads, briefings: broken.briefings, onEvent: broken.sink.onEvent, mode: "hive" });
    await reg.declare(B, "boris", tax(), 1);
    expect((await reg.declare(A, "andrii", calc(), 2)).status).toBe("approved");
  });

  it("8c. failed intents do not block same_target but remain standing promises for the contradiction check", async () => {
    // same target: A1 failed on calculateTotal; M may take calculateTotal (the LLM is still consulted, says no)
    const { intents, llm } = setup({ conflict: false });
    await intents.declare(A, "andrii", calc(), 1);
    intents.setStatus("A1", "in_progress");
    intents.setStatus("A1", "failed");
    const m = await intents.declare(M, "masha", calc({ what: "round the total", output: "returns the subtotal rounded to whole cents" }), 2);
    expect(m.status).toBe("approved");
    expect(m.conflicts).toEqual([]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.user).toContain('"status": "failed"');

    // contradiction: A1 failed on calculateTotal (now includes tax); M declares on a caller -> conflict that lazy
    // reconciliation does NOT clear (failed is standing); cancelling A1 clears it
    const s2 = setup({ conflict: true });
    await s2.intents.declare(A, "andrii", calc(), 1);
    s2.intents.setStatus("A1", "failed");
    const m2 = await s2.intents.declare(M, "masha", tax({ what: "add tax on top of calculateTotal", output: "returns calculateTotal() plus state tax" }), 2);
    expect(m2.status).toBe("conflict");
    expect(m2.conflicts).toEqual([{ intentId: "A1", kind: "contradiction", reason: "promises contradict" }]);
    expect(s2.intents.get("M1")?.status).toBe("conflict");
    expect(s2.intents.list().find((i) => i.id === "M1")?.status).toBe("conflict");
    expect(s2.briefings.takeUndelivered(A).map((b) => b.kind)).toEqual(["intent_conflict"]);

    // the failed owner can still re-declare on its own target (no self-conflict)
    const a2 = await s2.intents.declare(A, "andrii", calc(), 3);
    expect(a2.status).toBe("approved");
    s2.intents.setStatus("A1", "cancelled");
    expect(s2.intents.get("M1")?.status).toBe("approved");
  });

  it("8d. reservation: an approved intent with no edits stops blocking after reservationMs; in_progress blocks regardless", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
      // declare after the window: approved outright
      const { intents, briefings, sink } = setup();
      await intents.declare(A, "andrii", calc(), 1);
      vi.advanceTimersByTime(45_001);
      const b = await intents.declare(B, "boris", calc({ what: "round the total", output: "returns the subtotal rounded to whole cents" }), 2);
      expect(b.status).toBe("approved");
      expect(briefings.all()).toEqual([]);
      expect(intents.isBlocking(intents.get("A1")!)).toBe(false);

      // declare inside the window: conflict; then the reservation expires and get()/list() re-approve lazily
      const s2 = setup({ reservationMs: 10_000 });
      await s2.intents.declare(A, "andrii", calc(), 1);
      vi.advanceTimersByTime(5_000);
      const b2 = await s2.intents.declare(B, "boris", calc({ what: "round the total", output: "returns the subtotal rounded to whole cents" }), 2);
      expect(b2.status).toBe("conflict");
      s2.briefings.takeUndelivered(B);
      s2.sink.events.length = 0;
      vi.advanceTimersByTime(4_999);
      expect(s2.intents.get("B1")?.status).toBe("conflict");
      expect(s2.sink.events).toEqual([]);
      vi.advanceTimersByTime(2);
      expect(s2.intents.get("B1")?.status).toBe("approved");
      expect(s2.sink.ofType("intent_status")).toEqual([{ type: "intent_status", intentId: "B1", status: "approved" }]);
      const toB = s2.briefings.takeUndelivered(B);
      expect(toB.map((x) => [x.kind, x.requiresAck])).toEqual([["intent_conflict", false]]);
      expect(toB[0]?.summary).toMatch(/approved now/);
      expect(s2.intents.canEdit(B, "B1")).toEqual({ ok: true });
      // idempotent: a second get()/list() emits nothing more
      s2.intents.list();
      s2.intents.reconcile();
      expect(s2.sink.ofType("intent_status")).toHaveLength(1);

      // in_progress keeps blocking long after the window; a later declare still conflicts
      const s3 = setup({ reservationMs: 1_000 });
      await s3.intents.declare(A, "andrii", calc(), 1);
      s3.intents.setStatus("A1", "in_progress");
      vi.advanceTimersByTime(60_000);
      const b3 = await s3.intents.declare(B, "boris", calc({ what: "round the total", output: "returns the subtotal rounded to whole cents" }), 2);
      expect(b3.status).toBe("conflict");
      vi.advanceTimersByTime(60_000);
      expect(s3.intents.get("B1")?.status).toBe("conflict");
      s3.intents.setStatus("A1", "done");
      expect(s3.intents.get("B1")?.status).toBe("approved");

      // a re-approval starts a fresh reservation for the re-approved intent
      expect(s3.intents.isBlocking(s3.intents.get("B1")!)).toBe(true);
      vi.advanceTimersByTime(1_001);
      expect(s3.intents.isBlocking(s3.intents.get("B1")!)).toBe(false);
      void sink;
    } finally {
      vi.useRealTimers();
    }
  });

  it("10. dependents: a reader of the symbol gets intent_declared with requiresAck", async () => {
    const { intents, reads, briefings } = setup();
    reads.record(B, "src/checkout.ts", 2, ["calculateTotal", "applyDiscount"]);
    reads.record(M, "src/checkout.ts", 2, ["formatPrice"]);
    reads.record(A, "src/checkout.ts", 2, ["calculateTotal"]);
    const a = await intents.declare(A, "andrii", calc(), 3);
    expect(a.status).toBe("approved");
    expect(a.dependents).toEqual([B]);
    const toB = briefings.takeUndelivered(B);
    expect(toB).toHaveLength(1);
    expect(toB[0]).toMatchObject({
      kind: "intent_declared",
      requiresAck: true,
      fromAgent: A,
      details: { file: "src/checkout.ts", symbol: "calculateTotal", intentId: "A1", yourUsages: [{ file: "src/checkout.ts", line: 15 }, { file: "src/checkout.ts", line: 33 }] },
    });
    expect(toB[0]?.summary).toContain("WITH tax included");
    expect(briefings.takeUndelivered(M)).toEqual([]);
    expect(briefings.takeUndelivered(A)).toEqual([]);
  });

  it("10b. owners of active intents on callers are dependents too", async () => {
    const { intents, briefings } = setup();
    await intents.declare(M, "masha", calc({ target: { file: "src/report.ts", symbol: "report" }, output: "returns the formatted total with a Total: prefix" }), 1);
    const a = await intents.declare(A, "andrii", calc(), 2);
    expect(a.dependents).toEqual([M]);
    expect(briefings.takeUndelivered(M)[0]).toMatchObject({ kind: "intent_declared", details: { yourUsages: [{ file: "src/report.ts", line: 5 }] } });
  });

  it("11. canEdit", async () => {
    const { intents } = setup();
    await intents.declare(A, "andrii", calc(), 1);
    await intents.declare(B, "boris", calc(), 1); // conflict
    expect(intents.canEdit(A, "A1")).toEqual({ ok: true });
    expect(intents.canEdit(B, "A1")).toEqual({ ok: false, code: "NOT_YOUR_INTENT" });
    expect(intents.canEdit(A, "Z9")).toEqual({ ok: false, code: "NO_INTENT" });
    expect(intents.canEdit(B, "B1")).toEqual({ ok: false, code: "INTENT_NOT_APPROVED" });
    intents.setStatus("A1", "in_progress");
    expect(intents.canEdit(A, "A1")).toEqual({ ok: true });
    intents.setStatus("A1", "done");
    expect(intents.canEdit(A, "A1")).toEqual({ ok: false, code: "INTENT_NOT_APPROVED" });
  });

  it("11b. re-approval when the blocking intent is cancelled or done", async () => {
    for (const release of ["cancelled", "done"] as const) {
      const { intents, briefings, sink } = setup();
      await intents.declare(A, "andrii", calc(), 1);
      await intents.declare(B, "boris", calc(), 1);
      briefings.takeUndelivered(B);
      sink.events.length = 0;

      intents.setStatus("A1", release, { rev: 7 });
      expect(intents.get("B1")?.status).toBe("approved");
      expect(intents.canEdit(B, "B1")).toEqual({ ok: true });
      expect(sink.ofType("intent_status")).toEqual([
        { type: "intent_status", intentId: "A1", status: release },
        { type: "intent_status", intentId: "B1", status: "approved" },
      ]);
      const toB = briefings.takeUndelivered(B);
      expect(toB).toHaveLength(1);
      expect(toB[0]).toMatchObject({ kind: "intent_conflict", requiresAck: false, details: { intentId: "B1" } });
      expect(toB[0]?.summary).toMatch(/approved now/);
      if (release === "done") expect(intents.get("A1")?.endRev).toBe(7);
    }
  });

  it("11b. stays in conflict while another blocking intent is active", async () => {
    // the LLM only flags boris's intent as contradicting
    const { intents, briefings, sink } = setup({ conflict: (user) => user.includes(`"agent": "${B}"`) && user.indexOf(`"agent": "${B}"`) < user.indexOf("existing_intents") });
    await intents.declare("agent-carl", "carl", tax(), 1); // C1 approved (nothing related yet)
    await intents.declare(A, "andrii", calc(), 1); // A1 approved (LLM says no)
    const b = await intents.declare(B, "boris", calc(), 2); // same_target A1 + contradiction C1
    expect(b.status).toBe("conflict");
    expect(b.conflicts.map((c) => `${c.intentId}:${c.kind}`).sort()).toEqual(["A1:same_target", "C1:contradiction"]);
    briefings.takeUndelivered(B);
    sink.events.length = 0;

    intents.setStatus("A1", "cancelled");
    expect(intents.get("B1")?.status).toBe("conflict");
    expect(briefings.takeUndelivered(B)).toEqual([]);
    expect(sink.ofType("intent_status")).toEqual([{ type: "intent_status", intentId: "A1", status: "cancelled" }]);

    // a contradiction is about promised behavior: C1 going done (its promise is now in the code) does not clear it
    intents.setStatus("C1", "done");
    expect(intents.get("B1")?.status).toBe("conflict");
    expect(briefings.takeUndelivered(B)).toEqual([]);
    // cancelling the contradicting intent (or a human resolving) does
    intents.setStatus("C1", "cancelled");
    expect(intents.get("B1")?.status).toBe("approved");
    expect(briefings.takeUndelivered(B).map((x) => [x.kind, x.requiresAck])).toEqual([["intent_conflict", false]]);
  });

  it("11b. resolveConflict briefs both owners and emits human_action", async () => {
    const { intents, briefings, sink } = setup();
    await intents.declare(A, "andrii", calc(), 1);
    await intents.declare(B, "boris", calc(), 1);
    briefings.takeUndelivered(A);
    briefings.takeUndelivered(B);
    sink.events.length = 0;

    intents.resolveConflict("andrii", "B1", "A1");
    expect(intents.get("A1")?.status).toBe("cancelled");
    expect(intents.get("B1")?.status).toBe("approved");
    expect(sink.ofType("human_action")).toEqual([{ type: "human_action", humanId: "andrii", action: "resolve_conflict", target: "B1>A1" }]);
    expect(sink.ofType("intent_status").map((e) => `${e.intentId}:${e.status}`)).toEqual(["A1:cancelled", "B1:approved"]);
    const toA = briefings.takeUndelivered(A);
    const toB = briefings.takeUndelivered(B);
    expect(toA).toHaveLength(1);
    expect(toA[0]).toMatchObject({ kind: "intent_conflict", requiresAck: false, fromHuman: "andrii" });
    expect(toA[0]?.summary).toContain("cancelled");
    expect(toB).toHaveLength(1);
    expect(toB[0]).toMatchObject({ kind: "intent_conflict", requiresAck: false });
    expect(toB[0]?.summary).toMatch(/approved now/);

    // keeping the already-approved one: cancel side cancelled, keep side gets an informational note
    const s2 = setup();
    await s2.intents.declare(A, "andrii", calc(), 1);
    await s2.intents.declare(B, "boris", calc(), 1);
    s2.briefings.takeUndelivered(A);
    s2.briefings.takeUndelivered(B);
    s2.intents.resolveConflict("boris", "A1", "B1");
    expect(s2.intents.get("A1")?.status).toBe("approved");
    expect(s2.intents.get("B1")?.status).toBe("cancelled");
    expect(s2.briefings.takeUndelivered(A).map((b) => b.requiresAck)).toEqual([false]);
    expect(s2.briefings.takeUndelivered(B).map((b) => b.requiresAck)).toEqual([false]);
    expect(() => s2.intents.resolveConflict("boris", "A1", "Z1")).toThrow(/unknown/);
  });

  it("11d. intent_status on every setStatus, nothing twice", async () => {
    const { intents, sink } = setup();
    await intents.declare(A, "andrii", calc(), 1);
    sink.events.length = 0;
    intents.setStatus("A1", "in_progress");
    intents.setStatus("A1", "done");
    intents.setStatus("A1", "verified");
    expect(sink.events).toEqual([
      { type: "intent_status", intentId: "A1", status: "in_progress" },
      { type: "intent_status", intentId: "A1", status: "done" },
      { type: "intent_status", intentId: "A1", status: "verified" },
    ]);
    expect(() => intents.setStatus("Q1", "done")).toThrow(/unknown/);
  });

  it("humanEditOutput: contract_changed to owner and dependents, human_action event", async () => {
    const { intents, reads, briefings, sink } = setup();
    reads.record(B, "src/checkout.ts", 1, ["calculateTotal"]);
    await intents.declare(A, "andrii", calc(), 2);
    briefings.takeUndelivered(B);
    sink.events.length = 0;

    intents.humanEditOutput("andrii", "A1", "returns subtotal minus discount, tax is NOT included");
    expect(intents.get("A1")?.output).toBe("returns subtotal minus discount, tax is NOT included");
    expect(sink.ofType("human_action")).toEqual([{ type: "human_action", humanId: "andrii", action: "edit_output", target: "A1" }]);
    expect(briefings.takeUndelivered(A)[0]).toMatchObject({ kind: "contract_changed", requiresAck: true, fromHuman: "andrii", details: { intentId: "A1" } });
    expect(briefings.takeUndelivered(B)[0]).toMatchObject({ kind: "contract_changed", requiresAck: true, details: { yourUsages: expect.any(Array) } });
    expect(() => intents.humanEditOutput("andrii", "A1", "short")).toThrow(/10..300/);
  });

  it("works with the real core ReadLog (structural ReadLogLike)", async () => {
    const reads = new ReadLog();
    const sink = eventSink();
    const graph = new CallGraph();
    graph.update({ "src/checkout.ts": CHECKOUT_TS });
    const briefings = new BriefingQueue({ onEvent: sink.onEvent });
    const intents = new IntentRegistry({ llm: new FakeLLM(() => ({ conflict: false })), graph, reads, briefings, onEvent: sink.onEvent, mode: "hive" });
    reads.record(B, "src/checkout.ts", 2, ["calculateTotal"]);
    reads.record(B, "src/checkout.ts", 4, ["calculateTotal"]);
    const r = await intents.declare(A, "andrii", calc(), 5);
    expect(r.dependents).toEqual([B]);
    expect(briefings.takeUndelivered(B)[0]?.kind).toBe("intent_declared");
  });

  it("15. naive and isolated modes approve everything, no briefings, no LLM", async () => {
    for (const mode of ["naive", "isolated"] as const) {
      const { intents, reads, briefings, llm, sink } = setup({ mode, conflict: true });
      reads.record(B, "src/checkout.ts", 1, ["calculateTotal"]);
      await intents.declare(B, "boris", tax(), 1);
      const a = await intents.declare(A, "andrii", calc(), 2);
      const a2 = await intents.declare(M, "masha", calc(), 2);
      expect([a.status, a2.status]).toEqual(["approved", "approved"]);
      expect(a.dependents).toEqual([]);
      expect(briefings.all()).toEqual([]);
      expect(llm.calls).toEqual([]);
      expect(sink.events.map((e) => e.type)).toEqual(["intent_declared", "intent_declared", "intent_declared"]);
      // vague output is still rejected
      await expect(intents.declare(A, "andrii", calc({ output: "it works now" }), 2)).rejects.toMatchObject({ code: "BAD_ARGS" });
      intents.humanEditOutput("andrii", a.intent.id, "returns subtotal without any discount or tax");
      expect(briefings.all()).toEqual([]);
    }
  });
});
