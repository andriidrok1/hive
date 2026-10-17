import { afterEach, describe, expect, it } from "vitest";
import type { AgentStatus } from "@hive/shared";
import { makeHive, type TestHive, waitFor } from "./helpers.js";
import type { AgentRunOptions, AgentRunResult } from "../../src/agents/AgentManager.js";

let t: TestHive;
afterEach(async () => {
  await t?.close();
});

const statusesOf = (t: TestHive, agentId: string): AgentStatus[] =>
  t.events("agent_status").flatMap((e) => (e.type === "agent_status" && e.agentId === agentId ? [e.status] : []));

const dedupe = <T>(xs: T[]): T[] => xs.filter((x, i) => i === 0 || xs[i - 1] !== x);

describe("AgentManager", () => {
  it("15. a fake runAgent that calls two tools and finishes -> agent_status idle -> tool -> done", async () => {
    const seen: string[] = [];
    t = await makeHive({
      runAgent: async (opts: AgentRunOptions): Promise<AgentRunResult> => {
        seen.push(opts.agentId, opts.humanId, opts.task, opts.mode ?? "?");
        const files = await opts.client.call("list_files", {});
        expect(files.ok).toBe(true);
        const read = await opts.client.call("read_file", { path: "src/tax.ts" });
        expect(read.data?.content).toContain("applyTax");
        opts.onEvent?.({ type: "llm_call", model: "fake-model", ms: 12, tokensIn: 100, tokensOut: 20 });
        return { status: "done", toolCalls: 2, tokensIn: 100, tokensOut: 20, ms: 30, finalMessage: "all good" };
      },
    });
    const res = await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-andrii", humanId: "andrii", task: "look around" } });
    expect(res.statusCode).toBe(200);
    await waitFor(() => t.hive.agents.get("agent-andrii")?.status === "done");
    expect(seen).toEqual(["agent-andrii", "andrii", "look around", "hive"]);
    const statuses = statusesOf(t, "agent-andrii");
    expect(dedupe(statuses.filter((s) => s !== "thinking"))).toEqual(["idle", "tool", "done"]);
    expect(statuses.filter((s) => s === "tool")).toHaveLength(2);
    const llm = t.events("llm_call");
    expect(llm[0]).toMatchObject({ purpose: "agent:agent-andrii", model: "fake-model", ms: 12, tokensIn: 100, tokensOut: 20 });
    expect(t.events("file_read")).toHaveLength(1);
    // the agent can be started again once it finished
    const again = await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-andrii", humanId: "andrii", task: "once more" } });
    expect(again.statusCode).toBe(200);
    await waitFor(() => t.hive.agents.get("agent-andrii")?.status === "done" && t.hive.agents.get("agent-andrii")?.task === "once more");
  });

  it("stop aborts the signal and maps to stopped; urgent note aborts only the current interrupt signal", async () => {
    const interrupts: AbortSignal[] = [];
    let resolveRun: ((r: AgentRunResult) => void) | undefined;
    t = await makeHive({
      runAgent: (opts) =>
        new Promise<AgentRunResult>((resolve) => {
          resolveRun = resolve;
          interrupts.push(opts.interrupt!.current());
          opts.signal!.addEventListener("abort", () => resolve({ status: "stopped", toolCalls: 0, tokensIn: 0, tokensOut: 0, ms: 1 }), { once: true });
        }),
    });
    await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-andrii", humanId: "andrii", task: "wait" } });
    await waitFor(() => interrupts.length === 1);

    await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-andrii/note", payload: { humanId: "andrii", text: "stop touching tax", urgent: true } });
    expect(interrupts[0]?.aborted).toBe(true);
    const fresh = t.hive.agents["running"].get("agent-andrii")!.interrupt.signal;
    expect(fresh.aborted).toBe(false);

    await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-andrii/control", payload: { humanId: "andrii", control: "pause" } });
    expect(t.hive.agents.get("agent-andrii")?.status).toBe("paused");
    expect(t.hive.agents.controlOf("agent-andrii")).toBe("pause");

    await t.hive.built.app.inject({ method: "POST", url: "/api/agents/agent-andrii/control", payload: { humanId: "andrii", control: "stop" } });
    await waitFor(() => t.hive.agents.get("agent-andrii")?.status === "stopped");
    expect(t.hive.agents.isRunning("agent-andrii")).toBe(false);
    expect(resolveRun).toBeDefined();
  });

  it("passes the budget to runAgent: 60 calls / 10 min by default, env overrides", async () => {
    const seen: { maxToolCalls?: number; maxMs?: number }[] = [];
    const run = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
      seen.push({ maxToolCalls: opts.maxToolCalls, maxMs: opts.maxMs });
      return { status: "done", toolCalls: 0, tokensIn: 0, tokensOut: 0, ms: 0 };
    };
    t = await makeHive({ runAgent: run });
    expect(t.hive.agents.maxToolCalls).toBe(60);
    expect(t.hive.agents.maxMs).toBe(600_000);
    await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-a", humanId: "a", task: "t" } });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({ maxToolCalls: 60, maxMs: 600_000 });
    await t.close();

    process.env.HIVE_AGENT_MAX_TOOL_CALLS = "25";
    process.env.HIVE_AGENT_MAX_MS = "90000";
    try {
      t = await makeHive({ runAgent: run });
      expect(t.hive.agents.maxToolCalls).toBe(25);
      expect(t.hive.agents.maxMs).toBe(90_000);
    } finally {
      delete process.env.HIVE_AGENT_MAX_TOOL_CALLS;
      delete process.env.HIVE_AGENT_MAX_MS;
    }
  });

  it("a crashing runAgent ends in error; stopAll on reset clears agents", async () => {
    t = await makeHive({
      runAgent: async () => {
        throw new Error("boom");
      },
    });
    await t.hive.built.app.inject({ method: "POST", url: "/api/agents", payload: { agentId: "agent-x", humanId: "x", task: "crash" } });
    await waitFor(() => t.hive.agents.get("agent-x")?.status === "error");
    await t.hive.built.app.inject({ method: "POST", url: "/api/reset", payload: {} });
    expect(t.hive.agents.list()).toEqual([]);
  });
});
