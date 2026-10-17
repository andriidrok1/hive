# Brief 05: agent loop on OpenAI

You own `agent/`. Read `CONTRACTS.md` and `shared/src/contracts.ts`. Do not edit any `package.json`: dependencies (`openai` official SDK, `vitest`) are pre-installed, run `npm ci` at the worktree root. No other package's files. Check the installed `openai` SDK version's types for the exact names of `reasoning_effort` and `parallel_tool_calls` rather than guessing.

## Goal

A reusable agent loop: one human's coding agent working through Hive tools only. The server (brief 03) runs it in-process; the bench (brief 07) runs it too.

## Public API (`agent/src/index.ts`)

```ts
export interface HiveClient {
  call<T extends ToolName>(tool: T, args: ToolArgs[T]): Promise<ToolResponse<ToolResults[T]>>;
}
export function httpClient(baseUrl: string, agentId: AgentId): HiveClient; // POST /api/agents/:id/tools/:tool
export interface RunOptions {
  agentId: AgentId; humanId: HumanId; task: string;
  client: HiveClient;
  openai?: OpenAI;                 // injected for tests
  model?: string;                  // default env HIVE_MODEL_AGENT or "gpt-5.4-mini"
  maxToolCalls?: number;           // 40
  maxMs?: number;                  // 15 min
  maxTokens?: number;              // 400k
  signal?: AbortSignal;            // urgent human note aborts current model call
  onEvent?: (e: { type: "llm_call" | "tool_call" | "status"; [k: string]: unknown }) => void;
  mode?: HiveMode;                 // "naive"/"isolated" use a prompt without intents
}
export interface RunResult { status: "done" | "stopped" | "budget" | "error"; toolCalls: number; tokensIn: number; tokensOut: number; ms: number; finalMessage?: string; error?: string }
export function runAgent(opts: RunOptions): Promise<RunResult>;
export const TOOL_SCHEMAS: OpenAI.Chat.ChatCompletionTool[];   // 11 tools, JSON schema per ToolArgs
export function systemPrompt(mode: HiveMode, agentId: AgentId, humanId: HumanId): string;
```

## Loop

1. Messages: system prompt + user task.
2. Call Chat Completions with `tools: TOOL_SCHEMAS`, `parallel_tool_calls: false`, `reasoning_effort: "low"`, `signal`. Measure ms and tokens, `onEvent({type:"llm_call"})`.
3. No tool calls → done with final message.
4. For each tool call: parse args (invalid JSON → tool message with a BAD_ARGS-style error), call `client.call`, append a tool message whose content is `JSON.stringify(response)` plus, if `response.briefings.length`, a block:

```
HIVE BRIEFINGS (you must handle these before editing again):
[br_7] symbol_changed from agent-masha: calculateTotal now returns total WITH tax. You call it at src/tax.ts:14.
  -> call ack_briefing with adapted | not_relevant | ask
```
5. `control: "pause"` → poll a cheap tool (`list_files`) every 2s until `run` or `stop`; `stop` → status stopped.
6. Abort from `signal` mid-call → drop that model call, re-run the step (the urgent note will arrive as a briefing on the next tool call; to make it immediate, the loop calls `list_files` once after an abort).
7. Budgets → status `budget`.

## System prompt (hive mode), keep it under 350 words

- You are `<agentId>`, working for `<humanId>` in a shared live project with other people's agents.
- Only use the tools. Files change under you; always `read_file` right before editing.
- Before changing or adding any function: `declare_intent` with a precise `output` (what it returns, units, edge cases) and, when possible, a `check` (one or two vitest `expect(...)` lines).
- If `declare_intent` returns conflict: read the conflicting intent in the briefing, then `ask_agent` its owner or adapt your plan; do not edit until approved.
- Edit with `edit_region` using a small unique `oldText`. On `OLD_TEXT_NOT_FOUND`, use `error.current` and retry.
- After finishing a function: `finish_intent`. Run `run_tests` when you think your task is complete.
- Every briefing with requiresAck must get `ack_briefing` before your next edit: `adapted` (you changed your plan or code), `not_relevant` (explain in note), or `ask`.
- Never edit another agent's code just to make your tests pass; ask them.
- Stop when your task is done and tests are green; reply with a 3-line summary.

Naive/isolated mode prompt: same minus intents, acks and asking.

## Tests (all required, no network: fake OpenAI client returning scripted responses, fake HiveClient)

1. `TOOL_SCHEMAS` has 11 tools, names match `ToolName`, each schema's required fields match `ToolArgs`.
2. Scripted run: model calls read_file → declare_intent → edit_region → finish_intent → final text; client receives exactly those calls in order; status done.
3. Briefings in a tool response appear in the next model request as the `HIVE BRIEFINGS` block.
4. Invalid JSON tool args produce an error tool message and the loop continues.
5. `control: "pause"` then `run`: the loop waits and resumes; `stop` ends with status stopped.
6. Budget: maxToolCalls 3 → status budget after 3 tool calls.
7. Abort signal during a model call → the call is retried, no crash.
8. Token and ms accounting summed from usage fields.
9. `httpClient` posts to the right URL with the right body (mock `fetch`).
10. `systemPrompt("naive", ...)` does not mention intents.

Optional live test (`HIVE_LIVE=1` and `OPENAI_API_KEY` set): the loop against an in-memory fake HiveClient holding `tax.ts`; the briefing "calculateTotal now includes tax" leads to removing the extra multiplication (this already worked in a manual test with gpt-5.4-mini; latency was ~60s per call, so log per-call ms).

## Done

Tests pass and typecheck clean. First version (tests 1–3) in 30 minutes.
