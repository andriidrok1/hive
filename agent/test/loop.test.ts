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
        return { briefings: [briefing({ id: "br_9", kind: "human_note", fromAgent: undefined, fromHuman: "a", summary: "stop, use cents", requiresAck: false, details: {} })] };
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

describe("runAgent: red-tests nudges (up to 3) and unacked nudge", () => {
  const red = { ok: false, passed: 18, failed: 2, failures: [{ name: "calculateTotal > applies promo", message: "expected 900 got 1000" }, { name: "formatPrice > cents", message: "x" }], durationMs: 5 };
  const green = { ok: true, passed: 20, failed: 0, failures: [], durationMs: 5 };
  const redText = "Hive: tests are still red (2 failed: calculateTotal > applies promo, formatPrice > cents). You may still edit; if the failing tests belong to another agent's area, ask them and wait, otherwise fix now.";

  it("final message while the last run_tests was red -> nudge, the model fixes, green final accepted", async () => {
    let runs = 0;
    const hive = new FakeHive((tool) => (tool === "run_tests" ? { data: ++runs === 1 ? red : green } : undefined));
    const ai = new FakeOpenAI([
      { tool: "run_tests", args: {} },
      { text: "Done, all good." },
      { tool: "edit_region", args: { intentId: "A1", path: "a.ts", oldText: "x", newText: "y" } },
      { tool: "run_tests", args: {} },
      { text: "Done for real." },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");
    expect(res.finalMessage).toBe("Done for real.");
    expect(hive.toolNames()).toEqual(["run_tests", "edit_region", "run_tests"]);
    const nudge = ai.requests[2]!.body.messages.at(-1)!;
    expect(nudge).toEqual({ role: "user", content: redText });
    expect(ai.requests[2]!.body.messages.at(-2)).toMatchObject({ role: "assistant", content: "Done, all good." });
  });

  it("repeats up to 3 times while red, then accepts the 4th final message", async () => {
    const hive = new FakeHive((tool) => (tool === "run_tests" ? { data: red } : undefined));
    const ai = new FakeOpenAI([{ tool: "run_tests", args: {} }, { text: "give up 1" }, { text: "give up 2" }, { text: "give up 3" }, { text: "give up 4" }]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");
    expect(res.finalMessage).toBe("give up 4");
    expect(ai.requests).toHaveLength(5);
    const nudgesSent = ai.requests[4]!.body.messages.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("Hive: tests are still red"));
    expect(nudgesSent).toHaveLength(3);
    for (const n of nudgesSent) expect(n.content).toBe(redText);
  });

  it("low budget (fewer than 8 tool calls or 60 s left) -> no red nudge, final accepted", async () => {
    const hive = new FakeHive((tool) => (tool === "run_tests" ? { data: red } : undefined));
    const ai = new FakeOpenAI([{ tool: "run_tests", args: {} }, { text: "stopping" }]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), maxToolCalls: 8 }); // 7 left after one call
    expect(res.status).toBe("done");
    expect(ai.requests).toHaveLength(2);

    const ai2 = new FakeOpenAI([{ tool: "run_tests", args: {} }, { text: "stopping" }]);
    const res2 = await runAgent({ ...base, client: new FakeHive((tool) => (tool === "run_tests" ? { data: red } : undefined)), openai: ai2.asOpenAI(), maxMs: 59_000 });
    expect(res2.status).toBe("done");
    expect(ai2.requests).toHaveLength(2);
  });

  it("failing tests carried by a culprit briefing count as red", async () => {
    const hive = new FakeHive();
    hive.queued = [briefing({ id: "br_c", kind: "culprit", fromAgent: undefined, requiresAck: false, summary: "Tests failed after your change set A1.", details: { intentId: "A1", failingTests: [{ name: "checkout > total", message: "expected 1609 got 1500" }] } })];
    const ai = new FakeOpenAI([{ tool: "list_files", args: {} }, { text: "done" }, { text: "done again" }, { text: "done 3" }, { text: "done 4" }]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");
    expect(ai.requests[2]!.body.messages.at(-1)!.content).toBe("Hive: tests are still red (1 failed: checkout > total). You may still edit; if the failing tests belong to another agent's area, ask them and wait, otherwise fix now.");
    expect(ai.requests).toHaveLength(5);
  });

  it("final message with an unacked required briefing -> one nudge naming it; acked briefings do not count", async () => {
    const hive = new FakeHive();
    hive.queued = [briefing({ id: "br_3", requiresAck: true }), briefing({ id: "br_4", requiresAck: false })];
    const ai = new FakeOpenAI([{ tool: "read_file", args: { path: "a.ts" } }, { text: "done" }, { tool: "ack_briefing", args: { briefingId: "br_3", response: "adapted" } }, { text: "done" }]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");
    expect(ai.requests[2]!.body.messages.at(-1)!.content).toBe("Hive: briefings unacked (br_3). Call ack_briefing for each, then continue or finish.");
    expect(hive.toolNames()).toEqual(["read_file", "ack_briefing"]);

    // unacked only: a second final message is accepted
    const hive2 = new FakeHive();
    hive2.queued = [briefing({ id: "br_9", requiresAck: true })];
    const ai2 = new FakeOpenAI([{ tool: "read_file", args: { path: "a.ts" } }, { text: "done" }, { text: "done" }]);
    const res2 = await runAgent({ ...base, client: hive2, openai: ai2.asOpenAI() });
    expect(res2.status).toBe("done");
    expect(ai2.requests).toHaveLength(3);
  });

  it("both reasons combine; green tests with nothing unacked never nudge", async () => {
    const hive = new FakeHive((tool) => (tool === "run_tests" ? { data: red } : undefined));
    hive.queued = [briefing({ id: "br_5" })];
    const ai = new FakeOpenAI([{ tool: "run_tests", args: {} }, { text: "done" }, { text: "done" }, { text: "done" }, { text: "done" }]);
    await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(ai.requests[2]!.body.messages.at(-1)!.content).toMatch(/^Hive: tests are still red \(2 failed: .*\) \/ briefings unacked \(br_5\)\. You may still edit;/);

    const hive2 = new FakeHive((tool) => (tool === "run_tests" ? { data: green } : undefined));
    const ai2 = new FakeOpenAI([{ tool: "run_tests", args: {} }, { text: "done" }]);
    const res2 = await runAgent({ ...base, client: hive2, openai: ai2.asOpenAI() });
    expect(res2.status).toBe("done");
    expect(ai2.requests).toHaveLength(2);
  });
});

describe("runAgent: culprit briefing about my own change set", () => {
  const culprit = briefing({ id: "br_cul", kind: "culprit", fromAgent: undefined, requiresAck: true, summary: "Culprit: change set A1 (your intent) breaks checkout > total.", details: { intentId: "A1", failingTests: [{ name: "checkout > total", message: "expected 1609 got 1500" }] } });
  const declareArgs = { target: { file: "src/checkout.ts", symbol: "calculateTotal" }, action: "modify", what: "add shipping", input: "items", output: "total in cents" };

  it("not_relevant on it is sent as adapted and the model gets the Hive line before its next call", async () => {
    const hive = new FakeHive((tool, _args, n) => {
      if (tool === "finish_intent" && n === 2) return { briefings: [culprit] };
      return undefined;
    });
    const ai = new FakeOpenAI([
      { tool: "declare_intent", args: declareArgs },
      { tool: "finish_intent", args: { intentId: "A1" } },
      { tool: "ack_briefing", args: { briefingId: "br_cul", response: "not_relevant", note: "not mine" } },
      { tool: "edit_region", args: { intentId: "A1", path: "src/checkout.ts", oldText: "a", newText: "b" } },
      { tool: "run_tests", args: {} },
      { text: "fixed" },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");
    const ack = hive.calls.find((c) => c.tool === "ack_briefing")!.args as { response: string; note: string };
    expect(ack.response).toBe("adapted");
    expect(ack.note).toContain("not mine");
    expect(ack.note).toContain("overridden");
    const msgs = ai.requests[3]!.body.messages;
    expect(msgs.at(-1)).toEqual({ role: "user", content: "Hive: the culprit report names your change set; fix or explain." });
    expect(msgs.at(-2)!.role).toBe("tool");
  });

  it("not_relevant on a culprit briefing about someone else's intent passes through unchanged", async () => {
    const other = briefing({ id: "br_o", kind: "culprit", fromAgent: undefined, requiresAck: true, summary: "Culprit: change set M3 breaks tax tests.", details: { intentId: "M3" } });
    const hive = new FakeHive((tool, _args, n) => (tool === "declare_intent" && n === 1 ? { briefings: [other] } : undefined));
    const ai = new FakeOpenAI([{ tool: "declare_intent", args: declareArgs }, { tool: "ack_briefing", args: { briefingId: "br_o", response: "not_relevant", note: "masha's" } }, { text: "done" }]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI() });
    expect(res.status).toBe("done");
    expect((hive.calls[1]!.args as { response: string }).response).toBe("not_relevant");
    expect(ai.requests[2]!.body.messages.at(-1)!.role).toBe("tool");
  });
});

describe("runAgent: wait for conflict approval instead of giving up", () => {
  const target = { file: "src/checkout.ts", symbol: "calculateTotal" };
  const declareArgs = { target, action: "modify", what: "add shipping", input: "items", output: "subtotal plus shipping in cents" };
  const conflictData = { intent: { id: "M1", target, status: "conflict" }, status: "conflict", conflicts: [{ intentId: "A1", kind: "same_target", reason: "same symbol" }], dependents: [] };
  const approvedBriefing = briefing({ id: "br_ok", kind: "intent_conflict", fromAgent: undefined, summary: "Intent M1 is now approved: A1 finished.", details: { intentId: "M1", ...target }, requiresAck: false });

  it("polls list_files until the approval briefing, then continues with the approved message", async () => {
    let polls = 0;
    const hive = new FakeHive((tool) => {
      if (tool === "declare_intent") return { data: conflictData };
      if (tool === "list_files") {
        polls += 1;
        if (polls === 2) return { briefings: [approvedBriefing] };
      }
      return undefined;
    });
    const ai = new FakeOpenAI([
      { tool: "declare_intent", args: declareArgs },
      { tool: "ask_agent", args: { to: "agent-andrii", about: "A1", question: "when will A1 close?" } },
      { text: "Blocked by A1, stopping here." },
      { tool: "edit_region", args: { intentId: "M1", path: "src/checkout.ts", oldText: "a", newText: "b" } },
      { tool: "finish_intent", args: { intentId: "M1" } },
      { text: "Shipped." },
    ]);
    const t0 = Date.now();
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), conflictPollMs: 10, conflictWaitMs: 5000 });
    expect(res.status).toBe("done");
    expect(res.finalMessage).toBe("Shipped.");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(hive.toolNames()).toEqual(["declare_intent", "ask_agent", "list_files", "list_files", "edit_region", "finish_intent"]);
    const msgs = ai.requests[3]!.body.messages;
    // the approval briefing text first, then the continue message, after the model's premature answer
    expect(msgs.at(-3)).toMatchObject({ role: "assistant", content: "Blocked by A1, stopping here." });
    expect(msgs.at(-2)!.role).toBe("user");
    expect(msgs.at(-2)!.content).toContain("[br_ok] intent_conflict");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "Hive: your intent M1 is now approved; continue your task." });
  });

  it("times out and accepts the final message when no briefing arrives; only once per run", async () => {
    const hive = new FakeHive((tool) => (tool === "declare_intent" ? { data: conflictData } : undefined));
    const ai = new FakeOpenAI([{ tool: "declare_intent", args: declareArgs }, { text: "Blocked." }]);
    const t0 = Date.now();
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), conflictPollMs: 10, conflictWaitMs: 60 });
    expect(res.status).toBe("done");
    expect(res.finalMessage).toBe("Blocked.");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    expect(hive.toolNames().filter((t) => t === "list_files").length).toBeGreaterThanOrEqual(3);
    expect(ai.requests).toHaveLength(2);
  });

  it("an approved re-declare of the same target clears the conflict, so no wait happens", async () => {
    let n = 0;
    const hive = new FakeHive((tool) => (tool === "declare_intent" ? { data: ++n === 1 ? conflictData : { intent: { id: "M2", target, status: "approved" }, status: "approved", conflicts: [], dependents: [] } } : undefined));
    const ai = new FakeOpenAI([{ tool: "declare_intent", args: declareArgs }, { tool: "declare_intent", args: declareArgs }, { text: "done" }]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), conflictPollMs: 10, conflictWaitMs: 5000 });
    expect(res.status).toBe("done");
    expect(hive.toolNames()).toEqual(["declare_intent", "declare_intent"]);
  });

  it("conflict wait happens once and first, then red-tests nudges up to 3 times", async () => {
    let polls = 0;
    const hive = new FakeHive((tool) => {
      if (tool === "declare_intent") return { data: conflictData };
      if (tool === "run_tests") return { data: { ok: false, passed: 1, failed: 1, failures: [{ name: "t", message: "m" }], durationMs: 1 } };
      if (tool === "list_files" && ++polls === 1) return { briefings: [approvedBriefing] };
      return undefined;
    });
    const ai = new FakeOpenAI([
      { tool: "run_tests", args: {} },
      { tool: "declare_intent", args: declareArgs },
      { text: "giving up 1" },
      { text: "giving up 2" },
      { text: "giving up 3" },
      { text: "giving up 4" },
      { text: "giving up 5" },
    ]);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), conflictPollMs: 5, conflictWaitMs: 1000 });
    expect(res.status).toBe("done");
    expect(res.finalMessage).toBe("giving up 5");
    expect(ai.requests).toHaveLength(7);
    expect(ai.requests[3]!.body.messages.at(-1)!.content).toContain("is now approved");
    for (const i of [4, 5, 6]) expect(ai.requests[i]!.body.messages.at(-1)!.content).toMatch(/^Hive: tests are still red/);
    expect(hive.toolNames().filter((t) => t === "list_files")).toHaveLength(1);
  });

  it("signal abort while waiting -> stopped", async () => {
    const stop = new AbortController();
    const hive = new FakeHive((tool) => (tool === "declare_intent" ? { data: conflictData } : undefined));
    const ai = new FakeOpenAI([{ tool: "declare_intent", args: declareArgs }, { text: "Blocked." }]);
    setTimeout(() => stop.abort(), 15);
    const res = await runAgent({ ...base, client: hive, openai: ai.asOpenAI(), signal: stop.signal, conflictPollMs: 1000, conflictWaitMs: 5000 });
    expect(res.status).toBe("stopped");
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
