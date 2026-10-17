// Structural interfaces for everything the API layer consumes from other server modules.
// They mirror CONTRACTS.md ("Server modules and their interfaces"). The real classes from
// server/src/core, coord and runner satisfy them structurally; tests use small fakes.
import type * as Y from "yjs";
import type {
  AgentControl,
  AgentId,
  AgentMessage,
  AgentStatus,
  Briefing,
  BriefingAck,
  CallSite,
  ChangeSet,
  DeclareIntentResult,
  FeedEventBody,
  FileInfo,
  HiveMode,
  HumanId,
  Intent,
  IntentId,
  IntentInput,
  IntentStatus,
  Rev,
  Runner,
  Snapshot,
  SymbolInfo,
  ToolArgs,
  ToolName,
  ToolResponse,
  ToolResults,
} from "@hive/shared";
import type { Emitter } from "../emit.js";

// ---------- core (brief 01) ----------

export interface StoreChange {
  path: string;
  rev: Rev;
  actor: string;
  intentId?: IntentId;
  before: string;
  after: string;
}

export type EditRegionResult =
  | { ok: true; rev: Rev; added: number; removed: number }
  | { ok: false; code: "NOT_FOUND" | "OLD_TEXT_NOT_FOUND" | "OLD_TEXT_AMBIGUOUS"; current?: string };

export interface ProjectStoreLike {
  readonly ydoc: Y.Doc;
  readonly rev: Rev;
  loadFiles(files: Record<string, string>): void;
  listFiles(): FileInfo[];
  readFile(path: string): { content: string; rev: Rev } | null;
  allFiles(): Record<string, string>;
  editRegion(args: { actor: string; intentId?: IntentId; path: string; oldText: string; newText: string }): EditRegionResult;
  createFile(args: { actor: string; intentId?: IntentId; path: string; content: string }): { ok: true; rev: Rev } | { ok: false; code: "BAD_ARGS" };
  humanReplaceFile(humanId: HumanId, path: string, content: string): { rev: Rev };
  onChange(cb: (c: StoreChange) => void): () => void;
}

export interface ProjectStoreOptions {
  onEvent?: (e: FeedEventBody) => void;
  resolveActor?: (origin: unknown) => string;
}

export interface ReadLogLike {
  record(agentId: AgentId, path: string, rev: Rev, symbols: string[]): void;
  readsOf(agentId: AgentId): { path: string; rev: Rev; symbols: string[] }[];
  readersOf(path: string, symbol?: string): { agentId: AgentId; rev: Rev }[];
}

export interface HistoryLike {
  beginIntent(intent: Intent): void;
  recordEdit(change: { path: string; intentId?: IntentId; before: string; after: string; rev: Rev }): void;
  finishIntent(intentId: IntentId): ChangeSet;
  changeSets(): ChangeSet[];
  saveSnapshot(green: boolean): Snapshot;
  lastGreen(): Snapshot | undefined;
  changeSetsSince(rev: Rev): ChangeSet[];
}

// ---------- coord (brief 02) ----------

export type AnalyzeFile = (path: string, content: string) => { symbols: SymbolInfo[]; calls: CallSite[] };

export interface CallGraphLike {
  update(files: Record<string, string>): void;
  callersOf(symbol: string): CallSite[];
  symbolAt(path: string, line: number): SymbolInfo | null;
}

export type CanEditResult = { ok: true } | { ok: false; code: "NO_INTENT" | "INTENT_NOT_APPROVED" | "NOT_YOUR_INTENT" };

export interface IntentRegistryLike {
  declare(agentId: AgentId, humanId: HumanId, input: IntentInput, rev: Rev): Promise<DeclareIntentResult>;
  get(id: IntentId): Intent | undefined;
  list(): Intent[];
  setStatus(id: IntentId, status: IntentStatus, opts?: { rev?: Rev }): void;
  canEdit(agentId: AgentId, intentId: IntentId): CanEditResult;
  humanEditOutput(humanId: HumanId, intentId: IntentId, newOutput: string): void;
  resolveConflict(humanId: HumanId, keepIntentId: IntentId, cancelIntentId: IntentId): void;
}

export interface BriefingQueueLike {
  push(b: Omit<Briefing, "id" | "createdAt">): Briefing;
  takeUndelivered(agentId: AgentId): Briefing[];
  unackedRequired(agentId: AgentId): Briefing[];
  ack(agentId: AgentId, briefingId: string, ack: Omit<BriefingAck, "at">): boolean;
  all(): Briefing[];
}

export interface ChangeWatcherLike {
  onEdit(change: StoreChange): Promise<void>;
}

export interface MailboxLike {
  ask(from: AgentId | HumanId, to: AgentId, about: string, question: string): AgentMessage | { error: "EXCHANGE_LIMIT" };
  reply(from: AgentId | HumanId, messageId: string, text: string): AgentMessage | { error: "NOT_FOUND" | "EXCHANGE_LIMIT" };
  forHumans(): AgentMessage[];
}

// ---------- runner (brief 04) ----------

export interface TestOrchestratorLike {
  onIntentFinished(intentId: IntentId): Promise<void>;
}

// ---------- agents (brief 03, server/src/agents) ----------

export interface AgentRecord {
  agentId: AgentId;
  humanId: HumanId;
  status: AgentStatus;
  task?: string;
  control: AgentControl;
}

export interface AgentManagerLike {
  /** Makes an agent known to the tool API without running a loop (external agents, tests). */
  register(agentId: AgentId, humanId: HumanId): AgentRecord;
  get(agentId: AgentId): AgentRecord | undefined;
  list(): AgentRecord[];
  start(input: { agentId: AgentId; humanId: HumanId; task: string }): { ok: true } | { ok: false; code: "ALREADY_RUNNING" };
  control(agentId: AgentId, control: AgentControl): boolean;
  controlOf(agentId: AgentId): AgentControl;
  note(agentId: AgentId, humanId: HumanId, text: string, urgent: boolean): boolean;
  stopAll(): Promise<void>;
}

// In-process client handed to the agent loop (mirrors HiveClient from @hive/agent).
export interface ToolCaller {
  call<T extends ToolName>(agentId: AgentId, tool: T, args: ToolArgs[T]): Promise<ToolResponse<ToolResults[T]>>;
}

// ---------- the whole wired hive ----------

export interface HiveDeps {
  mode: HiveMode;
  emitter: Emitter;
  store: ProjectStoreLike;
  reads: ReadLogLike;
  history: HistoryLike;
  graph: CallGraphLike;
  briefings: BriefingQueueLike;
  intents: IntentRegistryLike;
  watcher: ChangeWatcherLike;
  mailbox: MailboxLike;
  orchestrator: TestOrchestratorLike;
  runner: Runner;
  analyzeFile: AnalyzeFile;
  /** Files loaded at start (and restored by /api/reset). */
  initialFiles: Record<string, string>;
  /** Builds an empty store; isolated mode uses it for per-agent copies. */
  createStore(opts?: ProjectStoreOptions): ProjectStoreLike;
}

/**
 * What buildApp needs: the current deps plus a way to rebuild them (POST /api/reset).
 * `deps` is replaced on reset, so route handlers always read `ctx.deps` at call time.
 */
export interface HiveContext {
  deps: HiveDeps;
  agents: AgentManagerLike;
  reset(mode?: HiveMode): Promise<void>;
}

export function badArgs(message: string): Error & { code: "BAD_ARGS" } {
  return Object.assign(new Error(message), { code: "BAD_ARGS" as const });
}
