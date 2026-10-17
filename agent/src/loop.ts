import type OpenAI from "openai";
import type { AgentId, Briefing, HiveMode, HumanId, Rev, ToolArgs, ToolName, ToolResponse } from "@hive/shared";
import type { HiveClient } from "./client.js";
import { systemPrompt } from "./prompt.js";
import { TOOL_NAMES, TOOL_SCHEMAS, isToolName } from "./tools.js";

export type AgentEvent = { type: "llm_call" | "tool_call" | "status"; [k: string]: unknown };

export interface RunOptions {
  agentId: AgentId;
  humanId: HumanId;
  task: string;
  client: HiveClient;
  openai?: OpenAI; // injected for tests
  model?: string; // default env HIVE_MODEL_AGENT or "gpt-5.4-mini"
  maxToolCalls?: number; // 40
  maxMs?: number; // 15 min
  maxTokens?: number; // 400k
  signal?: AbortSignal; // stop for good: once aborted the run ends with status "stopped"
  interrupt?: { current(): AbortSignal }; // urgent human note: fetched fresh before EVERY model call
  onEvent?: (e: AgentEvent) => void;
  mode?: HiveMode; // "naive"/"isolated" use a prompt without intents
  pauseMs?: number; // poll interval while control is "pause", default 2000 (tests use a small value)
}

export interface RunResult {
  status: "done" | "stopped" | "budget" | "error";
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  finalMessage?: string;
  error?: string;
}

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULTS = { maxToolCalls: 40, maxMs: 15 * 60_000, maxTokens: 400_000, pauseMs: 2000 } as const;

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

export function formatBriefings(briefings: Briefing[]): string {
  const lines = ["HIVE BRIEFINGS (you must handle these before editing again):"];
  for (const b of briefings) {
    const from = b.fromAgent ?? b.fromHuman;
    const where = [b.details.file, b.details.symbol].filter(Boolean).join(" ");
    lines.push(`[${b.id}] ${b.kind}${from ? ` from ${from}` : ""}${where ? ` (${where})` : ""}: ${b.summary}`);
    if (b.details.yourUsages?.length) lines.push(`  your usages: ${b.details.yourUsages.map((u) => `${u.file}:${u.line}`).join(", ")}`);
    if (b.details.failingTests?.length) lines.push(`  failing tests: ${b.details.failingTests.map((t) => `${t.name}: ${t.message}`).join("; ").slice(0, 600)}`);
    if (b.details.diff) lines.push(`  diff:\n${b.details.diff.split("\n").map((l) => `    ${l}`).join("\n")}`);
    if (b.details.messageId) lines.push(`  -> reply with messageId ${b.details.messageId}`);
    if (b.requiresAck) lines.push(`  -> call ack_briefing with adapted | not_relevant | ask`);
  }
  return lines.join("\n");
}

