// Single source of truth for every format that crosses a package boundary.
// Change only with the human owner's approval (see CONTRACTS.md, "Change rule").

export type AgentId = string; // "agent-andrii"
export type HumanId = string; // "andrii"
export type IntentId = string; // "A1", "B2" (agent letter + counter)
export type Rev = number; // project-wide revision, +1 on every applied edit

export type HiveMode = "hive" | "naive" | "isolated";

// ---------- Code model ----------

export interface SymbolInfo {
  name: string; // "calculateTotal"
  kind: "function" | "class" | "const" | "type" | "interface";
  startLine: number; // 1-based, inclusive
  endLine: number;
  exported: boolean;
}

export interface CallSite {
  file: string;
  line: number;
  caller: string | null; // enclosing top-level symbol, null at module level
  callee: string; // called identifier name
}

export interface FileInfo {
  path: string; // "src/checkout.ts", always POSIX, relative to project root
  rev: Rev; // rev of the last edit that touched this file
}

// ---------- Intents ----------

export type IntentAction = "modify" | "add" | "delete";

export type IntentStatus =
  | "declared"
  | "approved"
  | "conflict"
  | "in_progress"
  | "done"
  | "verified"
  | "failed"
  | "cancelled";

export interface IntentInput {
  target: { file: string; symbol: string };
  action: IntentAction;
  what: string; // what I'm doing, 5..200 chars
  input: string; // inputs/params of the symbol after the change
  output: string; // promised output/behavior after the change, 10..300 chars
  check?: string; // optional vitest expect line(s) proving the output
}

export interface Intent extends IntentInput {
  id: IntentId;
  agentId: AgentId;
  humanId: HumanId;
  status: IntentStatus;
  createdAt: number;
  updatedAt: number;
  baseRev: Rev; // rev when declared
  endRev?: Rev; // rev when finished
}

export interface IntentConflict {
  intentId: IntentId; // the other intent
  kind: "same_target" | "contradiction";
  reason: string;
}

export interface DeclareIntentResult {
  intent: Intent;
  status: "approved" | "conflict";
  conflicts: IntentConflict[];
  dependents: AgentId[]; // agents that read or call the target and got a briefing
}

// ---------- Briefings and messages ----------

export type BriefingKind =
  | "intent_declared" // someone is about to change something you depend on
  | "symbol_changed" // something you read/call changed after you read it
  | "contract_changed" // a human edited a promised output
  | "intent_conflict" // your intent conflicts with another
  | "verification_failed" // an intent you depend on broke its promise
  | "culprit" // tests failed and your change (or pair) is the culprit
  | "message" // ask_agent from another agent
  | "human_note"; // note from a human

export interface Briefing {
  id: string; // "br_12"
  toAgent: AgentId;
  kind: BriefingKind;
  fromAgent?: AgentId;
  fromHuman?: HumanId;
  summary: string; // <= 400 chars, plain text, what changed and why it matters to YOU
  details: {
    file?: string;
    symbol?: string;
    intentId?: IntentId;
    diff?: string; // unified diff, <= 2000 chars
    yourUsages?: { file: string; line: number }[];
    failingTests?: { name: string; message: string }[];
    messageId?: string;
  };
  requiresAck: boolean;
  createdAt: number;
  ack?: BriefingAck;
}

export type AckResponse = "adapted" | "not_relevant" | "ask";

export interface BriefingAck {
  response: AckResponse;
  note?: string;
  at: number;
}

export interface AgentMessage {
  id: string; // "msg_3"
  from: AgentId | HumanId;
  to: AgentId;
  about: string; // symbol or intent id
  text: string;
  inReplyTo?: string;
  exchange: number; // 1..3, the 4th is routed to humans
  createdAt: number;
}

// ---------- Agent tool protocol ----------

export type AgentControl = "run" | "pause" | "stop";

// Lifecycle as reported by AgentManager. Terminal: stopped | done | budget | error.
export type AgentStatus = "idle" | "thinking" | "tool" | "paused" | "stopped" | "done" | "budget" | "error";
export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = ["stopped", "done", "budget", "error"];

// Every tool call returns this envelope. Pending briefings ride on it:
// this is how Hive injects context before the model's next step.
export interface ToolResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: ToolErrorCode; message: string; current?: string };
  briefings: Briefing[]; // all un-delivered briefings for this agent
  control: AgentControl;
  rev: Rev; // current project rev
}

