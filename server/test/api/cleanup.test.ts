import { afterEach, describe, expect, it } from "vitest";
import { GOOD_INTENT, makeHive, register, type TestHive, waitFor } from "./helpers.js";
import type { FakeTestOrchestrator } from "../../src/api/fakes.js";
import type { AgentRunResult } from "../../src/agents/AgentManager.js";

let t: TestHive;
afterEach(async () => {
  await t?.close();
});

describe("open intents are closed when an agent run ends", () => {
  it("in_progress -> done (+ orchestrator), approved/conflict without edits -> cancelled, dependents re-approved", async () => {
    let endRun: ((r: AgentRunResult) => void) | undefined;
    t = await makeHive({
      runAgent: async (opts) => {
        // A1: declared and edited (in_progress); A2: declared, never edited (approved)
        const a1 = await opts.client.call("declare_intent", GOOD_INTENT);
        await opts.client.call("edit_region", {
          intentId: a1.data!.intent.id,
          path: "src/checkout.ts",
          oldText: "return applyDiscount(subtotal(items), promo);",
          newText: "return Math.round(applyDiscount(subtotal(items), promo));",
        });
        await opts.client.call("declare_intent", { ...GOOD_INTENT, target: { file: "src/format.ts", symbol: "formatPrice" }, what: "format negatives with a minus", output: "returns -$1.00 for -100 cents" });
        return new Promise<AgentRunResult>((resolve) => {
          endRun = resolve;
        });
      },
    });
    await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-andrii", humanId: "andrii", task: "tax" } });
    await waitFor(() => t.hive.ctx.deps.intents.list().length === 2);
    expect(t.hive.ctx.deps.intents.get("A1")?.status).toBe("in_progress");
    expect(t.hive.ctx.deps.intents.get("A2")?.status).toBe("approved");

    // masha wants the same symbols: both of her intents are blocked by andrii's
    register(t, "agent-masha");
    const m1 = await t.tool("agent-masha", "declare_intent", { ...GOOD_INTENT, what: "round calculateTotal to cents", output: "returns the discounted subtotal rounded to integer cents" });
    const m2 = await t.tool("agent-masha", "declare_intent", { ...GOOD_INTENT, target: { file: "src/format.ts", symbol: "formatPrice" }, what: "format with thousands separator", output: "returns $1,000.00 for 100000 cents" });
    expect(m1.data?.status).toBe("conflict");
    expect(m2.data?.status).toBe("conflict");

    // andrii's run ends without finish_intent
    endRun!({ status: "budget", toolCalls: 3, tokensIn: 0, tokensOut: 0, ms: 1 });
    await waitFor(() => t.hive.agents.get("agent-andrii")?.status === "budget");

    const intents = t.hive.ctx.deps.intents;
    expect(["done", "verified"]).toContain(intents.get("A1")?.status);
    expect(intents.get("A2")?.status).toBe("cancelled");
    const orchestrator = t.hive.ctx.deps.orchestrator as FakeTestOrchestrator;
    expect(orchestrator.finished).toEqual(["A1"]);
    await waitFor(() => intents.get("A1")?.status === "verified");
    expect(t.hive.ctx.deps.history.changeSets().map((c) => c.id)).toEqual(["A1"]);

    // masha's intents were re-approved by the registry and she was told
    expect(intents.get(m1.data!.intent.id)?.status).toBe("approved");
    expect(intents.get(m2.data!.intent.id)?.status).toBe("approved");
    const next = await t.tool("agent-masha", "list_files", {});
    expect(next.briefings.filter((b) => b.kind === "intent_conflict" && !b.requiresAck).length).toBeGreaterThanOrEqual(2);
    const edit = await t.tool("agent-masha", "edit_region", { intentId: m2.data!.intent.id, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(2) /* m */" });
    expect(["UNACKED_BRIEFINGS", undefined]).toContain(edit.error?.code); // only the earlier requiresAck conflict briefings can still block
    const statusEvents = t.events("intent_status").map((e) => (e.type === "intent_status" ? `${e.intentId}:${e.status}` : ""));
    expect(statusEvents).toContain("A1:done");
    expect(statusEvents).toContain("A2:cancelled");
  });

  it("stop while an intent is in_progress finishes it, for every agent", async () => {
    t = await makeHive({
      runAgent: async (opts) => {
        const a1 = await opts.client.call("declare_intent", GOOD_INTENT);
        await opts.client.call("edit_region", { intentId: a1.data!.intent.id, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
        return new Promise<AgentRunResult>((resolve) => {
          opts.signal!.addEventListener("abort", () => resolve({ status: "stopped", toolCalls: 2, tokensIn: 0, tokensOut: 0, ms: 1 }), { once: true });
        });
      },
    });
    await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-andrii", humanId: "andrii", task: "x" } });
    await waitFor(() => t.hive.ctx.deps.intents.get("A1")?.status === "in_progress");
    await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-andrii/control", payload: { humanId: "andrii", control: "stop" } });
    await waitFor(() => t.hive.agents.get("agent-andrii")?.status === "stopped");
    await waitFor(() => t.hive.ctx.deps.intents.get("A1")?.status === "verified");
    expect(t.hive.ctx.deps.history.lastGreen()?.rev).toBe(1);

    await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-zed", humanId: "zed", task: "nothing" } });
    await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-zed/control", payload: { humanId: "zed", control: "stop" } });
    await waitFor(() => t.hive.agents.get("agent-zed")?.status === "stopped");
    // zed's edit misses (andrii already changed that line), so Z1 has no edits and is cancelled, not finished
    expect(t.hive.ctx.deps.intents.get("Z1")?.status).toBe("cancelled");
    expect(t.hive.ctx.deps.history.changeSets().map((c) => c.id)).toEqual(["A1"]);
  });

  it("POST /api/test green without extraFiles saves a green snapshot; with extraFiles or red it does not", async () => {
    t = await makeHive({ mode: "naive" });
    register(t, "agent-andrii");
    await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    expect(t.hive.ctx.deps.history.lastGreen()?.rev).toBe(0);
    await t.hive.built.app.inject({ method: "POST", url: "/api/test", payload: { extraFiles: { "test/x.test.ts": "// x" } } });
    expect(t.hive.ctx.deps.history.lastGreen()?.rev).toBe(0);
    await t.hive.built.app.inject({ method: "POST", url: "/api/test", payload: {} });
    expect(t.hive.ctx.deps.history.lastGreen()?.rev).toBe(1);
    await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(3)", newText: "toFixed(4)" });
    t.runner.result = { ok: false, passed: 0, failed: 1, failures: [{ name: "f", message: "m" }], durationMs: 1 };
    await t.hive.built.app.inject({ method: "POST", url: "/api/test", payload: {} });
    expect(t.hive.ctx.deps.history.lastGreen()?.rev).toBe(1);
    expect(t.events("intent_status")).toHaveLength(0);
  });
});
