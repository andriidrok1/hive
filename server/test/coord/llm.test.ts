import { describe, expect, it } from "vitest";
import { CHECK_PROMPTS, FakeLLM, OpenAILLM, noopLLM } from "../../src/coord/llm.js";
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
    const llm = new OpenAILLM({ apiKey: "sk-test", model: "gpt-5.4-nano", fetchImpl: f.fetchImpl, onEvent: sink.onEvent, onCall: (t) => timings.push(t) });
    const out = await llm.json<{ conflict: boolean }>(CHECK_PROMPTS.contradiction, "intents...", "{conflict: boolean, with: string[], reason: string}");
    expect(out).toEqual({ conflict: false, with: [], reason: "fine" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer sk-test");
    expect(f.calls[0]?.body).toMatchObject({ model: "gpt-5.4-nano", response_format: { type: "json_object" }, reasoning_effort: "low" });
    const messages = f.calls[0]?.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: CHECK_PROMPTS.contradiction });
    expect(messages[1]?.content).toContain("{conflict: boolean, with: string[], reason: string}");
    expect(sink.ofType("llm_call")).toEqual([{ type: "llm_call", purpose: "check:contradiction", model: "gpt-5.4-nano", ms: expect.any(Number), tokensIn: 11, tokensOut: 7 }]);
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
    expect(await noopLLM().json(CHECK_PROMPTS.meaning, "x", "")).toEqual({ meaning: "" });
  });
});