export type ToolErrorCode =
  | "BAD_ARGS"
  | "NOT_FOUND"
  | "NO_INTENT"
  | "INTENT_NOT_APPROVED"
  | "NOT_YOUR_INTENT"
  | "OLD_TEXT_NOT_FOUND" // error.current = fresh content of the file
  | "OLD_TEXT_AMBIGUOUS"
  | "UNACKED_BRIEFINGS" // ack required briefings before editing
  | "NOT_OWNER" // path is outside this agent's `owns` list; error.message names the owner, ask them instead
  | "EXCHANGE_LIMIT"
  | "RUNNER_ERROR"
  | "INTERNAL";

export interface ToolArgs {
  list_files: Record<string, never>;
  read_file: { path: string; startLine?: number; endLine?: number };
  declare_intent: IntentInput;
  // intentId is required by the server in `hive` mode (NO_INTENT otherwise) and ignored in naive/isolated.
  edit_region: { intentId?: IntentId; path: string; oldText: string; newText: string };
  create_file: { intentId?: IntentId; path: string; content: string };
  finish_intent: { intentId: IntentId };
  run_command: { cmd: string; timeoutSec?: number };
  run_tests: { filter?: string };
  ack_briefing: { briefingId: string; response: AckResponse; note?: string };
  ask_agent: { to: AgentId; about: string; question: string };
  reply: { messageId: string; text: string };
}

export type ToolName = keyof ToolArgs;

export interface ToolResults {
  // Presence: who is working in a file right now (active intents), so agents can plan around each other.
  list_files: { files: (FileInfo & { activeIntents?: { id: IntentId; agentId: AgentId; symbol: string }[] })[] };
  read_file: {
    path: string; rev: Rev; content: string; symbols: SymbolInfo[];
    activeIntents?: { id: IntentId; agentId: AgentId; humanId: HumanId; symbol: string; status: IntentStatus; what: string; output: string }[];
    note?: string;
  };
  declare_intent: DeclareIntentResult;
  edit_region: { path: string; rev: Rev };
  create_file: { path: string; rev: Rev };
  finish_intent: { intent: Intent };
  run_command: CmdResult;
  // run_tests judges the caller on its own view: green snapshot + finished change sets + the caller's open edits,
  // other agents' in-progress edits excluded. `view` and `note` describe that; POST /api/test uses the live store.
  run_tests: TestResult & {
    view?: { finishedSets: IntentId[]; ownOpenIntents: IntentId[]; excludedInProgress: { intentId: IntentId; agentId: AgentId; files: string[] }[] };
    note?: string;
  };
  ack_briefing: { briefingId: string };
  ask_agent: { messageId: string };
  reply: { messageId: string };
}

// ---------- History ----------

export interface ChangeSet {
  id: IntentId; // one change set per intent
  agentId: AgentId;
  humanId: HumanId;
  what: string;
  files: string[];
  // Each edit of this intent as its own small unified patch, in the order applied.
  // Patches are made against different intermediate states, so they must be applied
  // one by one in order (jsdiff applyPatch tolerates line offsets), never merged into one.
  edits: { path: string; patch: string }[];
  patch: string; // display only: combined diff for the UI, never applied
  baseRev: Rev;
  endRev: Rev;
  added: number;
  removed: number;
}

export interface Snapshot {
  rev: Rev;
  files: Record<string, string>;
  green: boolean;
  at: number;
}

// ---------- Runner ----------

export interface CmdResult {
  exitCode: number;
  stdout: string; // truncated to 8000 chars
  stderr: string; // truncated to 8000 chars
  durationMs: number;
  vmId?: string;
}

export interface TestResult {
  ok: boolean;
  passed: number;
  failed: number;
  failures: { name: string; message: string }[];
  durationMs: number;
  vmId?: string;
}

export interface Runner {
  runTests(files: Record<string, string>, opts?: { filter?: string; timeoutSec?: number }): Promise<TestResult>;
  runCommand(files: Record<string, string>, cmd: string, timeoutSec?: number): Promise<CmdResult>;
}

export interface CulpritVariant {
  label: string; // "green+A1", "all-B1" (ASCII plus/hyphen only)
  applied: IntentId[];
  ok: boolean;
  applyError?: string; // patch did not apply alone
}