function errorEnvelope(code: "BAD_ARGS" | "INTERNAL", message: string, rev: Rev): ToolResponse {
  return { ok: false, error: { code, message }, briefings: [], control: "run", rev };
}

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: unknown }).name;
  return name === "AbortError" || name === "APIUserAbortError";
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const start = Date.now();
  const mode: HiveMode = opts.mode ?? "hive";
  const model = opts.model ?? process.env.HIVE_MODEL_AGENT ?? DEFAULT_MODEL;
  const maxToolCalls = opts.maxToolCalls ?? DEFAULTS.maxToolCalls;
  const maxMs = opts.maxMs ?? DEFAULTS.maxMs;
  const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
  const pauseMs = opts.pauseMs ?? DEFAULTS.pauseMs;
  const { client, signal, interrupt, onEvent } = opts;

  let openai = opts.openai;
  if (!openai) {
    const { default: OpenAIClient } = await import("openai");
    openai = new OpenAIClient({ apiKey: process.env.OPENAI_API_KEY ?? "" });
  }

  const messages: Msg[] = [
    { role: "system", content: systemPrompt(mode, opts.agentId, opts.humanId) },
    { role: "user", content: `Task from ${opts.humanId}:\n${opts.task}` },
  ];

  let toolCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let step = 0;
  let lastRev: Rev = 0;
  // Briefings collected outside a tool message (pause polls, interrupt pick-up) go to the model as a user message.
  let pending: Briefing[] = [];

  const elapsed = () => Date.now() - start;
  const emit = (e: AgentEvent) => onEvent?.({ agentId: opts.agentId, ...e });
  const finish = (status: RunResult["status"], extra: Partial<RunResult> = {}): RunResult => {
    emit({ type: "status", status, step });
    return { status, toolCalls, tokensIn, tokensOut, ms: elapsed(), ...extra };
  };

  // Out-of-band tool call (pause polling, interrupt pick-up). Returns the control value or null on failure.
  async function poke(): Promise<ToolResponse | null> {
    try {
      const r = await client.call("list_files", {});
      lastRev = r.rev;
      if (r.briefings.length) pending.push(...r.briefings);
      return r;
    } catch (e) {
      emit({ type: "tool_call", tool: "list_files", ok: false, error: errMessage(e), outOfBand: true });
      return null;
    }
  }

  // One model-emitted tool call -> ToolResponse envelope. Never throws: parse and transport
  // errors become ok:false envelopes so the model can recover.
  async function executeToolCall(call: OpenAI.Chat.ChatCompletionMessageToolCall): Promise<ToolResponse> {
    if (call.type !== "function") {
      return errorEnvelope("BAD_ARGS", `unsupported tool call type ${String((call as { type: string }).type)}`, lastRev);
    }
    const name = call.function.name;
    let args: unknown;
    try {
      args = call.function.arguments.trim() === "" ? {} : JSON.parse(call.function.arguments);
    } catch (e) {
      return errorEnvelope("BAD_ARGS", `tool arguments are not valid JSON: ${errMessage(e)}`, lastRev);
    }
    if (!isToolName(name)) {
      return errorEnvelope("BAD_ARGS", `unknown tool ${name}; available: ${TOOL_NAMES.join(", ")}`, lastRev);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return errorEnvelope("BAD_ARGS", "tool arguments must be a JSON object", lastRev);
    }
    emit({ type: "status", status: "tool", step, tool: name });
    const t1 = Date.now();
    let response: ToolResponse;
    try {
      response = await client.call(name, args as ToolArgs[ToolName]);
      lastRev = response.rev;
    } catch (e) {
      response = errorEnvelope("INTERNAL", `tool call failed: ${errMessage(e)}`, lastRev);
    }
    emit({ type: "tool_call", tool: name, ok: response.ok, code: response.error?.code, ms: Date.now() - t1, step, briefings: response.briefings.length });
    return response;
  }

  // Blocks while control is "pause". Returns "run" to continue or "stop".
  async function handleControl(control: ToolResponse["control"]): Promise<"run" | "stop"> {
    if (control === "run") return "run";
    if (control === "stop") return "stop";
    emit({ type: "status", status: "paused", step });
    for (;;) {
      await sleep(pauseMs, signal);
      if (signal?.aborted) return "stop";
      if (elapsed() > maxMs) return "run"; // let the budget check end the run
      const r = await poke();
      if (!r) continue;
      if (r.control === "run") {
        emit({ type: "status", status: "thinking", step });
        return "run";
      }
      if (r.control === "stop") return "stop";
    }
  }

  for (;;) {
    if (signal?.aborted) return finish("stopped");
    if (toolCalls >= maxToolCalls) return finish("budget", { error: `tool call budget (${maxToolCalls}) exhausted` });
    if (elapsed() >= maxMs) return finish("budget", { error: `time budget (${maxMs} ms) exhausted` });
    if (tokensIn + tokensOut >= maxTokens) return finish("budget", { error: `token budget (${maxTokens}) exhausted` });

    if (pending.length) {
      messages.push({ role: "user", content: formatBriefings(pending) });
      pending = [];
    }

    // Fresh interrupt signal before EVERY model call; never reuse an aborted one.
    const interruptSignal = interrupt?.current();
    const parts = [signal, interruptSignal].filter((s): s is AbortSignal => !!s);
    const callSignal = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : AbortSignal.any(parts);

    step += 1;
    emit({ type: "status", status: "thinking", step });
    const t0 = Date.now();
    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await openai.chat.completions.create(
        { model, messages, tools: TOOL_SCHEMAS, parallel_tool_calls: false, reasoning_effort: "low" },
        { signal: callSignal, timeout: Math.max(5_000, maxMs - elapsed()) },
      );
    } catch (e) {
      const ms = Date.now() - t0;
      emit({ type: "llm_call", model, ms, tokensIn: 0, tokensOut: 0, step, error: errMessage(e) });
      if (signal?.aborted) return finish("stopped");
      if (interruptSignal?.aborted || (isAbortError(e) && interruptSignal)) {
        // Urgent human note: pick it up as a briefing, then redo this step with a fresh interrupt signal.
        const r = await poke();
        if (r && (await handleControl(r.control)) === "stop") return finish("stopped");
        continue;
      }
      if (isAbortError(e)) return finish("stopped");
      return finish("error", { error: errMessage(e) });
    }
    const ms = Date.now() - t0;
    const usage = completion.usage;
    const inTok = usage?.prompt_tokens ?? 0;
    const outTok = usage?.completion_tokens ?? 0;
    tokensIn += inTok;
    tokensOut += outTok;
    emit({ type: "llm_call", model, ms, tokensIn: inTok, tokensOut: outTok, step });

    const choice = completion.choices[0];
    if (!choice) return finish("error", { error: "model returned no choices" });
    const msg = choice.message;
    const calls = msg.tool_calls ?? [];
    const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: "assistant", content: msg.content ?? null };
    if (calls.length) assistant.tool_calls = calls;
    messages.push(assistant);

    if (calls.length === 0) return finish("done", { finalMessage: msg.content ?? "" });

    let control: ToolResponse["control"] = "run";
    for (const call of calls) {
      toolCalls += 1;
      const response = await executeToolCall(call);
      let content = JSON.stringify(response);
      if (response.briefings.length) content += `\n\n${formatBriefings(response.briefings)}`;
      messages.push({ role: "tool", tool_call_id: call.id, content });
      if (response.control !== "run") control = response.control;
      if (response.control === "stop") break;
      if (toolCalls >= maxToolCalls) break;
    }

    if ((await handleControl(control)) === "stop") return finish("stopped");
  }
}
