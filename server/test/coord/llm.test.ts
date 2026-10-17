import { describe, expect, it } from "vitest";
import { CHECK_PROMPTS, DEFAULT_CONTRADICTION_MODEL, FakeLLM, OpenAILLM, noopLLM } from "../../src/coord/llm.js";
import { eventSink } from "./fakes.js";

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function fakeFetch(responses: (string | { status: number; body: string })[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = responses.shift();
    if (next === undefined) throw new Error("no more fake responses");
    const r = typeof next === "string" ? { status: 200, body: next } : next;
    return { ok: r.status < 400, status: r.status, text: async () => r.body };
  };
  return { calls, fetchImpl };
}

const completion = (content: string, tokens = [11, 7]) => JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: tokens[0], completion_tokens: tokens[1] } });

describe("OpenAILLM (mocked fetch)", () => {
  it("16a. valid JSON on the first try; sends JSON mode, low reasoning, the key, and reports timing", async () => {
    const sink = eventSink();
    const timings: unknown[] = [];
    const f = fakeFetch([completion('{"conflict":false,"with":[],"reason":"fine"}')]);
    const llm = new OpenAILLM({ apiKey: "sk-test", model: "gpt-5.4-nano", contradictionModel: DEFAULT_CONTRADICTION_MODEL, fetchImpl: f.fetchImpl, onEvent: sink.onEvent, onCall: (t) => timings.push(t) });
    const out = await llm.json<{ conflict: boolean }>(CHECK_PROMPTS.contradiction, "intents...", "{conflict: boolean, with: string[], reason: string}");
    expect(out).toEqual({ conflict: false, with: [], reason: "fine" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer sk-test");
    // the contradiction check goes to the stronger default model, not the cheap `model`
    expect(f.calls[0]?.body).toMatchObject({ model: DEFAULT_CONTRADICTION_MODEL, response_format: { type: "json_object" }, reasoning_effort: "low" });
    const messages = f.calls[0]?.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: CHECK_PROMPTS.contradiction });
    expect(messages[1]?.content).toContain("{conflict: boolean, with: string[], reason: string}");
    expect(sink.ofType("llm_call")).toEqual([{ type: "llm_call", purpose: "check:contradiction", model: DEFAULT_CONTRADICTION_MODEL, ms: expect.any(Number), tokensIn: 11, tokensOut: 7 }]);
    expect(timings).toHaveLength(1);
  });

  it("16b. invalid JSON then valid JSON: one retry with the bad answer in context", async () => {
    const sink = eventSink();
    const f = fakeFetch([completion("I think yes"), completion('{"meaning":"adds tax"}')]);
    const llm = new OpenAILLM({ apiKey: "k", model: "m", fetchImpl: f.fetchImpl, onEvent: sink.onEvent });
    expect(await llm.json(CHECK_PROMPTS.meaning, "diff", "{meaning: string}")).toEqual({ meaning: "adds tax" });
    expect(f.calls).toHaveLength(2);
    const retry = f.calls[1]?.body.messages as { role: string; content: string }[];
    expect(retry).toHaveLength(4);
    expect(retry[2]).toEqual({ role: "assistant", content: "I think yes" });
    expect(retry[3]?.content).toMatch(/not valid JSON/);
    expect(sink.ofType("llm_call").map((e) => e.purpose)).toEqual(["check:meaning", "check:meaning"]);
  });

  it("16d. falls back to reasoning_effort none when the API rejects low, and remembers it", async () => {
    const f = fakeFetch([
      { status: 400, body: '{"error":{"message":"Unsupported value: reasoning_effort does not support low with this model"}}' },
      completion('{"meaning":"ok"}'),
      completion('{"meaning":"again"}'),
    ]);
    const llm = new OpenAILLM({ apiKey: "k", model: "m", fetchImpl: f.fetchImpl });
    expect(await llm.json(CHECK_PROMPTS.meaning, "d", "{meaning: string}")).toEqual({ meaning: "ok" });
    expect(await llm.json(CHECK_PROMPTS.meaning, "d", "{meaning: string}")).toEqual({ meaning: "again" });
    expect(f.calls.map((c) => c.body.reasoning_effort)).toEqual(["low", "none", "none"]);
  });

  it("16e. the contradiction check uses the stronger contradictionModel; meaning keeps the cheap model; effort fallback is per model", async () => {
    const sink = eventSink();
    const f = fakeFetch([
      { status: 400, body: '{"error":{"message":"reasoning_effort low unsupported"}}' },
      completion('{"conflict":true,"with":["A1"],"reason":"double tax"}'),
      completion('{"meaning":"m","behaviorChanged":false}'),
      completion('{"conflict":false,"with":[],"reason":""}'),
    ]);
    const llm = new OpenAILLM({ apiKey: "k", model: "gpt-5.4-nano", contradictionModel: "gpt-5.4-mini", fetchImpl: f.fetchImpl, onEvent: sink.onEvent });
    expect(llm.modelFor("check:contradiction")).toBe("gpt-5.4-mini");
    expect(llm.modelFor("check:meaning")).toBe("gpt-5.4-nano");
    await llm.json(CHECK_PROMPTS.contradiction, "x", "{}");
    await llm.json(CHECK_PROMPTS.meaning, "x", "{}");
    await llm.json(CHECK_PROMPTS.contradiction, "x", "{}");
    expect(f.calls.map((c) => [c.body.model, c.body.reasoning_effort])).toEqual([
      ["gpt-5.4-mini", "low"],
      ["gpt-5.4-mini", "none"],
      ["gpt-5.4-nano", "low"],
      ["gpt-5.4-mini", "none"],
    ]);
    expect(sink.ofType("llm_call").map((e) => [e.purpose, e.model])).toEqual([
      ["check:contradiction", "gpt-5.4-mini"],
      ["check:meaning", "gpt-5.4-nano"],
      ["check:contradiction", "gpt-5.4-mini"],
    ]);
    // default comes from the env, else gpt-5.4-mini
    const prev = process.env.HIVE_MODEL_CONTRADICTION;
    delete process.env.HIVE_MODEL_CONTRADICTION;
    expect(new OpenAILLM({ apiKey: "k", model: "m" }).modelFor("check:contradiction")).toBe(DEFAULT_CONTRADICTION_MODEL);
    process.env.HIVE_MODEL_CONTRADICTION = "gpt-5.4";
    expect(new OpenAILLM({ apiKey: "k", model: "m" }).modelFor("check:contradiction")).toBe("gpt-5.4");
    if (prev === undefined) delete process.env.HIVE_MODEL_CONTRADICTION;
    else process.env.HIVE_MODEL_CONTRADICTION = prev;
  });

  it("16c. invalid JSON twice throws; HTTP errors throw with the status", async () => {
    const f = fakeFetch([completion("nope"), completion("still nope")]);
    const llm = new OpenAILLM({ apiKey: "k", model: "m", fetchImpl: f.fetchImpl });
    await expect(llm.json("other system prompt", "u", "{}")).rejects.toThrow(/invalid JSON twice/);

    const g = fakeFetch([{ status: 429, body: '{"error":"rate limited"}' }]);
    const llm2 = new OpenAILLM({ apiKey: "k", model: "m", fetchImpl: g.fetchImpl });
    await expect(llm2.json("s", "u", "{}")).rejects.toThrow(/HTTP 429/);
  });
});

describe("FakeLLM", () => {
  it("returns the responder's value and records calls; noopLLM never conflicts", async () => {
    const llm = new FakeLLM((system, user) => ({ echo: `${system}|${user}` }));
    expect(await llm.json("s", "u", "{echo}")).toEqual({ echo: "s|u" });
    expect(llm.calls).toEqual([{ system: "s", user: "u", shapeHint: "{echo}" }]);
    expect(await noopLLM().json(CHECK_PROMPTS.contradiction, "x", "")).toMatchObject({ conflict: false });
    expect(await noopLLM().json(CHECK_PROMPTS.meaning, "x", "")).toEqual({ meaning: "", behaviorChanged: true });
  });
});
