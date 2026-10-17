import { describe, expect, it } from "vitest";
import type { FeedEvent, FeedEventBody, HiveState } from "@hive/shared";
import { HiveClient, type FeedSocket, type FetchLike } from "../src/client.js";
import { runScenario } from "../src/runner.js";
import { loadScenarios, selectScenarios } from "../src/scenarios.js";
import { buildJobs, parseBenchArgs, serverUrls } from "../src/run.js";

type Listener = (ev: { data?: unknown }) => void;

/** A fake Hive server: records requests, drives agents to "done" on the third poll, pushes feed events. */
class FakeServer {
  calls: { method: string; path: string; body?: unknown; rawBody?: string }[] = [];
  polls = 0;
  sockets: { listeners: Record<string, Listener[]>; closed: boolean }[] = [];
  agents = new Map<string, string>();
  mode = "hive";

  fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, body, ...(init?.body !== undefined ? { rawBody: init.body } : {}) });
    const json = (status: number, data: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    if (path === "/api/reset") {
      this.mode = body.mode;
      this.agents.clear();
      return json(200, { ok: true });
    }
    if (path === "/api/agents") {
      if (this.agents.has(body.agentId)) return json(409, { error: "running" });
      this.agents.set(body.agentId, "thinking");
      this.emit({ type: "agent_status", agentId: body.agentId, humanId: body.humanId, status: "thinking", task: body.task });
      return json(200, { ok: true });
    }
    if (path === "/api/state") {
      this.polls++;
      if (this.polls >= 3) {
        for (const id of this.agents.keys()) {
          if (this.agents.get(id) !== "done") {
            this.agents.set(id, "done");
            this.emit({ type: "agent_status", agentId: id, humanId: "h", status: "done" });
          }
        }
      }
      const state: HiveState = {
        mode: this.mode as HiveState["mode"],
        rev: 3,
        files: [],
        agents: [...this.agents].map(([agentId, status]) => ({ agentId, humanId: "h", status: status as never, control: "run" })),
        intents: [],
        history: [],
        recentEvents: [],
      };
      return json(200, state);
    }
    if (path === "/api/merge") return json(200, { ok: true, conflicts: [], rev: 4 });
    if (path === "/api/test") {
      const extra = Object.keys(body.extraFiles ?? {});
      return json(200, { ok: extra.length === 1, passed: 27, failed: 0, failures: [], durationMs: 10 });
    }
    return json(404, { error: "not found" });
  };

  socketFactory = (): FeedSocket => {
    const entry = { listeners: {} as Record<string, Listener[]>, closed: false };
    this.sockets.push(entry);
    const sock: FeedSocket = {
      addEventListener: (type, cb) => {
        (entry.listeners[type] ??= []).push(cb);
        if (type === "open") queueMicrotask(() => cb({}));
      },
      close: () => {
        entry.closed = true;
      },
    };
    return sock;
  };

  private seq = 0;
  emit(body: FeedEventBody): void {
    const ev = { id: ++this.seq, ts: Date.now(), ...body } as FeedEvent;
    for (const s of this.sockets) if (!s.closed) for (const cb of s.listeners.message ?? []) cb({ data: JSON.stringify(ev) });
  }
}

const scenarios = loadScenarios();
const s01 = selectScenarios(scenarios, "s01")[0]!;
const c01 = selectScenarios(scenarios, "c01")[0]!;

