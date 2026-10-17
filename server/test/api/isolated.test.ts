import { afterEach, describe, expect, it } from "vitest";
import { makeHive, register, type TestHive } from "./helpers.js";

let t: TestHive;
afterEach(async () => {
  await t?.close();
});

describe("isolated mode", () => {
  it("14. two agents edit their own copies; /api/merge merges non-overlapping edits into main", async () => {
    t = await makeHive({ mode: "isolated" });
    register(t, "agent-andrii");
    register(t, "agent-masha");

    const a = await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(2) /* andrii */" });
    expect(a.ok).toBe(true);
    const m = await t.tool("agent-masha", "edit_region", { path: "src/tax.ts", oldText: "OR: 0 }", newText: "OR: 0, WA: 0.065 }" });
    expect(m.ok).toBe(true);

    // copies are private: masha does not see andrii's edit and the main store is untouched
    const mashaView = await t.tool("agent-masha", "read_file", { path: "src/format.ts" });
    expect(mashaView.data?.content).not.toContain("andrii");
    expect(t.hive.ctx.deps.store.rev).toBe(0);
    expect(a.rev).toBe(1);
    expect(m.rev).toBe(1);

    const hiveModeOnly = await t.hive.built.app.inject({ method: "POST", url: "/api/test", payload: {} });
    expect(hiveModeOnly.statusCode).toBe(200);

    const merged = await t.hive.built.app.inject({ method: "POST", url: "/api/merge" });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ ok: true, conflicts: [] });
    const main = t.hive.ctx.deps.store;
    expect(main.readFile("src/format.ts")?.content).toContain("/* andrii */");
    expect(main.readFile("src/tax.ts")?.content).toContain("WA: 0.065");
    expect(main.rev).toBe(2);
  });

  it("merge of overlapping edits to the same lines reports a conflict with markers", async () => {
    t = await makeHive({ mode: "isolated" });
    register(t, "agent-andrii");
    register(t, "agent-masha");
    await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: 'return "$" + (cents / 100).toFixed(2);', newText: 'return "$" + (cents / 100).toFixed(2) + " USD";' });
    await t.tool("agent-masha", "edit_region", { path: "src/format.ts", oldText: 'return "$" + (cents / 100).toFixed(2);', newText: 'return "USD " + (cents / 100).toFixed(2);' });
    const merged = await t.hive.built.app.inject({ method: "POST", url: "/api/merge" });
    const body = merged.json();
    expect(body.ok).toBe(false);
    expect(body.conflicts).toEqual([{ path: "src/format.ts" }]);
    const content = t.hive.ctx.deps.store.readFile("src/format.ts")?.content ?? "";
    expect(content).toContain("<<<<<<< main");
    expect(content).toContain(">>>>>>> agent-masha");
  });

  it("merge is rejected outside isolated mode", async () => {
    t = await makeHive({ mode: "naive" });
    const res = await t.hive.built.app.inject({ method: "POST", url: "/api/merge" });
    expect(res.statusCode).toBe(400);
  });
});
