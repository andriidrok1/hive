import { afterEach, describe, expect, it } from "vitest";
import { GOOD_INTENT, makeHive, register, type TestHive } from "./helpers.js";

let t: TestHive;
afterEach(async () => {
  await t?.close();
});

const FORMAT_INTENT = { ...GOOD_INTENT, target: { file: "src/format.ts", symbol: "formatPrice" }, what: "format negatives with a minus", output: "returns -$1.00 for -100 cents" };

describe("ownership zones", () => {
  it("declare/edit/create outside owns -> NOT_OWNER naming the owner; inside -> ok; state returns owns", async () => {
    t = await makeHive();
    const app = t.hive.built.app;
    const a = await app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-andrii", humanId: "andrii", task: "checkout", owns: ["src/checkout.ts", "test/"] } });
    expect(a.statusCode).toBe(200);
    const m = await app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-masha", humanId: "masha", task: "format", owns: ["./src/format.ts"] } });
    expect(m.statusCode).toBe(200);

    const state = (await app.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.agents.find((x: { agentId: string }) => x.agentId === "agent-andrii").owns).toEqual(["src/checkout.ts", "test/"]);
    expect(state.agents.find((x: { agentId: string }) => x.agentId === "agent-masha").owns).toEqual(["src/format.ts"]);

    // andrii declaring on masha's file
    const denied = await t.tool("agent-andrii", "declare_intent", FORMAT_INTENT);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("NOT_OWNER");
    expect(denied.error?.message).toBe("src/format.ts is owned by agent-masha (masha). Do not edit it; use ask_agent to tell the owner what you need.");
    expect(t.hive.ctx.deps.intents.list()).toHaveLength(0);

    // inside own zone everything works, including a prefix match and a create under it
    const mine = await t.tool("agent-andrii", "declare_intent", GOOD_INTENT);
    expect(mine.ok).toBe(true);
    const edit = await t.tool("agent-andrii", "edit_region", { intentId: mine.data!.intent.id, path: "src/checkout.ts", oldText: "return applyDiscount(subtotal(items), promo);", newText: "return Math.round(applyDiscount(subtotal(items), promo));" });
    expect(edit.ok).toBe(true);
    const created = await t.tool("agent-andrii", "create_file", { intentId: mine.data!.intent.id, path: "test/extra.test.ts", content: "// ok\n" });
    expect(created.ok).toBe(true);

    // edits and creates outside the zone are refused even with an approved intent; nobody owns src/tax.ts
    const editOut = await t.tool("agent-andrii", "edit_region", { intentId: mine.data!.intent.id, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    expect(editOut.error?.code).toBe("NOT_OWNER");
    expect(editOut.error?.message).toContain("is owned by agent-masha (masha)");
    const createOut = await t.tool("agent-andrii", "create_file", { intentId: mine.data!.intent.id, path: "src/tax2.ts", content: "x" });
    expect(createOut.error?.code).toBe("NOT_OWNER");
    expect(createOut.error?.message).toBe("src/tax2.ts is outside your files. Do not edit it; use ask_agent to tell the owner what you need.");
    expect(t.hive.ctx.deps.store.readFile("src/format.ts")?.content).toContain("toFixed(2)");

    // reading, testing and asking stay open
    expect((await t.tool("agent-andrii", "read_file", { path: "src/format.ts" })).ok).toBe(true);
    expect((await t.tool("agent-andrii", "run_tests", {})).ok).toBe(true);
    expect((await t.tool("agent-andrii", "ask_agent", { to: "agent-masha", about: "formatPrice", question: "can you accept negative cents?" })).ok).toBe(true);

    // list_files merges static owners with intent-based owners
    const files = (await t.tool("agent-andrii", "list_files", {})).data!.files as { path: string; owners?: string[]; activeIntents?: unknown[] }[];
    expect(files.find((f) => f.path === "src/format.ts")?.owners).toEqual(["masha"]);
    expect(files.find((f) => f.path === "src/checkout.ts")?.owners).toEqual(["andrii"]);
    expect(files.find((f) => f.path === "test/checkout.test.ts")?.owners).toEqual(["andrii"]);
    expect(files.find((f) => f.path === "src/tax.ts")?.owners).toBeUndefined();
  });

  it("agents without owns are unrestricted", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const m = await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-masha", humanId: "masha", task: "format", owns: ["src/format.ts"] } });
    expect(m.statusCode).toBe(200);
    const declared = await t.tool("agent-andrii", "declare_intent", FORMAT_INTENT);
    expect(declared.ok).toBe(true);
    const edit = await t.tool("agent-andrii", "edit_region", { intentId: declared.data!.intent.id, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    expect(edit.ok).toBe(true);
    const state = (await t.hive.built.app.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.agents.find((x: { agentId: string }) => x.agentId === "agent-andrii").owns).toBeUndefined();
    const bad = await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-x", humanId: "x", task: "t", owns: "src/" } });
    expect(bad.statusCode).toBe(400);
  });
});
