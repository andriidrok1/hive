import { afterEach, describe, expect, it } from "vitest";
import { createPatch } from "diff";
import type { ChangeSet, IntentId } from "@hive/shared";
import { applyEdits } from "../../src/core/index.js";
import type { HistoryLike } from "../../src/api/deps.js";
import type { RunTestsData } from "../../src/api/tools.js";
import { GOOD_INTENT, makeHive, register, type TestHive, waitFor } from "./helpers.js";

let t: TestHive;
afterEach(async () => {
  await t?.close();
});

/**
 * Until core ships History.openEdits/buildView, give the real History instance an equivalent pair
 * built from store.onChange. Once the real methods exist this does nothing and they are tested instead.
 */
function ensureViewApi(t: TestHive): void {
  const h = t.hive.ctx.deps.history as HistoryLike;
  if (h.openEdits && h.buildView) return;
  const open = new Map<IntentId, ChangeSet["edits"]>();
  t.hive.ctx.deps.store.onChange((c) => {
    if (!c.intentId) return;
    const list = open.get(c.intentId) ?? [];
    list.push({ path: c.path, patch: createPatch(c.path, c.before, c.after, "", "", { context: 3 }) });
    open.set(c.intentId, list);
  });
  h.openEdits = (id) => open.get(id) ?? [];
  h.buildView = (base, sets, extra = []) => {
    let files = { ...base };
    for (const s of sets) {
      const r = applyEdits(files, s.edits);
      if (!r.ok) return { ok: false, path: r.path, index: r.index, setId: s.id };
      files = r.files;
    }
    const r = applyEdits(files, extra);
    if (!r.ok) return { ok: false, path: r.path, index: r.index };
    return { ok: true, files: r.files };
  };
}

const lastRun = (t: TestHive) => t.runner.testCalls[t.runner.testCalls.length - 1]!;

