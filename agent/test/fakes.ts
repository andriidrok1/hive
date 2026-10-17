import type OpenAI from "openai";
import type { AgentControl, Briefing, ToolArgs, ToolName, ToolResponse, ToolResults } from "@hive/shared";
import type { HiveClient } from "../src/index.js";

// ---------- Fake OpenAI ----------

export type Step =
  | { tool: ToolName | string; args: unknown; usage?: [number, number] }
  | { text: string; usage?: [number, number] }
  | { error: Error }
  | { onCall: (body: OpenAI.Chat.ChatCompletionCreateParams, opts?: { signal?: AbortSignal }) => Promise<OpenAI.Chat.ChatCompletion> };

export function completion(message: OpenAI.Chat.ChatCompletionMessage, usage: [number, number] = [10, 5]): OpenAI.Chat.ChatCompletion {
  return {
    id: "cmpl_fake",
    object: "chat.completion",
    created: 0,
    model: "fake",
    choices: [{ index: 0, message, finish_reason: message.tool_calls?.length ? "tool_calls" : "stop", logprobs: null }],
    usage: { prompt_tokens: usage[0], completion_tokens: usage[1], total_tokens: usage[0] + usage[1] },
  };
}

export function toolCallMessage(id: string, name: string, args: string): OpenAI.Chat.ChatCompletionMessage {
  return { role: "assistant", content: null, refusal: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] };
}

export class FakeOpenAI {
  requests: { body: OpenAI.Chat.ChatCompletionCreateParams; signal?: AbortSignal }[] = [];
  private i = 0;
  constructor(private steps: Step[]) {}

  chat = {
    completions: {
      create: async (body: OpenAI.Chat.ChatCompletionCreateParams, opts?: { signal?: AbortSignal }): Promise<OpenAI.Chat.ChatCompletion> => {
        this.requests.push({ body: structuredClone(body), signal: opts?.signal }); // snapshot: the loop mutates messages in place
        const step = this.steps[this.i++];
        if (!step) throw new Error(`FakeOpenAI: no scripted step for request #${this.i}`);
        if ("onCall" in step) return step.onCall(body, opts);
        if ("error" in step) throw step.error;
        if ("text" in step) return completion({ role: "assistant", content: step.text, refusal: null }, step.usage);
        const args = typeof step.args === "string" ? step.args : JSON.stringify(step.args);
        return completion(toolCallMessage(`call_${this.i}`, step.tool, args), step.usage);
      },
    },
  };

  asOpenAI(): OpenAI {
    return this as unknown as OpenAI;
  }
}

// ---------- Fake HiveClient ----------

export interface Recorded {
  tool: ToolName;
  args: unknown;
}

type Handler = <T extends ToolName>(tool: T, args: ToolArgs[T], n: number) => Partial<ToolResponse<unknown>> | undefined;

export class FakeHive implements HiveClient {
  calls: Recorded[] = [];
  rev = 1;
  control: AgentControl = "run";
  // Briefings queued for the next response of any tool.
  queued: Briefing[] = [];
  constructor(private handler?: Handler) {}

  async call<T extends ToolName>(tool: T, args: ToolArgs[T]): Promise<ToolResponse<ToolResults[T]>> {
    this.calls.push({ tool, args });
    const n = this.calls.length;
    const extra = this.handler?.(tool, args, n) ?? {};
    const briefings = this.queued;
    this.queued = [];
    const base: ToolResponse<ToolResults[T]> = {
      ok: true,
      data: defaultData(tool, args) as ToolResults[T],
      briefings,
      control: this.control,
      rev: this.rev,
    };
    return { ...base, ...extra } as ToolResponse<ToolResults[T]>;
  }

  toolNames(): ToolName[] {
    return this.calls.map((c) => c.tool);
  }
}

function defaultData(tool: ToolName, args: unknown): unknown {
  const a = args as Record<string, unknown>;
  switch (tool) {
    case "list_files":
      return { files: [{ path: "src/checkout.ts", rev: 1 }] };
    case "read_file":
      return { path: a.path, rev: 1, content: "export function x() {}\n", symbols: [] };
    case "declare_intent":
      return { intent: { id: "A1", status: "approved" }, status: "approved", conflicts: [], dependents: [] };
    case "edit_region":
    case "create_file":
      return { path: a.path, rev: 2 };
    case "finish_intent":
      return { intent: { id: a.intentId, status: "done" } };
    case "run_tests":
      return { ok: true, passed: 3, failed: 0, failures: [], durationMs: 10 };
    case "run_command":
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 };
    case "ack_briefing":
      return { briefingId: a.briefingId };
    case "ask_agent":
    case "reply":
      return { messageId: "msg_1" };
  }
}

export function briefing(partial: Partial<Briefing> & { id: string }): Briefing {
  return {
    toAgent: "agent-a",
    kind: "symbol_changed",
    fromAgent: "agent-masha",
    summary: "calculateTotal now returns total WITH tax. You call it at src/tax.ts:14.",
    details: { file: "src/checkout.ts", symbol: "calculateTotal" },
    requiresAck: true,
    createdAt: 0,
    ...partial,
  };
}
