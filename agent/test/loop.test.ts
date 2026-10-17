import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { runAgent, type AgentEvent } from "../src/index.js";
import { FakeHive, FakeOpenAI, briefing, completion, toolCallMessage } from "./fakes.js";

const base = { agentId: "agent-a", humanId: "a", task: "add shipping to calculateTotal" };

function lastToolMessages(req: OpenAI.Chat.ChatCompletionCreateParams): string[] {
  return req.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

describe("runAgent: scripted happy path (test 2)", () => {
  it("relays read_file -> declare_intent -> edit_region -> finish_intent in order and ends done", async () => {
    const hive = new FakeHive();
    const ai = new FakeOpenAI([
      { tool: "read_file", args: { path: "src/checkout.ts" } },
      { tool: "declare_intent", args: { target: { file: "src/checkout.ts", symbol: "calculateTotal" }, action: "modify", what: "add shipping", input: "items, promo?", output: "subtotal - discount + shipping in cents" } },
      { tool: "edit_region", args: { intentId: "A1", path: "src/checkout.ts", oldText: "return x", newText: "return x + 1" } },
      { tool: "finish_intent", args: { intentId: "A1" } },
      { text: "Done.\nChanged calculateTotal.\nTests green." },
    ]);
    const events: AgentEvent[] = [];
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), onEvent: (e) => events.push(e) });

    expect(res.status).toBe("done");
    expect(res.finalMessage).toContain("Done.");
    expect(res.toolCalls).toBe(4);
    expect(hive.toolNames()).toEqual(["read_file", "declare_intent", "edit_region", "finish_intent"]);
    expect(hive.calls[2]?.args).toEqual({ intentId: "A1", path: "src/checkout.ts", oldText: "return x", newText: "return x + 1" });

    // request shape
    expect(ai.requests).toHaveLength(5);
    const first = ai.requests[0]!.body;
    expect(first.parallel_tool_calls).toBe(false);
    expect(first.reasoning_effort).toBe("low");
    expect(first.tools).toHaveLength(11);
    expect(first.messages[0]).toMatchObject({ role: "system" });
    expect(first.messages[1]).toMatchObject({ role: "user" });
    expect((first.messages[1] as { content: string }).content).toContain(base.task);

    // the tool result travels as the JSON of the ToolResponse envelope
    const second = ai.requests[1]!.body;
    const toolMsg = second.messages.at(-1)!;
    expect(toolMsg.role).toBe("tool");
    const parsed = JSON.parse((toolMsg as { content: string }).content);
    expect(parsed).toMatchObject({ ok: true, control: "run", rev: 1, briefings: [] });
    expect(parsed.data.path).toBe("src/checkout.ts");

    // each model call logged
    expect(events.filter((e) => e.type === "llm_call")).toHaveLength(5);
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
  });

  it("uses the model from options, then env, then the default", async () => {
    const ai = new FakeOpenAI([{ text: "ok" }]);
    await runAgent({ ...base, client: new FakeHive(), openai: ai.asOpenAI(), model: "gpt-test" });
    expect(ai.requests[0]!.body.model).toBe("gpt-test");
    const ai2 = new FakeOpenAI([{ text: "ok" }]);
    const prev = process.env.HIVE_MODEL_AGENT;
    delete process.env.HIVE_MODEL_AGENT;
    try {
      await runAgent({ ...base, client: new FakeHive(), openai: ai2.asOpenAI() });
    } finally {
      if (prev !== undefined) process.env.HIVE_MODEL_AGENT = prev;
    }
    expect(ai2.requests[0]!.body.model).toBe("gpt-5.4-mini");
  });
});