describe("run_tests judges an agent on its own view", () => {
  it("includes finished sets and own open edits, excludes another agent's in-progress edit, and says so", async () => {
    t = await makeHive();
    ensureViewApi(t);
    register(t, "agent-andrii");
    register(t, "agent-masha");

    // A1: finished but red, so lastGreen stays at rev 0 and A1 is a finished change set since green
    t.runner.result = { ok: false, passed: 0, failed: 1, failures: [{ name: "x", message: "red" }], durationMs: 1 };
    const a1 = await t.tool("agent-andrii", "declare_intent", GOOD_INTENT);
    await t.tool("agent-andrii", "edit_region", { intentId: a1.data!.intent.id, path: "src/checkout.ts", oldText: "return applyDiscount(subtotal(items), promo);", newText: "return Math.round(applyDiscount(subtotal(items), promo));" });
    await t.tool("agent-andrii", "finish_intent", { intentId: a1.data!.intent.id });
    await waitFor(() => t.hive.ctx.deps.intents.get("A1")?.status === "failed");
    t.runner.result = { ok: true, passed: 1, failed: 0, failures: [], durationMs: 1 };

    // A2: andrii's in-progress edit on tax.ts; M1: masha's in-progress edit on format.ts
    const a2 = await t.tool("agent-andrii", "declare_intent", { ...GOOD_INTENT, target: { file: "src/tax.ts", symbol: "TAX_RATES" }, what: "add WA tax rate", output: "TAX_RATES has WA: 0.065, other states unchanged" });
    await t.tool("agent-andrii", "edit_region", { intentId: a2.data!.intent.id, path: "src/tax.ts", oldText: "OR: 0 }", newText: "OR: 0, WA: 0.065 }" });
    const m1 = await t.tool("agent-masha", "declare_intent", { ...GOOD_INTENT, target: { file: "src/format.ts", symbol: "formatPrice" }, what: "format negatives with a minus", output: "returns -$1.00 for -100 cents" });
    await t.tool("agent-masha", "edit_region", { intentId: m1.data!.intent.id, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(2) /* m */" });
    expect(t.hive.ctx.deps.store.rev).toBe(3);

    const masha = await t.tool("agent-masha", "run_tests", {});
    expect(masha.ok).toBe(true);
    const md = masha.data as RunTestsData;
    expect(md.passed).toBe(1);
    expect(md.view).toEqual({ finishedSets: ["A1"], ownOpenIntents: ["M1"], excludedInProgress: [{ intentId: "A2", agentId: "agent-andrii", files: ["src/tax.ts"] }] });
    expect(md.note).toBe("Ran on your view: green rev 0 + finished A1 + your open M1. Excluded in-progress edits of agent-andrii (A2: src/tax.ts).");
    const mashaFiles = lastRun(t).files;
    expect(mashaFiles["src/checkout.ts"]).toContain("Math.round("); // finished A1
    expect(mashaFiles["src/format.ts"]).toContain("/* m */"); // own open M1
    expect(mashaFiles["src/tax.ts"]).not.toContain("WA"); // andrii's in-progress A2 excluded
    expect(mashaFiles["test/checkout.test.ts"]).toBeDefined();

    const andrii = await t.tool("agent-andrii", "run_tests", { filter: "checkout" });
    const ad = andrii.data as RunTestsData;
    expect(ad.view).toEqual({ finishedSets: ["A1"], ownOpenIntents: ["A2"], excludedInProgress: [{ intentId: "M1", agentId: "agent-masha", files: ["src/format.ts"] }] });
    const andriiFiles = lastRun(t).files;
    expect(andriiFiles["src/tax.ts"]).toContain("WA: 0.065");
    expect(andriiFiles["src/format.ts"]).not.toContain("/* m */");
    expect(lastRun(t).opts?.filter).toBe("checkout");
    expect(t.events("test_run_started").map((e) => (e.type === "test_run_started" ? e.reason : "")).filter((r) => r.includes("own view"))).toHaveLength(2);

    // the live store, the final judge, still has everything
    const live = await t.hive.built.app.inject({ method: "POST", url: "/api/test", payload: {} });
    expect(live.statusCode).toBe(200);
    expect(lastRun(t).files["src/tax.ts"]).toContain("WA: 0.065");
    expect(lastRun(t).files["src/format.ts"]).toContain("/* m */");
  });

  it("an agent with nothing open gets the green base plus finished sets; naive mode runs on the live project", async () => {
    t = await makeHive();
    ensureViewApi(t);
    register(t, "agent-andrii");
    register(t, "agent-masha");
    const m1 = await t.tool("agent-masha", "declare_intent", { ...GOOD_INTENT, target: { file: "src/format.ts", symbol: "formatPrice" }, what: "format negatives with a minus", output: "returns -$1.00 for -100 cents" });
    await t.tool("agent-masha", "edit_region", { intentId: m1.data!.intent.id, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(2) /* m */" });
    const res = await t.tool("agent-andrii", "run_tests", {});
    const d = res.data as RunTestsData;
    expect(d.view?.ownOpenIntents).toEqual([]);
    expect(d.view?.excludedInProgress).toEqual([{ intentId: "M1", agentId: "agent-masha", files: ["src/format.ts"] }]);
    expect(d.note).toContain("no open edits of yours");
    expect(lastRun(t).files["src/format.ts"]).not.toContain("/* m */");
    await t.close();

    t = await makeHive({ mode: "naive" });
    register(t, "agent-andrii");
    register(t, "agent-masha");
    await t.tool("agent-masha", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(2) /* m */" });
    const naive = await t.tool("agent-andrii", "run_tests", {});
    const nd = naive.data as RunTestsData;
    expect(nd.view).toBeUndefined();
    expect(nd.note).toBe("Ran on the live shared project.");
    expect(lastRun(t).files["src/format.ts"]).toContain("/* m */");
  });

  it("falls back to the live store with an explanatory note when the view cannot be built", async () => {
    t = await makeHive();
    ensureViewApi(t);
    register(t, "agent-andrii");
    const h = t.hive.ctx.deps.history as HistoryLike;
    h.buildView = () => ({ ok: false, path: "src/checkout.ts", index: 0, setId: "A1" });
    const a1 = await t.tool("agent-andrii", "declare_intent", GOOD_INTENT);
    await t.tool("agent-andrii", "edit_region", { intentId: a1.data!.intent.id, path: "src/checkout.ts", oldText: "return applyDiscount(subtotal(items), promo);", newText: "return Math.round(applyDiscount(subtotal(items), promo));" });
    const res = await t.tool("agent-andrii", "run_tests", {});
    expect(res.ok).toBe(true);
    const d = res.data as RunTestsData;
    expect(d.note).toContain("Could not build your view (patch of A1 did not apply at src/checkout.ts#0)");
    expect(d.note).toContain("ran on the live shared project instead");
    expect(d.view?.ownOpenIntents).toEqual(["A1"]);
    expect(lastRun(t).files["src/checkout.ts"]).toContain("Math.round(");
  });
});
