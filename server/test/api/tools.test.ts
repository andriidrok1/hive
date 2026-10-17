import { afterEach, describe, expect, it } from "vitest";
import type { TestResult } from "@hive/shared";
import { GOOD_INTENT, makeHive, register, type TestHive, waitFor } from "./helpers.js";

let t: TestHive;
afterEach(async () => {
  await t?.close();
});

describe("api: state and tool envelope", () => {
  it("1. GET /api/state on a fresh hive returns fixture files at rev 0", async () => {
    t = await makeHive();
    const res = await t.hive.built.app.inject({ method: "GET", url: "/api/state" });
    expect(res.statusCode).toBe(200);
    const state = res.json();
    expect(state.mode).toBe("hive");
    expect(state.rev).toBe(0);
    expect(state.files.map((f: { path: string }) => f.path)).toContain("src/checkout.ts");
    expect(state.files.every((f: { rev: number }) => f.rev === 0)).toBe(true);
    expect(state.lastGreen).toEqual({ rev: 0, at: expect.any(Number) });
    expect(state.intents).toEqual([]);
    expect(state.agents).toEqual([]);
  });

  it("2. read_file returns the envelope: ok, data.content, briefings [], control run, rev", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const res = await t.tool("agent-andrii", "read_file", { path: "src/checkout.ts" });
    expect(res.ok).toBe(true);
    expect(res.data?.content).toContain("export function calculateTotal");
    expect(res.briefings).toEqual([]);
    expect(res.control).toBe("run");
    expect(res.rev).toBe(0);
  });

  it("unknown agent -> 404, unknown tool and bad args -> ok:false", async () => {
    t = await makeHive();
    const r404 = await t.hive.built.app.inject({ method: "POST", url: "/api/agents/nobody/tools/list_files", payload: {} });
    expect(r404.statusCode).toBe(404);
    register(t, "agent-andrii");
    const bad = await t.tool("agent-andrii", "read_file", { nope: 1 });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("BAD_ARGS");
    expect(bad.briefings).toEqual([]);
    const unknownTool = await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-andrii/tools/explode", payload: {} });
    expect(unknownTool.statusCode).toBe(200);
    expect(unknownTool.json().error.code).toBe("BAD_ARGS");
  });

  it("3. read_file records the read with the symbols in range", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const whole = await t.tool("agent-andrii", "read_file", { path: "src/checkout.ts" });
    expect(whole.data?.symbols.map((s) => s.name)).toEqual(["subtotal", "calculateTotal"]);
    const part = await t.tool("agent-andrii", "read_file", { path: "src/checkout.ts", startLine: 8, endLine: 10 });
    expect(part.data?.symbols.map((s) => s.name)).toEqual(["calculateTotal"]);
    expect(part.data?.content.split("\n")).toHaveLength(3);
    const readers = t.hive.ctx.deps.reads.readersOf("src/checkout.ts", "calculateTotal");
    expect(readers).toEqual([{ agentId: "agent-andrii", rev: 0 }]);
    expect(t.hive.ctx.deps.reads.readsOf("agent-andrii").length).toBeGreaterThanOrEqual(1);
    expect(t.events("file_read")).toHaveLength(2);
  });

  it("4. edit_region without intent: NO_INTENT in hive mode, ok in naive mode", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const denied = await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("NO_INTENT");
    await t.close();

    t = await makeHive({ mode: "naive" });
    register(t, "agent-andrii");
    const ok = await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    expect(ok.ok).toBe(true);
    expect(ok.data?.rev).toBe(1);
    expect(t.hive.ctx.deps.store.readFile("src/format.ts")?.content).toContain("toFixed(3)");
  });

  it("5. happy path: declare_intent -> edit_region -> finish_intent with feed events", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const declared = await t.tool("agent-andrii", "declare_intent", GOOD_INTENT);
    expect(declared.ok).toBe(true);
    expect(declared.data?.status).toBe("approved");
    const id = declared.data!.intent.id;
    expect(id).toBe("A1");

    const edited = await t.tool("agent-andrii", "edit_region", {
      intentId: id,
      path: "src/checkout.ts",
      oldText: "return applyDiscount(subtotal(items), promo);",
      newText: "return Math.round(applyDiscount(subtotal(items), promo) * 1.0725);",
    });
    expect(edited.ok).toBe(true);
    expect(edited.data?.rev).toBe(1);
    expect(t.hive.ctx.deps.intents.get(id)?.status).toBe("in_progress");

    const finished = await t.tool("agent-andrii", "finish_intent", { intentId: id });
    expect(finished.ok).toBe(true);
    expect(["done", "verified"]).toContain(finished.data?.intent.status);
    await waitFor(() => t.hive.ctx.deps.intents.get(id)?.status === "verified");

    const types = t.events().map((e) => e.type);
    expect(types).toContain("intent_declared");
    expect(types).toContain("edit_applied");
    expect(types).toContain("intent_status");
    const statuses = t.events("intent_status").map((e) => (e.type === "intent_status" ? e.status : ""));
    expect(statuses).toEqual(["in_progress", "done", "verified"]);
    expect(t.events("edit_applied")).toHaveLength(1);
    const cs = t.hive.ctx.deps.history.changeSets();
    expect(cs).toHaveLength(1);
    expect(cs[0]?.id).toBe(id);
    expect(cs[0]?.edits).toHaveLength(1);
    const state = (await t.hive.built.app.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.history).toHaveLength(1);
    expect(state.intents[0].status).toBe("verified");
  });

  it("8. OLD_TEXT_NOT_FOUND returns fresh content in error.current", async () => {
    t = await makeHive({ mode: "naive" });
    register(t, "agent-andrii");
    await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    const res = await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(4)" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("OLD_TEXT_NOT_FOUND");
    expect(res.error?.current).toContain("toFixed(3)");
    const amb = await t.tool("agent-andrii", "edit_region", { path: "src/checkout.ts", oldText: "items", newText: "x" });
    expect(amb.error?.code).toBe("OLD_TEXT_AMBIGUOUS");
  });

  it("9. POST /api/agents/:id/control pause -> next tool response has control pause", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const res = await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-andrii/control", payload: { humanId: "andrii", control: "pause" } });
    expect(res.statusCode).toBe(200);
    const tool = await t.tool("agent-andrii", "list_files", {});
    expect(tool.control).toBe("pause");
    await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-andrii/control", payload: { humanId: "andrii", control: "run" } });
    expect((await t.tool("agent-andrii", "list_files", {})).control).toBe("run");
    const missing = await t.hive.built.app.inject({ method: "POST", url: "/api/agents/ghost/control", payload: { humanId: "andrii", control: "pause" } });
    expect(missing.statusCode).toBe(404);
  });

  it("13. POST /api/reset restores initial files and clears intents", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const declared = await t.tool("agent-andrii", "declare_intent", GOOD_INTENT);
    await t.tool("agent-andrii", "edit_region", { intentId: declared.data!.intent.id, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    expect(t.hive.ctx.deps.store.rev).toBe(1);
    const res = await t.hive.built.app.inject({ method: "POST", url: "/api/reset", payload: { mode: "naive" } });
    expect(res.statusCode).toBe(200);
    const state = (await t.hive.built.app.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.mode).toBe("naive");
    expect(state.rev).toBe(0);
    expect(state.intents).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.recentEvents).toEqual([]);
    expect(t.hive.ctx.deps.store.readFile("src/format.ts")?.content).toContain("toFixed(2)");
    const r404 = await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-andrii/tools/list_files", payload: {} });
    expect(r404.statusCode).toBe(404);
  });

  it("16. POST /api/test passes extraFiles to the runner and returns its result", async () => {
    t = await makeHive();
    t.runner.result = { ok: false, passed: 3, failed: 1, failures: [{ name: "s01", message: "expected 1 got 2" }], durationMs: 5 };
    const res = await t.hive.built.app.inject({ method: "POST", url: "/api/test", payload: { extraFiles: { "test/s01.accept.test.ts": "// accept" }, filter: "s01" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, passed: 3, failed: 1 });
    expect(t.runner.testCalls).toHaveLength(1);
    expect(t.runner.testCalls[0]?.files["test/s01.accept.test.ts"]).toBe("// accept");
    expect(t.runner.testCalls[0]?.files["src/checkout.ts"]).toBeDefined();
    expect(t.runner.testCalls[0]?.opts?.filter).toBe("s01");
    expect(t.events("test_run_started")).toHaveLength(1);
    expect(t.events("test_run_finished")).toHaveLength(1);
  });

  it("17. GET /api/files/src%2Fcheckout.ts returns content, rev and symbols", async () => {
    t = await makeHive();
    for (const url of ["/api/files/src%2Fcheckout.ts", "/api/files/src/checkout.ts"]) {
      const res = await t.hive.built.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rev).toBe(0);
      expect(body.content).toContain("calculateTotal");
      expect(body.symbols.map((s: { name: string }) => s.name)).toEqual(["subtotal", "calculateTotal"]);
    }
    expect((await t.hive.built.app.inject({ method: "GET", url: "/api/files/src/nope.ts" })).statusCode).toBe(404);
  });

  it("run_tests and run_command go through the runner with a snapshot of the files", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const tests = await t.tool("agent-andrii", "run_tests", { filter: "checkout" });
    expect(tests.ok).toBe(true);
    expect(tests.data?.passed).toBe(1);
    const cmd = await t.tool("agent-andrii", "run_command", { cmd: "node -e 'console.log(1)'", timeoutSec: 5 });
    expect(cmd.ok).toBe(true);
    expect(cmd.data?.exitCode).toBe(0);
    expect(t.runner.commandCalls[0]?.timeoutSec).toBe(5);
    expect(Object.keys(t.runner.testCalls[0]?.files ?? {})).toContain("src/tax.ts");
  });

  it("presence: read_file and list_files show other agents' active intents on a file", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    register(t, "agent-masha");
    const before = await t.tool("agent-andrii", "read_file", { path: "src/checkout.ts" });
    expect((before.data as { activeIntents?: unknown }).activeIntents).toBeUndefined();
    expect((before.data as { note?: string }).note).toBeUndefined();

    const m1 = await t.tool("agent-masha", "declare_intent", GOOD_INTENT);
    await t.tool("agent-masha", "edit_region", { intentId: m1.data!.intent.id, path: "src/checkout.ts", oldText: "return applyDiscount(subtotal(items), promo);", newText: "return Math.round(applyDiscount(subtotal(items), promo));" });
    const m2 = await t.tool("agent-masha", "declare_intent", { ...GOOD_INTENT, target: { file: "src/checkout.ts", symbol: "subtotal" }, what: "skip zero-qty lines in subtotal", output: "ignores items with qty <= 0 when summing" });
    await t.tool("agent-masha", "finish_intent", { intentId: m2.data!.intent.id }); // no edits -> cancelled, not active

    const read = await t.tool("agent-andrii", "read_file", { path: "src/checkout.ts" });
    const data = read.data as { content: string; activeIntents?: { id: string; agentId: string; humanId: string; symbol: string; status: string; what: string; output: string }[]; note?: string };
    expect(data.activeIntents).toEqual([{ id: "M1", agentId: "agent-masha", humanId: "masha", symbol: "calculateTotal", status: "in_progress", what: GOOD_INTENT.what, output: GOOD_INTENT.output }]);
    expect(data.note).toBe(`agent-masha is working on calculateTotal here (M1, in_progress): ${GOOD_INTENT.what}. Promised: ${GOOD_INTENT.output}.`);
    expect(data.content.startsWith("import type")).toBe(true); // content stays clean

    const files = await t.tool("agent-andrii", "list_files", {});
    const rows = files.data!.files as ({ path: string; activeIntents?: { id: string; agentId: string; symbol: string }[]; owners?: string[] })[];
    const checkout = rows.find((f) => f.path === "src/checkout.ts")!;
    expect(checkout.activeIntents).toEqual([{ id: "M1", agentId: "agent-masha", symbol: "calculateTotal" }]);
    expect(checkout.owners).toEqual(["masha"]);
    expect(rows.find((f) => f.path === "src/format.ts")!.activeIntents).toBeUndefined();
    expect(rows.filter((f) => f.activeIntents).length).toBe(1);

    // the caller's own intent is listed too
    const own = await t.tool("agent-masha", "read_file", { path: "src/checkout.ts", startLine: 1, endLine: 3 });
    expect((own.data as { activeIntents?: { id: string }[] }).activeIntents?.map((i) => i.id)).toEqual(["M1"]);
  });

  it("a filter that matches no tests is not green: run_tests and POST /api/test return ok false with a note", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    t.runner.result = { ok: true, passed: 0, failed: 0, failures: [], durationMs: 3 };
    const res = await t.tool("agent-andrii", "run_tests", { filter: "nothing-here" });
    expect(res.ok).toBe(true); // the tool call itself worked
    const data = res.data as TestResult & { note?: string };
    expect(data.ok).toBe(false);
    expect(data.passed).toBe(0);
    expect(data.note).toContain("filter 'nothing-here' matched no tests; run without filter or use a test-name regex.");
    expect(data.failures.map((f) => f.name)).toEqual(["filter"]);
    const finished = t.events("test_run_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.type === "test_run_finished" && finished[0].result.ok).toBe(false);

    const api = await t.hive.built.app.inject({ method: "POST", url: "/api/test", payload: { filter: "nothing-here" } });
    expect(api.statusCode).toBe(200);
    expect(api.json()).toMatchObject({ ok: false, passed: 0, failed: 0 });
    expect(api.json().failures[0].message).toContain("matched no tests");
    expect(t.hive.ctx.deps.history.lastGreen()?.rev).toBe(0);

    // without a filter the runner's verdict stands
    const plain = await t.tool("agent-andrii", "run_tests", {});
    expect((plain.data as TestResult).ok).toBe(true);
    t.runner.result = { ok: true, passed: 2, failed: 0, failures: [], durationMs: 3 };
    const matched = await t.tool("agent-andrii", "run_tests", { filter: "checkout" });
    expect((matched.data as TestResult).ok).toBe(true);
  });

  it("create_file under an intent, then finish; POST /api/agents starts a loop and 409s on a repeat", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const declared = await t.tool("agent-andrii", "declare_intent", { ...GOOD_INTENT, target: { file: "src/receipt.ts", symbol: "receiptLine" }, action: "add" });
    const id = declared.data!.intent.id;
    const created = await t.tool("agent-andrii", "create_file", { intentId: id, path: "src/receipt.ts", content: "export function receiptLine() { return ''; }\n" });
    expect(created.ok).toBe(true);
    expect(t.hive.ctx.deps.intents.get(id)?.status).toBe("in_progress");
    const dup = await t.tool("agent-andrii", "create_file", { intentId: id, path: "src/receipt.ts", content: "x" });
    expect(dup.error?.code).toBe("BAD_ARGS");

    const start = await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-masha", humanId: "masha", task: "add tax line" } });
    expect(start.statusCode).toBe(200);
    const again = await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-masha", humanId: "masha", task: "again" } });
    expect(again.statusCode).toBe(409);
    const state = (await t.hive.built.app.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.agents.find((a: { agentId: string }) => a.agentId === "agent-masha")).toMatchObject({ humanId: "masha", task: "add tax line", status: "idle", control: "run" });
  });
});