export interface CulpritReport {
  kind: "single" | "pair" | "dependent" | "unknown";
  culprits: IntentId[];
  greenRev: Rev;
  variants: CulpritVariant[];
  durationMs: number;
}

// ---------- LLM ----------

export interface LLM {
  // Returns parsed JSON that matches the described shape; throws on invalid JSON after 1 retry.
  json<T>(system: string, user: string, shapeHint: string): Promise<T>;
}

// ---------- Feed (server -> web, over /ws/feed) ----------

export type FeedEvent = { id: number; ts: number } & (
  | { type: "agent_status"; agentId: AgentId; humanId: HumanId; status: AgentStatus; task?: string; step?: number }
  | { type: "file_read"; agentId: AgentId; path: string; rev: Rev }
  | { type: "intent_declared"; intent: Intent; conflicts: IntentConflict[]; dependents: AgentId[] }
  | { type: "intent_status"; intentId: IntentId; status: IntentStatus }
  | { type: "edit_applied"; agentId: AgentId | HumanId; intentId?: IntentId; path: string; rev: Rev; added: number; removed: number }
  | { type: "briefing_sent"; briefing: Briefing }
  | { type: "briefing_acked"; briefingId: string; agentId: AgentId; ack: BriefingAck }
  | { type: "message_sent"; message: AgentMessage }
  | { type: "test_run_started"; runId: string; rev: Rev; reason: string }
  | { type: "test_run_finished"; runId: string; rev: Rev; result: TestResult }
  | { type: "culprit_search_started"; searchId: string; suspects: IntentId[] }
  | { type: "culprit_variant_result"; searchId: string; variant: CulpritVariant }
  | { type: "culprit_found"; searchId: string; report: CulpritReport }
  | { type: "human_action"; humanId: HumanId; action: string; target?: string }
  | { type: "llm_call"; purpose: string; model: string; ms: number; tokensIn: number; tokensOut: number }
);

export type FeedEventBody = FeedEvent extends infer E ? (E extends { id: number; ts: number } ? Omit<E, "id" | "ts"> : never) : never;

// ---------- Initial state for the web (GET /api/state) ----------

export interface HiveState {
  mode: HiveMode;
  rev: Rev;
  files: FileInfo[];
  // owns: optional file-ownership zones given at POST /api/agents ({ agentId, humanId, task, owns?: string[] }).
  // When present, declare_intent/edit_region/create_file outside these paths fail with NOT_OWNER.
  // color: assigned by the server in order of start; the same color is used for the agent's Yjs awareness cursor.
  agents: { agentId: AgentId; humanId: HumanId; status: AgentStatus; task?: string; control: AgentControl; owns?: string[]; color?: string }[];
  intents: Intent[];
  history: ChangeSet[];
  lastGreen?: { rev: Rev; at: number };
  recentEvents: FeedEvent[]; // last 200
  previewSiteUrl?: string; // public Freestyle preview site, when HIVE_PREVIEW_SITE=1
}

// ---------- Ports and env ----------

export const PORTS = { server: 4317, web: 5173 } as const;
export const ENV = {
  OPENAI_API_KEY: "OPENAI_API_KEY",
  FREESTYLE_API_KEY: "FREESTYLE_API_KEY",
  HIVE_RUNNER: "HIVE_RUNNER", // "local" | "freestyle", default "local"
  HIVE_MODE: "HIVE_MODE", // HiveMode, default "hive"
  HIVE_MODEL_AGENT: "HIVE_MODEL_AGENT", // default "gpt-5.4-mini"
  HIVE_MODEL_CHECK: "HIVE_MODEL_CHECK", // default "gpt-5.4-nano"
  HIVE_PROJECT_DIR: "HIVE_PROJECT_DIR", // initial files, default "../demo-app"
  PORT: "PORT", // server port, default 4317 (bench starts extra servers on 4318+)
} as const;

// ---------- Extra endpoints used by the bench ----------

export interface TestRequest {
  extraFiles?: Record<string, string>; // e.g. scenario acceptance tests, added only for this run
  filter?: string;
}

export interface MergeResult {
  ok: boolean; // false if any textual conflict markers were written
  conflicts: { path: string }[];
  rev: Rev;
}
