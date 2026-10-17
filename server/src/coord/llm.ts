import type { FeedEventBody, LLM } from "@hive/shared";

/** System prompts of the coord checks. OpenAILLM maps them to `purpose: "check:<what>"` for llm_call events. */
export const CHECK_PROMPTS = {
  contradiction: "You check if promised behaviors contradict. Answer JSON {conflict: boolean, with: string[], reason: string}.",
  meaning:
    "You summarize one code change for other engineers who depend on this code. One line, at most 160 characters, plain text, no markdown. Answer JSON {meaning: string}.",
} as const;

export type LLMTiming = { purpose: string; model: string; ms: number; tokensIn: number; tokensOut: number };

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface OpenAILLMOptions {
  apiKey: string;
  model: string;
  /** Emits llm_call feed events (purpose "check:<what>"). */
  onEvent?: (e: FeedEventBody) => void;
  /** Same data as a plain callback. */
  onCall?: (t: LLMTiming) => void;
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function purposeFor(system: string): string {
  for (const [what, prompt] of Object.entries(CHECK_PROMPTS)) if (system === prompt) return `check:${what}`;
  return "check:other";
}

/** Chat Completions over plain fetch, JSON mode, 20 s timeout, one retry on invalid JSON. */
export class OpenAILLM implements LLM {
  private readonly opts: Required<Pick<OpenAILLMOptions, "apiKey" | "model" | "timeoutMs" | "baseUrl">> & OpenAILLMOptions;

  constructor(opts: OpenAILLMOptions) {
    this.opts = {
      ...opts,
      timeoutMs: opts.timeoutMs ?? 20_000,
      baseUrl: opts.baseUrl ?? "https://api.openai.com/v1",
    };
  }

  async json<T>(system: string, user: string, shapeHint: string): Promise<T> {
    const purpose = purposeFor(system);
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: system },
      { role: "user", content: `${user}\n\nRespond with a single JSON object of this shape: ${shapeHint}` },
    ];
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = await this.call(messages, purpose);
      try {
        return JSON.parse(content) as T;
      } catch (e) {
        lastError = e;
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: `That was not valid JSON. Reply again with only a valid JSON object: ${shapeHint}` });
      }
    }
    throw new Error(`LLM returned invalid JSON twice: ${String(lastError)}`);
  }

  /** "low" by default; some models reject it (see CONTRACTS, agent loop), then we fall back to "none" and remember. */
  private effort: "low" | "none" = "low";

  private async call(messages: { role: string; content: string }[], purpose: string): Promise<string> {
    const fetchImpl: FetchLike = this.opts.fetchImpl ?? ((input, init) => fetch(input, init));
    const started = Date.now();
    const post = () =>
      fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          response_format: { type: "json_object" },
          reasoning_effort: this.effort,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    let res = await post();
    let text = await res.text();
    if (res.status === 400 && this.effort === "low" && /reasoning/i.test(text)) {
      this.effort = "none";
      res = await post();
      text = await res.text();
    }
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
    let parsed: { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`OpenAI returned a non-JSON body: ${text.slice(0, 300)}`);
    }
    const timing: LLMTiming = {
      purpose,
      model: this.opts.model,
      ms: Date.now() - started,
      tokensIn: parsed.usage?.prompt_tokens ?? 0,
      tokensOut: parsed.usage?.completion_tokens ?? 0,
    };
    this.opts.onCall?.(timing);
    this.opts.onEvent?.({ type: "llm_call", ...timing });
    return parsed.choices?.[0]?.message?.content ?? "";
  }
}

/** Test double: the responder returns the parsed object (or a promise of it). */
export class FakeLLM implements LLM {
  calls: { system: string; user: string; shapeHint: string }[] = [];

  constructor(private readonly responder: (system: string, user: string) => unknown) {}

  async json<T>(system: string, user: string, shapeHint: string): Promise<T> {
    this.calls.push({ system, user, shapeHint });
    return (await this.responder(system, user)) as T;
  }
}

/** Default when no key is configured: never a conflict, mechanical meaning. */
export function noopLLM(): FakeLLM {
  return new FakeLLM((system) => {
    if (system === CHECK_PROMPTS.contradiction) return { conflict: false, with: [], reason: "no LLM configured" };
    return { meaning: "" };
  });
}
