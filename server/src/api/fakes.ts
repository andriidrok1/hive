// In-memory implementations of the module interfaces in deps.ts.
// Coord and runner stand-ins that follow CONTRACTS.md closely enough to boot the server and run
// the API tests before (or without) the real modules. Core (ProjectStore, ReadLog, History) is real.
import type {
  AgentId,
  AgentMessage,
  Briefing,
  BriefingAck,
  CallSite,
  ChangeSet,
  CmdResult,
  DeclareIntentResult,
  FeedEventBody,
  FileInfo,
  HiveMode,
  HumanId,
  Intent,
  IntentConflict,
  IntentId,
  IntentInput,
  IntentStatus,
  Rev,
  Runner,
  Snapshot,
  SymbolInfo,
  TestResult,
} from "@hive/shared";
import {
  badArgs,
  type BriefingQueueLike,
  type CallGraphLike,
  type ChangeWatcherLike,
  type HistoryLike,
  type IntentRegistryLike,
  type MailboxLike,
  type ProjectStoreLike,
  type ProjectStoreOptions,
  type ReadLogLike,
  type StoreChange,
  type TestOrchestratorLike,
} from "./deps.js";

const OWN_ORIGIN = "hive";

// ---------- coord ----------

const SYMBOL_RE = /^export\s+(?:async\s+)?(function|class|const|let|type|interface)\s+([A-Za-z_$][\w$]*)|^(?:async\s+)?(function|class|const|let|type|interface)\s+([A-Za-z_$][\w$]*)/;

/** Regex-based stand-in for coord.analyzeFile: top-level declarations and identifier calls. */
export function fakeAnalyzeFile(path: string, content: string): { symbols: SymbolInfo[]; calls: CallSite[] } {
  const lines = content.split("\n");
  const starts: { name: string; kind: SymbolInfo["kind"]; line: number; exported: boolean }[] = [];
  lines.forEach((line, i) => {
    const m = SYMBOL_RE.exec(line);
    if (!m) return;
    const exported = m[1] !== undefined;
    const rawKind = (m[1] ?? m[3]) as string;
    const name = (m[2] ?? m[4]) as string;
    const kind: SymbolInfo["kind"] = rawKind === "let" ? "const" : (rawKind as SymbolInfo["kind"]);
    if (!exported && (kind === "const" || kind === "type" || kind === "interface")) return;
    starts.push({ name, kind, line: i + 1, exported });
  });
  const symbols: SymbolInfo[] = starts.map((s, idx) => {
    const next = starts[idx + 1];
    let endLine = next ? next.line - 1 : lines.length;
    while (endLine > s.line && (lines[endLine - 1] ?? "").trim() === "") endLine--;
    return { name: s.name, kind: s.kind, startLine: s.line, endLine, exported: s.exported };
  });
  const names = new Set(symbols.map((s) => s.name));
  const calls: CallSite[] = [];
  lines.forEach((line, i) => {
    const re = /([A-Za-z_$][\w$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const callee = m[1] as string;
      if (["if", "for", "while", "switch", "function", "return", "catch"].includes(callee)) continue;
      const enclosing = symbols.find((s) => s.startLine <= i + 1 && s.endLine >= i + 1);
      if (enclosing && enclosing.name === callee && enclosing.startLine === i + 1) continue; // the declaration itself
      calls.push({ file: path, line: i + 1, caller: enclosing?.name ?? null, callee });
    }
  });
  void names;
  return { symbols, calls };
}

export class FakeCallGraph implements CallGraphLike {
  private readonly perFile = new Map<string, { content: string; symbols: SymbolInfo[]; calls: CallSite[] }>();

  constructor(private readonly analyze: (path: string, content: string) => { symbols: SymbolInfo[]; calls: CallSite[] } = fakeAnalyzeFile) {}

  update(files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith(".ts")) continue;
      const cached = this.perFile.get(path);
      if (cached && cached.content === content) continue;
      this.perFile.set(path, { content, ...this.analyze(path, content) });
    }
    for (const path of [...this.perFile.keys()]) if (!(path in files)) this.perFile.delete(path);
  }

  callersOf(symbol: string): CallSite[] {
    const out: CallSite[] = [];
    for (const f of this.perFile.values()) for (const c of f.calls) if (c.callee === symbol) out.push(c);
    return out;
  }

  symbolAt(path: string, line: number): SymbolInfo | null {
    return this.perFile.get(path)?.symbols.find((s) => s.startLine <= line && s.endLine >= line) ?? null;
  }
}

export class FakeBriefingQueue implements BriefingQueueLike {
  private readonly items: (Briefing & { delivered: boolean })[] = [];
  private seq = 0;
  private readonly onEvent: ((e: FeedEventBody) => void) | undefined;