describe("runScenario", () => {
  it("drives reset -> agents -> wait -> test and fills a row from the feed", async () => {
    const server = new FakeServer();
    const client = new HiveClient("http://fake:4317", server.fetch);
    const slept: number[] = [];
    let clock = 1000;
    // Events that the fake server does not generate on its own: pushed when agents start.
    const origStart = client.startAgent.bind(client);
    client.startAgent = async (agentId, humanId, task, owns) => {
      const r = await origStart(agentId, humanId, task, owns);
      server.emit({ type: "llm_call", purpose: `agent:${agentId}`, model: "m", ms: 5, tokensIn: 100, tokensOut: 10 });
      server.emit({ type: "agent_status", agentId, humanId, status: "tool", step: 1 });
      server.emit({ type: "agent_status", agentId, humanId, status: "tool", step: 2 });
      if (agentId === "agent-masha") {
        server.emit({
          type: "intent_declared",
          intent: { id: "B1", agentId, humanId, status: "conflict", createdAt: 0, updatedAt: 0, baseRev: 1, target: { file: "src/order.ts", symbol: "orderSummary" }, action: "modify", what: "w", input: "i", output: "o" },
          conflicts: [{ intentId: "A1", kind: "contradiction", reason: "tax twice" }],
          dependents: ["agent-andrii"],
        });
        server.emit({ type: "briefing_sent", briefing: { id: "br_1", toAgent: "agent-andrii", kind: "intent_conflict", summary: "s", details: {}, requiresAck: true, createdAt: 0 } });
        server.emit({ type: "briefing_acked", briefingId: "br_1", agentId: "agent-andrii", ack: { response: "adapted", at: 0 } });
      }
      return r;
    };

    const row = await runScenario(client, s01, "hive", 2, {
      socketFactory: server.socketFactory,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
      pollMs: 3000,
      extraTests: "// extra",
    });

    expect(row).toMatchObject({
      scenario: "s01-double-tax",
      variant: "hive",
      repeat: 2,
      conflict: true,
      success: true,
      passed: 27,
      failed: 0,
      toolCalls: 4,
      llmCalls: 2,
      tokensIn: 200,
      tokensOut: 20,
      briefingsSent: 1,
      acksAdapted: 1,
      conflictsCaught: 1,
      culpritSearches: 0,
      culpritCorrect: null,
      mergeOk: null,
      agentsFinished: true,
      error: "",
    });
    expect(row.wallMs).toBeGreaterThan(0);

    const paths = server.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths[0]).toBe("POST /api/reset");
    expect(server.calls[0]!.body).toEqual({ mode: "hive" });
    expect(paths.filter((p) => p === "POST /api/agents")).toHaveLength(2);
    expect(paths).not.toContain("POST /api/merge");
    expect(paths.at(-1)).toBe("POST /api/test");
    expect(server.calls.at(-1)!.body).toEqual({ extraFiles: { "test/s01.accept.test.ts": "// extra" } });
    // the second agent waited its startDelaysMs before starting
    expect(slept).toContain(3000);
    const startBodies = server.calls.filter((c) => c.path === "/api/agents").map((c) => c.body as { agentId: string; humanId: string; task: string; owns: string[] });
    expect(startBodies.map((b) => b.agentId)).toEqual(["agent-andrii", "agent-masha"]);
    // each agent's ownership list from the scenario file rides along in the start body
    expect(startBodies[0]).toEqual({ agentId: "agent-andrii", humanId: "andrii", task: s01.agents[0]!.task, owns: s01.agents[0]!.owns });
    expect(startBodies[1]!.owns).toEqual(s01.agents[1]!.owns);
    expect(startBodies[1]!.owns).toContain("src/order.ts");
    // the feed was opened before the first agent started and closed at the end
    expect(server.sockets).toHaveLength(1);
    expect(server.sockets[0]!.closed).toBe(true);
  });

  it("merges first in isolated mode and records mergeOk", async () => {
    const server = new FakeServer();
    const client = new HiveClient("http://fake:4318", server.fetch);
    const row = await runScenario(client, c01, "isolated", 1, { socketFactory: server.socketFactory, sleep: async () => {}, extraTests: "x" });
    const paths = server.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths.indexOf("POST /api/merge")).toBeGreaterThan(paths.lastIndexOf("GET /api/state"));
    expect(paths.indexOf("POST /api/merge")).toBeLessThan(paths.indexOf("POST /api/test"));
    expect(row.mergeOk).toBe(true);
    expect(row.success).toBe(true);
    // owns is sent in non-hive variants too, so the comparison stays fair
    for (const c of server.calls.filter((c) => c.path === "/api/agents")) {
      const agent = c01.agents.find((a) => a.agentId === (c.body as { agentId: string }).agentId)!;
      expect((c.body as { owns?: string[] }).owns).toEqual(agent.owns);
    }
    // every POST carries a JSON body, Fastify rejects an empty one with FST_ERR_CTP_EMPTY_JSON_BODY
    for (const c of server.calls) if (c.method === "POST") expect(c.rawBody, c.path).toMatch(/^\{/);
    expect(server.calls.find((c) => c.path === "/api/merge")!.body).toEqual({});
  });

  it("records a timeout instead of throwing", async () => {
    const server = new FakeServer();
    server.fetch = (() => {
      const inner = server.fetch;
      return (async (url, init) => {
        // agents never finish: keep the poll counter below the threshold
        if (new URL(url).pathname === "/api/state") server.polls = -1000;
        return inner(url, init);
      }) as FetchLike;
    })();
    const client = new HiveClient("http://fake:4317", server.fetch);
    let clock = 0;
    const row = await runScenario(client, s01, "naive", 1, {
      socketFactory: server.socketFactory,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      pollMs: 3000,
      timeoutMs: 10_000,
      extraTests: "x",
    });
    expect(row.agentsFinished).toBe(false);
    expect(row.error).toMatch(/timeout after 10000ms/);
    expect(row.success).toBe(true); // the suite still ran on whatever state the project reached
  });

  it("records an HTTP error in the row", async () => {
    const server = new FakeServer();
    const client = new HiveClient("http://fake:4317", async () => ({ ok: false, status: 500, text: async () => "boom" }));
    const row = await runScenario(client, s01, "hive", 1, { socketFactory: server.socketFactory, sleep: async () => {}, extraTests: "x" });
    expect(row.error).toMatch(/\/api\/reset -> HTTP 500: boom/);
    expect(row.success).toBe(false);
  });
});

describe("CLI helpers", () => {
  it("parses arguments", () => {
    const args = parseBenchArgs(["--scenarios", "s01,c01", "--variants", "hive,naive", "--repeats", "2", "--parallel", "3", "--server", "http://localhost:4317/"]);
    expect(args.scenarios.map((s) => s.id)).toEqual(["s01-double-tax", "c01-control-wa-and-validation"]);
    expect(args.variants).toEqual(["hive", "naive"]);
    expect(args.repeats).toBe(2);
    expect(args.server).toBe("http://localhost:4317");
    expect(args.timeoutMs).toBe(5 * 60_000);
    expect(() => parseBenchArgs(["--variants", "fast"])).toThrow(/unknown variant/);
  });

  it("builds jobs with repeats as the outer loop and servers on consecutive ports", () => {
    const jobs = buildJobs({ scenarios: [s01, c01], variants: ["hive", "naive"], repeats: 2 });
    expect(jobs).toHaveLength(8);
    expect(jobs.slice(0, 4).every((j) => j.repeat === 1)).toBe(true);
    expect(serverUrls("http://localhost:4317", 3)).toEqual(["http://localhost:4317", "http://localhost:4318", "http://localhost:4319"]);
  });
});