describe("runAgent: briefings (test 3)", () => {
  it("briefings in a tool response show up as the HIVE BRIEFINGS block in the next model request", async () => {
    const hive = new FakeHive();
    hive.queued = [briefing({ id: "br_7" })];
    const ai = new FakeOpenAI([
      { tool: "read_file", args: { path: "src/tax.ts" } },
      { tool: "ack_briefing", args: { briefingId: "br_7", response: "adapted", note: "dropped my own tax multiplication" } },
      { text: "done" },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");

    const second = ai.requests[1]!.body;
    const content = lastToolMessages(second).at(-1)!;
    const [json, block] = content.split("\n\nHIVE BRIEFINGS");
    expect(JSON.parse(json!).briefings[0].id).toBe("br_7");
    expect(block).toBeDefined();
    expect(content).toContain("HIVE BRIEFINGS (you must handle these before editing again):");
    expect(content).toContain("[br_7] symbol_changed from agent-masha");
    expect(content).toContain("calculateTotal now returns total WITH tax");
    expect(content).toContain("-> call ack_briefing with adapted | not_relevant | ask");

    // third request still has it in history, and the ack response (no briefings) has no block
    const third = ai.requests[2]!.body;
    const msgs = lastToolMessages(third);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).not.toContain("HIVE BRIEFINGS");
  });

  it("briefings without requiresAck have no ack hint", async () => {
    const hive = new FakeHive();
    hive.queued = [briefing({ id: "br_1", kind: "human_note", fromAgent: undefined, fromHuman: "andrii", summary: "please also handle promo codes", requiresAck: false })];
    const ai = new FakeOpenAI([{ tool: "list_files", args: {} }, { text: "done" }]);
    await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    const content = lastToolMessages(ai.requests[1]!.body).at(-1)!;
    expect(content).toContain("[br_1] human_note from andrii");
    expect(content).not.toContain("-> call ack_briefing");
  });
});

describe("runAgent: bad tool calls (test 4)", () => {
  it("invalid JSON args produce a BAD_ARGS tool message and the loop continues", async () => {
    const hive = new FakeHive();
    const ai = new FakeOpenAI([
      { tool: "read_file", args: "{not json" },
      { tool: "read_file", args: { path: "src/checkout.ts" } },
      { text: "done" },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");
    expect(hive.toolNames()).toEqual(["read_file"]);
    const errMsg = JSON.parse(lastToolMessages(ai.requests[1]!.body)[0]!);
    expect(errMsg.ok).toBe(false);
    expect(errMsg.error.code).toBe("BAD_ARGS");
    expect(errMsg.error.message).toMatch(/JSON/);
    expect(errMsg).toHaveProperty("briefings");
    expect(errMsg).toHaveProperty("control");
    // the tool_call_id of the error message matches the model's call id
    const toolMsg = ai.requests[1]!.body.messages.at(-1) as { tool_call_id: string };
    expect(toolMsg.tool_call_id).toBe("call_1");
  });

  it("unknown tool names and a throwing client become ok:false envelopes, not crashes", async () => {
    const hive = new FakeHive((tool) => {
      if (tool === "run_tests") throw new Error("socket hang up");
      return undefined;
    });
    const ai = new FakeOpenAI([
      { tool: "delete_everything", args: {} },
      { tool: "run_tests", args: {} },
      { text: "done" },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");
    const unknown = JSON.parse(lastToolMessages(ai.requests[1]!.body)[0]!);
    expect(unknown.error.code).toBe("BAD_ARGS");
    expect(unknown.error.message).toContain("unknown tool delete_everything");
    const thrown = JSON.parse(lastToolMessages(ai.requests[2]!.body)[1]!);
    expect(thrown.error.code).toBe("INTERNAL");
    expect(thrown.error.message).toContain("socket hang up");
  });

  it("a model that emits several tool calls in one message gets one tool message per call", async () => {
    const hive = new FakeHive();
    const ai = new FakeOpenAI([
      {
        onCall: async () =>
          completion({
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } },
              { id: "c2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) } },
            ],
          }),
      },
      { text: "done" },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");
    expect(res.toolCalls).toBe(2);
    const ids = ai.requests[1]!.body.messages.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(ids).toEqual(["c1", "c2"]);
  });
});

describe("runAgent: control (test 5)", () => {
  it("pause: polls list_files until run, then resumes", async () => {
    let polls = 0;
    const hive2 = new FakeHive((tool) => {
      if (tool === "list_files") {
        polls += 1;
        if (polls >= 3) hive2.control = "run";
      }
      return undefined;
    });
    hive2.control = "pause";
    const ai = new FakeOpenAI([{ tool: "read_file", args: { path: "a.ts" } }, { tool: "read_file", args: { path: "b.ts" } }, { text: "done" }]);
    const events: AgentEvent[] = [];
    const t0 = Date.now();
    const res = await runAgent({ ...base, client: hive2, openai: ai.asOpenAI(), pauseMs: 15, onEvent: (e) => events.push(e) });
    expect(res.status).toBe("done");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    expect(hive2.toolNames()).toEqual(["read_file", "list_files", "list_files", "list_files", "read_file"]);
    expect(events.some((e) => e.type === "status" && e.status === "paused")).toBe(true);
    // the model never saw the polls
    expect(ai.requests[2]!.body.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("briefings picked up while paused reach the model as a user message", async () => {
    let polls = 0;
    const hive = new FakeHive((tool) => {
      if (tool === "list_files") {
        polls += 1;
        hive.control = "run";
        return { briefings: [briefing({ id: "br_9", kind: "human_note", fromAgent: undefined, fromHuman: "a", summary: "stop, use cents", details: {} })] };
      }
      return undefined;
    });
    hive.control = "pause";
    const ai = new FakeOpenAI([{ tool: "read_file", args: { path: "a.ts" } }, { text: "done" }]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), pauseMs: 5 });
    expect(res.status).toBe("done");
    expect(polls).toBe(1);
    const last = ai.requests[1]!.body.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("[br_9] human_note from a: stop, use cents");
  });

  it("stop ends the run with status stopped and no further model calls", async () => {
    const hive = new FakeHive();
    hive.control = "stop";
    const ai = new FakeOpenAI([{ tool: "read_file", args: { path: "a.ts" } }, { text: "never" }]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("stopped");
    expect(ai.requests).toHaveLength(1);
    expect(res.toolCalls).toBe(1);
  });
});

describe("runAgent: budgets (test 6)", () => {
  it("maxToolCalls 3 -> budget after 3 tool calls", async () => {
    const hive = new FakeHive();
    const ai = new FakeOpenAI([
      { tool: "list_files", args: {} },
      { tool: "list_files", args: {} },
      { tool: "list_files", args: {} },
      { text: "never reached" },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), maxToolCalls: 3 });
    expect(res.status).toBe("budget");
    expect(res.toolCalls).toBe(3);
    expect(hive.calls).toHaveLength(3);
    expect(ai.requests).toHaveLength(3);
    expect(res.error).toMatch(/tool call budget/);
  });

  it("maxTokens -> budget once usage crosses it", async () => {
    const ai = new FakeOpenAI([
      { tool: "list_files", args: {}, usage: [600, 50] },
      { tool: "list_files", args: {}, usage: [700, 50] },
      { text: "never" },
    ]);
    const res = await runAgent({ ...base, client: new FakeHive(), openai: ai.asOpenAI(), maxTokens: 1000 });
    expect(res.status).toBe("budget");
    expect(res.tokensIn).toBe(1300);
    expect(ai.requests).toHaveLength(2);
  });

  it("maxMs -> budget", async () => {
    const ai = new FakeOpenAI([
      { onCall: async () => new Promise((r) => setTimeout(() => r(completion(toolCallMessage("c1", "list_files", "{}"))), 30)) },
      { text: "never" },
    ]);
    const res = await runAgent({ ...base, client: new FakeHive(), openai: ai.asOpenAI(), maxMs: 20 });
    expect(res.status).toBe("budget");
    expect(res.error).toMatch(/time budget/);
    expect(ai.requests).toHaveLength(1);
  });
});

describe("runAgent: signals (test 7)", () => {
  function abortErr(): Error {
    return Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
  }

  it("interrupt during a model call -> list_files once, step retried with a fresh signal", async () => {
    let ctrl = new AbortController();
    const interrupt = { current: () => ctrl.signal };
    const hive = new FakeHive((tool, _args, n) => {
      if (tool === "list_files" && n === 1) return { briefings: [briefing({ id: "br_u", kind: "human_note", fromAgent: undefined, fromHuman: "a", summary: "URGENT: use integer cents", requiresAck: true, details: {} })] };
      return undefined;
    });
    const seen: (AbortSignal | undefined)[] = [];
    const ai = new FakeOpenAI([
      {
        onCall: (_body, opts) =>
          new Promise((_resolve, reject) => {
            seen.push(opts?.signal);
            opts?.signal?.addEventListener("abort", () => reject(abortErr()), { once: true });
            // simulate the human sending an urgent note mid-call; the manager aborts and swaps the controller
            setTimeout(() => {
              const old = ctrl;
              ctrl = new AbortController();
              old.abort();
            }, 5);
          }),
      },
      {
        onCall: async (_body, opts) => {
          seen.push(opts?.signal);
          return completion(toolCallMessage("c1", "ack_briefing", JSON.stringify({ briefingId: "br_u", response: "adapted" })));
        },
      },
      { text: "done" },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), interrupt });
    expect(res.status).toBe("done");
    expect(hive.toolNames()).toEqual(["list_files", "ack_briefing"]);
    expect(seen).toHaveLength(2); // only the two onCall steps record their signal
    expect(seen[0]!.aborted).toBe(true);
    expect(seen[1]!.aborted).toBe(false);
    expect(seen[1]).not.toBe(seen[0]);
    // the urgent note was injected before the retried step
    const retried = ai.requests[1]!.body.messages.at(-1)!;
    expect(retried.role).toBe("user");
    expect(retried.content).toContain("[br_u] human_note from a: URGENT: use integer cents");
  });

  it("signal abort during a model call -> stopped, no further model calls", async () => {
    const stop = new AbortController();
    const hive = new FakeHive();
    const ai = new FakeOpenAI([
      { tool: "list_files", args: {} },
      {
        onCall: (_body, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(abortErr()), { once: true });
            setTimeout(() => stop.abort(), 5);
          }),
      },
      { text: "never" },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), signal: stop.signal });
    expect(res.status).toBe("stopped");
    expect(ai.requests).toHaveLength(2);
    expect(hive.toolNames()).toEqual(["list_files"]);
  });

  it("signal already aborted before the first call -> stopped immediately", async () => {
    const stop = new AbortController();
    stop.abort();
    const ai = new FakeOpenAI([{ text: "never" }]);
    const res = await runAgent({ ...base, client: new FakeHive(), openai: ai.asOpenAI(), signal: stop.signal });
    expect(res.status).toBe("stopped");
    expect(ai.requests).toHaveLength(0);
  });

  it("signal abort while paused -> stopped", async () => {
    const stop = new AbortController();
    const hive = new FakeHive();
    hive.control = "pause";
    const ai = new FakeOpenAI([{ tool: "list_files", args: {} }, { text: "never" }]);
    setTimeout(() => stop.abort(), 10);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), signal: stop.signal, pauseMs: 1000 });
    expect(res.status).toBe("stopped");
    expect(ai.requests).toHaveLength(1);
  });

  it("a non-abort model error ends the run with status error", async () => {
    const ai = new FakeOpenAI([{ error: Object.assign(new Error("rate limited"), { name: "RateLimitError" }) }]);
    const res = await runAgent({ ...base, client: new FakeHive(), openai: ai.asOpenAI() });
    expect(res.status).toBe("error");
    expect(res.error).toContain("rate limited");
  });
});

