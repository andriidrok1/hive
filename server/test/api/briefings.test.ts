import { afterEach, describe, expect, it } from "vitest";
import { GOOD_INTENT, makeHive, register, type TestHive } from "./helpers.js";

let t: TestHive;
afterEach(async () => {
  await t?.close();
});

describe("api: briefings ride on tool responses", () => {
  it("6. a dependent agent gets the intent_declared briefing on its next tool call, exactly once", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    register(t, "agent-masha");
    // masha read calculateTotal, so she depends on it
    await t.tool("agent-masha", "read_file", { path: "src/checkout.ts" });
    const declared = await t.tool("agent-andrii", "declare_intent", GOOD_INTENT);
    expect(declared.ok).toBe(true);
    expect(declared.data?.dependents).toEqual(["agent-masha"]);
    // andrii's own response carries no briefing about his own intent
    expect(declared.briefings).toEqual([]);

    const first = await t.tool("agent-masha", "list_files", {});
    expect(first.briefings).toHaveLength(1);
    expect(first.briefings[0]).toMatchObject({ kind: "intent_declared", toAgent: "agent-masha", fromAgent: "agent-andrii", requiresAck: true });
    expect(first.briefings[0]?.details.intentId).toBe(declared.data?.intent.id);

    const second = await t.tool("agent-masha", "list_files", {});
    expect(second.briefings).toEqual([]);
    expect(t.events("briefing_sent")).toHaveLength(1);
  });

  it("7. UNACKED_BRIEFINGS blocks edits until ack_briefing", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    register(t, "agent-masha");
    await t.tool("agent-masha", "read_file", { path: "src/checkout.ts" });
    await t.tool("agent-andrii", "declare_intent", GOOD_INTENT);

    const mine = await t.tool("agent-masha", "declare_intent", {
      ...GOOD_INTENT,
      target: { file: "src/format.ts", symbol: "formatPrice" },
      what: "format negative prices with a leading minus",
      output: "returns -$1.00 for -100 cents and $1.00 for 100 cents",
    });
    expect(mine.ok).toBe(true);
    const intentId = mine.data!.intent.id;
    const briefingId = mine.briefings[0]?.id ?? (await t.tool("agent-masha", "list_files", {})).briefings[0]?.id;
    expect(briefingId).toBeDefined();

    const blocked = await t.tool("agent-masha", "edit_region", { intentId, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(2) /* neg */" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe("UNACKED_BRIEFINGS");
    expect(blocked.error?.message).toContain(briefingId!);

    const wrongAgent = await t.tool("agent-andrii", "ack_briefing", { briefingId: briefingId!, response: "adapted" });
    expect(wrongAgent.error?.code).toBe("NOT_FOUND");

    const acked = await t.tool("agent-masha", "ack_briefing", { briefingId: briefingId!, response: "not_relevant", note: "I only touch formatting" });
    expect(acked.ok).toBe(true);
    expect(t.events("briefing_acked")).toHaveLength(1);

    const allowed = await t.tool("agent-masha", "edit_region", { intentId, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(2) /* neg */" });
    expect(allowed.ok).toBe(true);
  });

  it("10. POST /api/intents/:id/output sends contract_changed to the owner and dependents", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    register(t, "agent-masha");
    await t.tool("agent-masha", "read_file", { path: "src/checkout.ts" });
    const declared = await t.tool("agent-andrii", "declare_intent", GOOD_INTENT);
    const id = declared.data!.intent.id;
    await t.tool("agent-masha", "list_files", {}); // drains the intent_declared briefing

    const res = await t.hive.built.app.inject({
      method: "POST",
      url: `/api/intents/${id}/output`,
      payload: { humanId: "andrii", output: "returns subtotal minus discount; tax stays in applyTax" },
    });
    expect(res.statusCode).toBe(200);
    expect(t.hive.ctx.deps.intents.get(id)?.output).toContain("tax stays in applyTax");

    const masha = await t.tool("agent-masha", "list_files", {});
    expect(masha.briefings.map((b) => b.kind)).toEqual(["contract_changed"]);
    const andrii = await t.tool("agent-andrii", "list_files", {});
    expect(andrii.briefings.map((b) => b.kind)).toEqual(["contract_changed"]);
    expect(t.events("human_action").length).toBeGreaterThanOrEqual(1);

    const missing = await t.hive.built.app.inject({ method: "POST", url: "/api/intents/Z9/output", payload: { humanId: "andrii", output: "whatever this is long enough" } });
    expect(missing.statusCode).toBe(404);
  });

  it("same-target conflict: second intent is conflict, resolve via /api/intents/resolve", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    register(t, "agent-masha");
    const a = await t.tool("agent-andrii", "declare_intent", GOOD_INTENT);
    const m = await t.tool("agent-masha", "declare_intent", { ...GOOD_INTENT, what: "round calculateTotal to whole cents", output: "returns the discounted subtotal rounded to integer cents" });
    expect(m.data?.status).toBe("conflict");
    expect(m.data?.conflicts[0]?.kind).toBe("same_target");
    const blocked = await t.tool("agent-masha", "edit_region", { intentId: m.data!.intent.id, path: "src/checkout.ts", oldText: "applyDiscount(subtotal(items), promo)", newText: "x" });
    expect(["INTENT_NOT_APPROVED", "UNACKED_BRIEFINGS"]).toContain(blocked.error?.code);

    const res = await t.hive.built.app.inject({ method: "POST", url: "/api/intents/resolve", payload: { humanId: "andrii", keep: m.data!.intent.id, cancel: a.data!.intent.id } });
    expect(res.statusCode).toBe(200);
    expect(t.hive.ctx.deps.intents.get(a.data!.intent.id)?.status).toBe("cancelled");
    expect(t.hive.ctx.deps.intents.get(m.data!.intent.id)?.status).toBe("approved");
  });

  it("ask_agent / reply deliver message briefings; the 4th exchange hits EXCHANGE_LIMIT", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    register(t, "agent-masha");
    const ask = await t.tool("agent-andrii", "ask_agent", { to: "agent-masha", about: "calculateTotal", question: "will you include tax?" });
    expect(ask.ok).toBe(true);
    const mashaSees = await t.tool("agent-masha", "list_files", {});
    expect(mashaSees.briefings.map((b) => b.kind)).toEqual(["message"]);
    let last = ask.data!.messageId;
    let from = "agent-masha";
    let other = "agent-andrii";
    const results: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.tool(from, "reply", { messageId: last, text: `reply ${i + 1}` });
      results.push(r.ok);
      if (r.ok) last = r.data!.messageId;
      [from, other] = [other, from];
    }
    expect(results.filter(Boolean).length).toBeLessThan(3);
    const limited = results.indexOf(false);
    expect(limited).toBeGreaterThanOrEqual(0);
    expect(t.hive.ctx.deps.mailbox.forHumans().length).toBeGreaterThanOrEqual(1);
    const unknown = await t.tool("agent-andrii", "ask_agent", { to: "agent-ghost", about: "x", question: "y" });
    expect(unknown.error?.code).toBe("NOT_FOUND");
  });

  it("POST /api/agents/:id/note pushes a human_note briefing", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const res = await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-andrii/note", payload: { humanId: "andrii", text: "leave tax.ts alone", urgent: true } });
    expect(res.statusCode).toBe(200);
    const next = await t.tool("agent-andrii", "list_files", {});
    expect(next.briefings[0]).toMatchObject({ kind: "human_note", fromHuman: "andrii", summary: "leave tax.ts alone", requiresAck: true });
  });
});
