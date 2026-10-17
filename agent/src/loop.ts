import type OpenAI from "openai";
import type { AgentId, Briefing, DeclareIntentResult, HiveMode, HumanId, IntentId, Rev, TestResult, ToolArgs, ToolName, ToolResponse } from "@hive/shared";
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
  // Contract says "low". The API rejects it for gpt-5.4-mini + function tools on Chat Completions
  // (400 "set reasoning_effort to 'none'"), so the loop falls back to "none" once per model and remembers it.
  reasoningEffort?: OpenAI.ReasoningEffort;
  // When the model gives up while one of its intents is still in conflict, the loop waits for the
  // server's approval briefing: poll list_files every conflictPollMs for up to conflictWaitMs (once per run).
  conflictWaitMs?: number; // 90_000
  conflictPollMs?: number; // 3_000
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
export const DEFAULT_REASONING_EFFORT: OpenAI.ReasoningEffort = "low";

// Per-process memory of models that rejected reasoning_effort with tools; keyed by model name.
const effortByModel = new Map<string, OpenAI.ReasoningEffort>();
export function resetReasoningEffortCache(): void {
  effortByModel.clear();
}

function rejectsReasoningEffort(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const status = (e as { status?: unknown }).status;
  const message = String((e as { message?: unknown }).message ?? "");
  return status === 400 && /reasoning_effort/i.test(message);
}
export const DEFAULTS = { maxToolCalls: 40, maxMs: 15 * 60_000, maxTokens: 300_000, pauseMs: 2000, conflictWaitMs: 90_000, conflictPollMs: 3_000 } as const;
// Red-tests nudges repeat up to MAX_RED_NUDGES while at least NUDGE_MIN_TOOL_CALLS calls and NUDGE_MIN_MS remain,
// and stop early once two consecutive nudges produced no edit_region/create_file call (the agent is spinning).
export const MAX_RED_NUDGES = 3;
export const NUDGE_MIN_TOOL_CALLS = 8;
export const NUDGE_MIN_MS = 60_000;

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
  const conflictWaitMs = opts.conflictWaitMs ?? DEFAULTS.conflictWaitMs;
  const conflictPollMs = opts.conflictPollMs ?? DEFAULTS.conflictPollMs;
  let reasoningEffort: OpenAI.ReasoningEffort = effortByModel.get(model) ?? opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
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
  // Extra user lines (culprit override, ...) delivered before the next model call.
  let pendingNotes: string[] = [];
  // For the nudges: last red/green test result seen (run_tests, or failing tests carried by a culprit /
  // verification_failed briefing), required briefings not yet acked, and how many nudges went out.
  let lastTests: TestResult | undefined;
  const unacked = new Map<string, Briefing>();
  const seenBriefings = new Map<string, Briefing>();
  const myIntents = new Set<IntentId>();
  let nudges = 0;
  const notOwner = new Map<string, number>(); // NOT_OWNER count per path; the 2nd one earns a "stop editing" line
  let edits = 0; // successful edit_region/create_file calls
  let editsAtLastNudge = 0;
  let idleNudges = 0; // consecutive nudges after which no edit followed
  // Intents this agent declared that came back "conflict", keyed by id, with their target so a
  // later approved re-declare of the same target clears them. Cleared by the server's intent_conflict
  // "now approved" briefing (requiresAck=false) as well.
  const conflicting = new Map<IntentId, { file: string; symbol: string }>();
  let waitedForConflict = false;

  function noteResponse(tool: ToolName, args: unknown, r: ToolResponse): void {
    for (const b of r.briefings) {
      seenBriefings.set(b.id, b);
      if (b.requiresAck && !b.ack) unacked.set(b.id, b);
      const id = b.details.intentId;
      if (b.kind === "intent_conflict" && id && conflicting.has(id) && (!b.requiresAck || /approved/i.test(b.summary))) conflicting.delete(id);
      if ((b.kind === "culprit" || b.kind === "verification_failed") && b.details.failingTests?.length) {
        const failures = b.details.failingTests;
        lastTests = { ok: false, passed: 0, failed: failures.length, failures, durationMs: 0 };
      }
    }
    if (!r.ok) {
      if (String(r.error?.code) === "NOT_OWNER") {
        const a = args as { path?: unknown; target?: { file?: unknown } };
        const path = typeof a.path === "string" ? a.path : typeof a.target?.file === "string" ? a.target.file : "";
        if (path) {
          const n = (notOwner.get(path) ?? 0) + 1;
          notOwner.set(path, n);
          if (n === 2) pendingNotes.push(`Hive: stop editing ${path}; it is not yours.`);
        }
      }
      return;
    }
    if (tool === "run_tests" && r.data && typeof r.data === "object" && "ok" in r.data) lastTests = r.data as TestResult;
    if (tool === "ack_briefing") unacked.delete(String((args as { briefingId?: unknown }).briefingId));
    if (tool === "edit_region" || tool === "create_file") edits += 1;
    if (tool === "declare_intent" && r.data && typeof r.data === "object" && "intent" in r.data) {
      const d = r.data as DeclareIntentResult;
      if (d.intent?.id) myIntents.add(d.intent.id);
      const target = d.intent?.target ?? (args as { target?: { file: string; symbol: string } }).target;
      if (d.status === "conflict" && d.intent?.id) conflicting.set(d.intent.id, { file: target?.file ?? "", symbol: target?.symbol ?? "" });
      if (d.status === "approved" && target) {
        for (const [id, t] of conflicting) if (t.file === target.file && t.symbol === target.symbol) conflicting.delete(id);
      }
    }
    if (tool === "finish_intent") conflicting.delete(String((args as { intentId?: unknown }).intentId));
  }

  // The model gave up while an intent of its own is still in conflict: wait for the server's approval
  // briefing. Returns the user message to continue with, or null to accept the final message.
  async function waitForConflict(): Promise<string | null | "stop"> {
    if (waitedForConflict || conflicting.size === 0) return null;
    const remaining = maxMs - elapsed();
    if (remaining <= conflictPollMs) return null;
    waitedForConflict = true;
    const ids = () => [...conflicting.keys()].join(", ");
    const deadline = Date.now() + Math.min(conflictWaitMs, remaining);
    emit({ type: "status", status: "thinking", step, waitingForIntents: ids() });
    while (Date.now() < deadline) {
      await sleep(Math.min(conflictPollMs, deadline - Date.now()), signal);
      if (signal?.aborted) return "stop";
      const r = await poke();
      if (!r) continue;
      if (r.control === "stop") return "stop";
      if (r.briefings.length) {
        // noteResponse (via poke) already cleared approved ids; the briefings themselves go out as pending.
        if (conflicting.size === 0) return `Hive: your intent ${r.briefings.map((b) => b.details.intentId).filter(Boolean).join(", ") || "in conflict"} is now approved; continue your task.`;
        return `Hive: a briefing arrived while your intent ${ids()} was in conflict; handle it and continue your task.`;
      }
    }
    return null;
  }

  // A culprit briefing that names one of this agent's intents (by details.intentId or by id in the summary).
  function culpritNamesMe(b: Briefing): boolean {
    if (b.kind !== "culprit") return false;
    if (b.details.intentId && myIntents.has(b.details.intentId)) return true;
    for (const id of myIntents) if (new RegExp(`\\b${id}\\b`).test(b.summary)) return true;
    return false;
  }

  // Called when the model answers without tool calls. Returns the nudge text, or null to accept the answer.
  // Red tests: up to MAX_RED_NUDGES while the budget allows. Unacked-only: once.
  function nudgeFor(): string | null {
    const red = !!lastTests && !lastTests.ok;
    const budgetOk = maxToolCalls - toolCalls >= NUDGE_MIN_TOOL_CALLS && maxMs - elapsed() >= NUDGE_MIN_MS;
    if (nudges > 0) idleNudges = edits > editsAtLastNudge ? 0 : idleNudges + 1;
    const spinning = idleNudges >= 2;
    const reasons: string[] = [];
    if (red && budgetOk && !spinning && nudges < MAX_RED_NUDGES && lastTests) {
      const names = lastTests.failures.map((f) => f.name).slice(0, 8).join(", ");
      reasons.push(`tests are still red (${lastTests.failed} failed${names ? `: ${names}` : ""})`);
    }
    if (unacked.size && (reasons.length || nudges === 0)) reasons.push(`briefings unacked (${[...unacked.keys()].join(", ")})`);
    if (!reasons.length) return null;
    nudges += 1;
    editsAtLastNudge = edits;
    const advice = red && budgetOk && !spinning
      ? "You may still edit; if the failing tests belong to another agent's area, ask them and wait, otherwise fix now."
      : "Call ack_briefing for each, then continue or finish.";
    return `Hive: ${reasons.join(" / ")}. ${advice}`;
  }

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
      noteResponse("list_files", {}, r);
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
    if (name === "ack_briefing") {
      const a = args as { briefingId?: unknown; response?: unknown; note?: unknown };
      const b = seenBriefings.get(String(a.briefingId));
      if (a.response === "not_relevant" && b && culpritNamesMe(b)) {
        // The model may not wave away a culprit report about its own change set: record as adapted and say so.
        args = { ...a, response: "adapted", note: `${typeof a.note === "string" && a.note ? `${a.note} ` : ""}[Hive: not_relevant overridden, culprit names this agent's change set]` };
        pendingNotes.push("Hive: the culprit report names your change set; fix or explain.");
        emit({ type: "tool_call", tool: name, overridden: "not_relevant->adapted", briefingId: b.id, step });
      }
    }
    emit({ type: "status", status: "tool", step, tool: name });
    const t1 = Date.now();
    let response: ToolResponse;
    try {
      response = await client.call(name, args as ToolArgs[ToolName]);
      lastRev = response.rev;
      noteResponse(name, args, response);
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
    if (pendingNotes.length) {
      messages.push({ role: "user", content: pendingNotes.join("\n") });
      pendingNotes = [];
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
        { model, messages, tools: TOOL_SCHEMAS, parallel_tool_calls: false, reasoning_effort: reasoningEffort },
        { signal: callSignal, timeout: Math.max(5_000, maxMs - elapsed()) },
      );
    } catch (e) {
      const ms = Date.now() - t0;
      emit({ type: "llm_call", model, ms, tokensIn: 0, tokensOut: 0, step, error: errMessage(e), reasoningEffort });
      if (reasoningEffort !== "none" && rejectsReasoningEffort(e)) {
        reasoningEffort = "none";
        effortByModel.set(model, "none");
        step -= 1;
        continue; // same step again without reasoning effort
      }
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
    emit({ type: "llm_call", model, ms, tokensIn: inTok, tokensOut: outTok, step, reasoningEffort });

    const choice = completion.choices[0];
    if (!choice) return finish("error", { error: "model returned no choices" });
    const msg = choice.message;
    const calls = msg.tool_calls ?? [];
    const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: "assistant", content: msg.content ?? null };
    if (calls.length) assistant.tool_calls = calls;
    messages.push(assistant);

    if (calls.length === 0) {
      const waited = await waitForConflict();
      if (waited === "stop") return finish("stopped");
      const nudge = waited ?? nudgeFor();
      if (!nudge) return finish("done", { finalMessage: msg.content ?? "" });
      emit({ type: "status", status: "thinking", step, nudge });
      if (pending.length) {
        // briefings picked up while waiting go first, then the continue line
        messages.push({ role: "user", content: formatBriefings(pending) });
        pending = [];
      }
      messages.push({ role: "user", content: nudge });
      continue;
    }

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