describe("runAgent: reasoning_effort fallback", () => {
  const reject = () => Object.assign(new Error("400 Function tools with reasoning_effort are not supported for gpt-x in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."), { status: 400, name: "BadRequestError" });

  it("starts with low, retries the same step with none after the 400, and remembers it for the model", async () => {
    const ai = new FakeOpenAI([{ error: reject() }, { tool: "list_files", args: {} }, { text: "done" }]);
    const res = await runAgent({ ...base, client: new FakeHive(), openai: ai.asOpenAI(), model: "gpt-fallback-a" });
    expect(res.status).toBe("done");
    expect(ai.requests.map((r) => r.body.reasoning_effort)).toEqual(["low", "none", "none"]);
    expect(ai.requests[1]!.body.messages).toHaveLength(2); // same step: nothing was appended between the attempts

    const ai2 = new FakeOpenAI([{ text: "done" }]);
    await runAgent({ ...base, client: new FakeHive(), openai: ai2.asOpenAI(), model: "gpt-fallback-a" });
    expect(ai2.requests[0]!.body.reasoning_effort).toBe("none");
  });

  it("other 400s are not retried and end with error", async () => {
    const ai = new FakeOpenAI([{ error: Object.assign(new Error("400 context_length_exceeded"), { status: 400 }) }]);
    const res = await runAgent({ ...base, client: new FakeHive(), openai: ai.asOpenAI(), model: "gpt-fallback-b" });
    expect(res.status).toBe("error");
    expect(ai.requests).toHaveLength(1);
  });
});

describe("runAgent: accounting (test 8)", () => {
  it("sums tokens and ms from usage fields and reports them per call", async () => {
    const events: AgentEvent[] = [];
    const ai = new FakeOpenAI([
      { tool: "list_files", args: {}, usage: [100, 20] },
      { tool: "list_files", args: {}, usage: [250, 30] },
      { text: "done", usage: [400, 7] },
    ]);
    const t0 = Date.now();
    const res = await runAgent({ ...base, client: new FakeHive(), openai: ai.asOpenAI(), onEvent: (e) => events.push(e) });
    expect(res.tokensIn).toBe(750);
    expect(res.tokensOut).toBe(57);
    expect(res.ms).toBeGreaterThanOrEqual(0);
    expect(res.ms).toBeLessThanOrEqual(Date.now() - t0 + 5);
    const llm = events.filter((e) => e.type === "llm_call");
    expect(llm.map((e) => [e.tokensIn, e.tokensOut])).toEqual([
      [100, 20],
      [250, 30],
      [400, 7],
    ]);
    for (const e of llm) {
      expect(typeof e.ms).toBe("number");
      expect(e.model).toBe("gpt-5.4-mini");
      expect(e.agentId).toBe("agent-a");
    }
  });
});