  constructor(opts: { onEvent?: (e: FeedEventBody) => void } = {}) {
    this.onEvent = opts.onEvent;
  }

  push(b: Omit<Briefing, "id" | "createdAt">): Briefing {
    const briefing: Briefing & { delivered: boolean } = { ...b, id: `br_${++this.seq}`, createdAt: Date.now(), delivered: false };
    this.items.push(briefing);
    this.onEvent?.({ type: "briefing_sent", briefing: strip(briefing) });
    return strip(briefing);
  }

  takeUndelivered(agentId: AgentId): Briefing[] {
    const out: Briefing[] = [];
    for (const b of this.items) {
      if (b.toAgent !== agentId || b.delivered) continue;
      b.delivered = true;
      out.push(strip(b));
    }
    return out;
  }

  unackedRequired(agentId: AgentId): Briefing[] {
    return this.items.filter((b) => b.toAgent === agentId && b.requiresAck && !b.ack).map(strip);
  }

  ack(agentId: AgentId, briefingId: string, ack: Omit<BriefingAck, "at">): boolean {
    const b = this.items.find((x) => x.id === briefingId);
    if (!b || b.toAgent !== agentId) return false;
    b.ack = { ...ack, at: Date.now() };
    this.onEvent?.({ type: "briefing_acked", briefingId, agentId, ack: b.ack });
    return true;
  }

  all(): Briefing[] {
    return this.items.map(strip);
  }
}

function strip(b: Briefing & { delivered: boolean }): Briefing {
  const { delivered: _d, ...rest } = b;
  return rest;
}

const VAGUE = new Set(["works", "done", "fixed", "updated", "ok", "good"]);

export class FakeIntentRegistry implements IntentRegistryLike {
  private readonly intents = new Map<IntentId, Intent>();
  private readonly counters = new Map<string, number>();
  private readonly reads: ReadLogLike;
  private readonly briefings: BriefingQueueLike;
  private readonly onEvent: (e: FeedEventBody) => void;
  private readonly mode: HiveMode;

  constructor(deps: { reads: ReadLogLike; briefings: BriefingQueueLike; onEvent: (e: FeedEventBody) => void; mode: HiveMode; graph?: CallGraphLike }) {
    this.reads = deps.reads;
    this.briefings = deps.briefings;
    this.onEvent = deps.onEvent;
    this.mode = deps.mode;
  }

  async declare(agentId: AgentId, humanId: HumanId, input: IntentInput, rev: Rev): Promise<DeclareIntentResult> {
    if (!input.what || input.what.length < 5 || input.what.length > 200) throw badArgs("what must be 5..200 chars");
    if (!input.output || input.output.length < 10 || input.output.length > 300) throw badArgs("output must be 10..300 chars");
    const words = input.output.toLowerCase().split(/\W+/).filter(Boolean);
    if (words.length > 0 && words.every((w) => VAGUE.has(w))) throw badArgs("output is too vague");
    const now = Date.now();
    const intent: Intent = { ...input, id: this.nextId(agentId), agentId, humanId, status: "declared", createdAt: now, updatedAt: now, baseRev: rev };
    this.intents.set(intent.id, intent);
    const conflicts: IntentConflict[] = [];
    const dependents: AgentId[] = [];
    if (this.mode === "hive") {
      for (const other of this.intents.values()) {
        if (other.agentId === agentId || other.id === intent.id) continue;
        if (!["approved", "in_progress"].includes(other.status)) continue;
        if (other.target.file === input.target.file && other.target.symbol === input.target.symbol) {
          conflicts.push({ intentId: other.id, kind: "same_target", reason: `${other.agentId} is already changing ${input.target.symbol} (${other.id})` });
        }
      }
      for (const r of this.reads.readersOf(input.target.file, input.target.symbol)) {
        if (r.agentId === agentId || dependents.includes(r.agentId)) continue;
        dependents.push(r.agentId);
      }
    }
    intent.status = conflicts.length > 0 ? "conflict" : "approved";
    for (const c of conflicts) {
      const other = this.intents.get(c.intentId);
      for (const target of [intent, other]) {
        if (!target) continue;
        this.briefings.push({
          toAgent: target.agentId,
          kind: "intent_conflict",
          fromAgent: target === intent ? other?.agentId : agentId,
          summary: `Intent ${intent.id} conflicts with ${c.intentId}: ${c.reason}`,
          details: { file: input.target.file, symbol: input.target.symbol, intentId: target === intent ? c.intentId : intent.id },
          requiresAck: true,
        });
      }
    }
    for (const dep of dependents) {
      this.briefings.push({
        toAgent: dep,
        kind: "intent_declared",
        fromAgent: agentId,
        summary: `${agentId} is about to ${input.action} ${input.target.symbol} in ${input.target.file}: ${input.output}`,
        details: { file: input.target.file, symbol: input.target.symbol, intentId: intent.id },
        requiresAck: true,
      });
    }
    this.onEvent({ type: "intent_declared", intent: { ...intent }, conflicts, dependents });
    return { intent: { ...intent }, status: intent.status as "approved" | "conflict", conflicts, dependents };
  }

