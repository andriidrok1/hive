import type { FeedEvent, HiveMode, ToolArgs, ToolName, ToolResponse, ToolResults } from "@hive/shared";
import { createHive, type Hive } from "../../src/hive.js";
import { fakeModules, FakeRunner } from "../../src/api/fakes.js";
import { noopLLM } from "../../src/coord/index.js";
import { SAMPLE_PROJECT } from "../../src/api/sampleProject.js";
import type { AgentRunOptions, AgentRunResult, RunAgentFn } from "../../src/agents/AgentManager.js";

export interface TestHive {
  hive: Hive;
  runner: FakeRunner;
  tool<T extends ToolName>(agentId: string, tool: T, args: ToolArgs[T] | Record<string, unknown>): Promise<ToolResponse<ToolResults[T]>>;
  events(type?: FeedEvent["type"]): FeedEvent[];
  close(): Promise<void>;
}

export const neverEndingRun: RunAgentFn = (opts: AgentRunOptions) =>
  new Promise<AgentRunResult>((resolve) => {
    opts.signal?.addEventListener("abort", () => resolve({ status: "stopped", toolCalls: 0, tokensIn: 0, tokensOut: 0, ms: 0 }), { once: true });
  });

export async function makeHive(opts: { mode?: HiveMode; runAgent?: RunAgentFn; files?: Record<string, string> } = {}): Promise<TestHive> {
  const runner = new FakeRunner();
  const hive = createHive({
    mode: opts.mode ?? "hive",
    initialFiles: opts.files ?? SAMPLE_PROJECT,
    runner,
    llm: noopLLM(),
    modules: fakeModules(),
    runAgent: opts.runAgent ?? neverEndingRun,
  });
  await hive.built.ready;
  const app = hive.built.app;
  return {
    hive,
    runner,
    async tool(agentId, tool, args) {
      const res = await app.inject({ method: "POST", url: `/api/agents/${agentId}/tools/${tool}`, payload: args });
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${res.body}`);
      return res.json();
    },
    events(type) {
      const all = hive.ctx.deps.emitter.recent();
      return type ? all.filter((e) => e.type === type) : all;
    },
    close: () => hive.close(),
  };
}

export function register(t: TestHive, agentId: string, humanId = agentId.replace(/^agent-/, "")) {
  t.hive.agents.register(agentId, humanId);
}

export const GOOD_INTENT = {
  target: { file: "src/checkout.ts", symbol: "calculateTotal" },
  action: "modify" as const,
  what: "make calculateTotal include state tax",
  input: "items: Item[], promo?: Promo, state: string",
  output: "returns subtotal minus discount plus state tax, rounded to integer cents",
};

export async function listen(t: TestHive): Promise<string> {
  const address = await t.hive.built.app.listen({ port: 0, host: "127.0.0.1" });
  return address;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, ms = 3000, step = 20): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await sleep(step);
  }
  if (!pred()) throw new Error("waitFor timed out");
}