  get(id: IntentId): Intent | undefined {
    const i = this.intents.get(id);
    return i ? { ...i } : undefined;
  }

  list(): Intent[] {
    return [...this.intents.values()].map((i) => ({ ...i }));
  }

  setStatus(id: IntentId, status: IntentStatus): void {
    const i = this.intents.get(id);
    if (!i) return;
    i.status = status;
    i.updatedAt = Date.now();
    if (["done", "verified"].includes(status) && i.endRev === undefined) i.endRev = i.updatedAt;
    this.onEvent({ type: "intent_status", intentId: id, status });
    if (["done", "verified", "cancelled", "failed"].includes(status)) this.reapprove(i);
  }

  canEdit(agentId: AgentId, intentId: IntentId) {
    const i = this.intents.get(intentId);
    if (!i) return { ok: false as const, code: "NO_INTENT" as const };
    if (i.agentId !== agentId) return { ok: false as const, code: "NOT_YOUR_INTENT" as const };
    if (i.status !== "approved" && i.status !== "in_progress") return { ok: false as const, code: "INTENT_NOT_APPROVED" as const };
    return { ok: true as const };
  }

  humanEditOutput(humanId: HumanId, intentId: IntentId, newOutput: string): void {
    const i = this.intents.get(intentId);
    if (!i) throw badArgs(`unknown intent ${intentId}`);
    const old = i.output;
    i.output = newOutput;
    i.updatedAt = Date.now();
    const targets = new Set<AgentId>([i.agentId]);
    for (const r of this.reads.readersOf(i.target.file, i.target.symbol)) targets.add(r.agentId);
    for (const to of targets) {
      this.briefings.push({
        toAgent: to,
        kind: "contract_changed",
        fromHuman: humanId,
        summary: `${humanId} changed the promised output of ${intentId} (${i.target.symbol}): "${old}" -> "${newOutput}"`,
        details: { file: i.target.file, symbol: i.target.symbol, intentId },
        requiresAck: true,
      });
    }
    this.onEvent({ type: "human_action", humanId, action: "edit_output", target: intentId });
  }

  resolveConflict(humanId: HumanId, keepIntentId: IntentId, cancelIntentId: IntentId): void {
    this.onEvent({ type: "human_action", humanId, action: "resolve_conflict", target: `${keepIntentId}/${cancelIntentId}` });
    this.setStatus(cancelIntentId, "cancelled");
    const keep = this.intents.get(keepIntentId);
    if (keep && keep.status === "conflict") this.setStatus(keepIntentId, "approved");
  }

  private reapprove(finished: Intent): void {
    for (const other of this.intents.values()) {
      if (other.status !== "conflict" || other.id === finished.id) continue;
      const stillBlocked = [...this.intents.values()].some(
        (x) => x.id !== other.id && x.agentId !== other.agentId && ["approved", "in_progress"].includes(x.status) && x.target.file === other.target.file && x.target.symbol === other.target.symbol,
      );
      if (stillBlocked) continue;
      other.status = "approved";
      other.updatedAt = Date.now();
      this.onEvent({ type: "intent_status", intentId: other.id, status: "approved" });
      this.briefings.push({
        toAgent: other.agentId,
        kind: "intent_conflict",
        summary: `Intent ${other.id} is approved now: the conflicting intent ${finished.id} is ${finished.status}.`,
        details: { file: other.target.file, symbol: other.target.symbol, intentId: other.id },
        requiresAck: false,
      });
    }
  }

  private nextId(agentId: AgentId): IntentId {
    const letter = (agentId.replace(/^agent-/, "")[0] ?? "x").toUpperCase();
    const n = (this.counters.get(letter) ?? 0) + 1;
    this.counters.set(letter, n);
    return `${letter}${n}`;
  }
}

export class FakeChangeWatcher implements ChangeWatcherLike {
  readonly seen: StoreChange[] = [];
  async onEdit(change: StoreChange): Promise<void> {
    this.seen.push(change);
  }
}

export class FakeMailbox implements MailboxLike {
  private readonly messages = new Map<string, AgentMessage & { root: string }>();
  private readonly exchanges = new Map<string, number>();
  private readonly escalated: AgentMessage[] = [];
  private seq = 0;

  constructor(private readonly deps: { briefings: BriefingQueueLike; onEvent: (e: FeedEventBody) => void }) {}

  ask(from: AgentId | HumanId, to: AgentId, about: string, question: string): AgentMessage | { error: "EXCHANGE_LIMIT" } {
    const id = `msg_${++this.seq}`;
    return this.deliver({ id, from, to, about, text: question, exchange: 1, createdAt: Date.now() }, id);
  }

  reply(from: AgentId | HumanId, messageId: string, text: string): AgentMessage | { error: "NOT_FOUND" | "EXCHANGE_LIMIT" } {
    const parent = this.messages.get(messageId);
    if (!parent) return { error: "NOT_FOUND" };
    const exchange = (this.exchanges.get(parent.root) ?? 0) + 1;
    const msg: AgentMessage = { id: `msg_${++this.seq}`, from, to: parent.from, about: parent.about, text, inReplyTo: messageId, exchange, createdAt: Date.now() };
    if (exchange > 3) {
      this.escalated.push(msg);
      return { error: "EXCHANGE_LIMIT" };
    }
    return this.deliver(msg, parent.root);
  }

  forHumans(): AgentMessage[] {
    return this.escalated.slice();
  }

  private deliver(msg: AgentMessage, root: string): AgentMessage {
    this.messages.set(msg.id, { ...msg, root });
    this.exchanges.set(root, msg.exchange);
    this.deps.briefings.push({
      toAgent: msg.to,
      kind: "message",
      fromAgent: msg.from,
      summary: `${msg.from} about ${msg.about}: ${msg.text}`,
      details: { messageId: msg.id },
      requiresAck: false,
    });
    this.deps.onEvent({ type: "message_sent", message: msg });
    return msg;
  }
}

// ---------- runner ----------

export class FakeRunner implements Runner {
  readonly testCalls: { files: Record<string, string>; opts?: { filter?: string; timeoutSec?: number } }[] = [];
  readonly commandCalls: { files: Record<string, string>; cmd: string; timeoutSec?: number }[] = [];
  result: TestResult = { ok: true, passed: 1, failed: 0, failures: [], durationMs: 1 };

  async runTests(files: Record<string, string>, opts?: { filter?: string; timeoutSec?: number }): Promise<TestResult> {
    this.testCalls.push(opts ? { files, opts } : { files });
    return { ...this.result, failures: [...this.result.failures] };
  }

  async runCommand(files: Record<string, string>, cmd: string, timeoutSec?: number): Promise<CmdResult> {
    this.commandCalls.push(timeoutSec !== undefined ? { files, cmd, timeoutSec } : { files, cmd });
    return { exitCode: 0, stdout: `fake: ${cmd}`, stderr: "", durationMs: 1 };
  }
}

/** Runs the suite once per finished intent, marks it verified/failed, keeps a green snapshot. No culprit search. */
export class FakeTestOrchestrator implements TestOrchestratorLike {
  readonly finished: IntentId[] = [];
  private seq = 0;

  constructor(
    private readonly deps: {
      store: Pick<ProjectStoreLike, "allFiles" | "rev">;
      history: HistoryLike;
      intents: IntentRegistryLike;
      runner: Runner;
      onEvent: (e: FeedEventBody) => void;
      mode: HiveMode;
    },
  ) {}

  async onIntentFinished(intentId: IntentId): Promise<void> {
    this.finished.push(intentId);
    const runId = `run_${++this.seq}`;
    const rev = this.deps.store.rev;
    this.deps.onEvent({ type: "test_run_started", runId, rev, reason: `intent ${intentId} finished` });
    const result = await this.deps.runner.runTests(this.deps.store.allFiles());
    this.deps.onEvent({ type: "test_run_finished", runId, rev, result });
    if (result.ok) {
      this.deps.history.saveSnapshot(true);
      this.deps.intents.setStatus(intentId, "verified");
    } else {
      this.deps.intents.setStatus(intentId, "failed");
    }
  }
}

// ---------- module set for hive.ts ----------

export function fakeModules() {
  return {
    CallGraph: FakeCallGraph,
    BriefingQueue: FakeBriefingQueue,
    IntentRegistry: FakeIntentRegistry,
    ChangeWatcher: FakeChangeWatcher,
    Mailbox: FakeMailbox,
    TestOrchestrator: FakeTestOrchestrator,
    analyzeFile: fakeAnalyzeFile,
  };
}

/** LLM that never sees a conflict and echoes a generic meaning. Used when OPENAI_API_KEY is unset. */
export class NoConflictLLM {
  async json<T>(_system: string, _user: string, _shapeHint: string): Promise<T> {
    return { conflict: false, with: [], reason: "no LLM configured", meaning: "changed (no LLM configured)" } as T;
  }
}
