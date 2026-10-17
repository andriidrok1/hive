// The 11 agent tools. Rules from CONTRACTS.md, applied in order:
// 1. unknown agent -> caller returns 404 (UnknownAgentError); bad args -> ok:false BAD_ARGS
// 2. execute
// 3. attach briefings (takeUndelivered, also on errors), control, rev
// 4. emit feed events (only the ones no module emits itself: file_read, test_run_* for agent runs)
import type {
  AckResponse,
  AgentId,
  Briefing,
  IntentId,
  IntentInput,
  Rev,
  SymbolInfo,
  TestResult,
  ToolArgs,
  ToolErrorCode,
  ToolName,
  ToolResponse,
  ToolResults,
} from "@hive/shared";
import { buildView } from "../core/index.js";
import type { HiveContext, ProjectStoreLike, ToolCaller } from "./deps.js";

export class UnknownAgentError extends Error {
  constructor(agentId: string) {
    super(`unknown agent ${agentId}`);
  }
}

// "NOT_OWNER" is being added to shared's ToolErrorCode; typed loosely here until it lands.
type ToolCode = ToolErrorCode | "NOT_OWNER";

class ToolError extends Error {
  constructor(
    readonly code: ToolCode,
    message: string,
    readonly current?: string,
  ) {
    super(message);
  }
}

export const TOOL_NAMES: readonly ToolName[] = [
  "list_files",
  "read_file",
  "declare_intent",
  "edit_region",
  "create_file",
  "finish_intent",
  "run_command",
  "run_tests",
  "ack_briefing",
  "ask_agent",
  "reply",
];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

// ---------- argument validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== "string") throw new ToolError("BAD_ARGS", `${k} must be a string`);
  return v;
};
const optStr = (o: Record<string, unknown>, k: string): string | undefined => {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError("BAD_ARGS", `${k} must be a string`);
  return v;
};
const optNum = (o: Record<string, unknown>, k: string): number | undefined => {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError("BAD_ARGS", `${k} must be a number`);
  return v;
};

function validate<T extends ToolName>(tool: T, raw: unknown): ToolArgs[T] {
  const o: Record<string, unknown> = isObj(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isObj(raw)) throw new ToolError("BAD_ARGS", "args must be an object");
  switch (tool) {
    case "list_files":
      return {} as ToolArgs[T];
    case "read_file": {
      const out: ToolArgs["read_file"] = { path: str(o, "path") };
      const s = optNum(o, "startLine");
      const e = optNum(o, "endLine");
      if (s !== undefined) out.startLine = s;
      if (e !== undefined) out.endLine = e;
      return out as ToolArgs[T];
    }
    case "declare_intent": {
      const target = o.target;
      if (!isObj(target)) throw new ToolError("BAD_ARGS", "target must be { file, symbol }");
      const action = str(o, "action");
      if (!["modify", "add", "delete"].includes(action)) throw new ToolError("BAD_ARGS", "action must be modify | add | delete");
      const out: IntentInput = {
        target: { file: str(target, "file"), symbol: str(target, "symbol") },
        action: action as IntentInput["action"],
        what: str(o, "what"),
        input: optStr(o, "input") ?? "",
        output: str(o, "output"),
      };
      const check = optStr(o, "check");
      if (check !== undefined) out.check = check;
      return out as ToolArgs[T];
    }
    case "edit_region": {
      const out: ToolArgs["edit_region"] = { path: str(o, "path"), oldText: str(o, "oldText"), newText: str(o, "newText") };
      const id = optStr(o, "intentId");
      if (id !== undefined) out.intentId = id;
      return out as ToolArgs[T];
    }
    case "create_file": {
      const out: ToolArgs["create_file"] = { path: str(o, "path"), content: str(o, "content") };
      const id = optStr(o, "intentId");
      if (id !== undefined) out.intentId = id;
      return out as ToolArgs[T];
    }
    case "finish_intent":
      return { intentId: str(o, "intentId") } as ToolArgs[T];
    case "run_command": {
      const out: ToolArgs["run_command"] = { cmd: str(o, "cmd") };
      const t = optNum(o, "timeoutSec");
      if (t !== undefined) out.timeoutSec = t;
      return out as ToolArgs[T];
    }
    case "run_tests": {
      const out: ToolArgs["run_tests"] = {};
      const f = optStr(o, "filter");
      if (f !== undefined) out.filter = f;
      return out as ToolArgs[T];
    }
    case "ack_briefing": {
      const response = str(o, "response");
      if (!["adapted", "not_relevant", "ask"].includes(response)) throw new ToolError("BAD_ARGS", "response must be adapted | not_relevant | ask");
      const out: ToolArgs["ack_briefing"] = { briefingId: str(o, "briefingId"), response: response as AckResponse };
      const note = optStr(o, "note");
      if (note !== undefined) out.note = note;
      return out as ToolArgs[T];
    }
    case "ask_agent":
      return { to: str(o, "to"), about: str(o, "about"), question: str(o, "question") } as ToolArgs[T];
    case "reply":
      return { messageId: str(o, "messageId"), text: str(o, "text") } as ToolArgs[T];
    default:
      throw new ToolError("BAD_ARGS", `unknown tool ${String(tool)}`);
  }
}

// ---------- handlers ----------

export interface ToolHandlers extends ToolCaller {
  /** Same as call() but with unvalidated args (HTTP body). */
  callRaw(agentId: AgentId, tool: ToolName, args: unknown): Promise<ToolResponse>;
  /** Store an agent acts on: the main one, or its private copy in isolated mode. */
  storeFor(agentId: AgentId): ProjectStoreLike;
  /** Isolated mode: agent copies in start order with the base they were copied from. */
  copies(): { agentId: AgentId; store: ProjectStoreLike; base: Record<string, string> }[];
  /** Hook for AgentManager: called before every tool executes (status "tool"). */
  onToolCall?: (agentId: AgentId, tool: ToolName) => void;
}

export function toolHandlers(ctx: HiveContext): ToolHandlers {
  // Isolated-mode copies are tied to the deps they were made for; a reset drops them.
  const copiesByDeps = new WeakMap<object, Map<AgentId, { store: ProjectStoreLike; base: Record<string, string>; order: number }>>();
  let copySeq = 0;

  const copyMap = () => {
    let m = copiesByDeps.get(ctx.deps);
    if (!m) {
      m = new Map();
      copiesByDeps.set(ctx.deps, m);
    }
    return m;
  };

  const storeFor = (agentId: AgentId): ProjectStoreLike => {
    const d = ctx.deps;
    if (d.mode !== "isolated") return d.store;
    const m = copyMap();
    let entry = m.get(agentId);
    if (!entry) {
      const base = d.store.allFiles();
      const store = d.createStore({ onEvent: (e) => d.emitter.emit(e) });
      store.loadFiles(base);
      store.onChange((c) => d.history.recordEdit(c));
      entry = { store, base, order: copySeq++ };
      m.set(agentId, entry);
    }
    return entry.store;
  };

  const handlers: ToolHandlers = {
    storeFor,
    copies() {
      return [...copyMap().entries()].sort((a, b) => a[1].order - b[1].order).map(([agentId, e]) => ({ agentId, store: e.store, base: e.base }));
    },
    async call(agentId, tool, args) {
      return (await handlers.callRaw(agentId, tool, args)) as ToolResponse<ToolResults[typeof tool]>;
    },
    async callRaw(agentId, tool, rawArgs) {
      const agent = ctx.agents.get(agentId);
      if (!agent) throw new UnknownAgentError(agentId);
      const d = ctx.deps;
      const envelope = (): { briefings: Briefing[]; control: ToolResponse["control"]; rev: Rev } => ({
        briefings: d.briefings.takeUndelivered(agentId),
        control: ctx.agents.controlOf(agentId),
        rev: storeFor(agentId).rev,
      });
      try {
        const args = validate(tool, rawArgs);
        handlers.onToolCall?.(agentId, tool);
        const data = await execute(ctx, handlers, agentId, agent.humanId, tool, args);
        return { ok: true, data, ...envelope() };
      } catch (err) {
        const e = toToolError(err);
        const error: ToolResponse["error"] = { code: e.code as ToolErrorCode, message: e.message };
        if (e.current !== undefined) error.current = e.current;
        return { ok: false, error, ...envelope() };
      }
    },
  };
  return handlers;
}

function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "BAD_ARGS") return new ToolError("BAD_ARGS", message);
  return new ToolError("INTERNAL", message);
}

async function execute<T extends ToolName>(ctx: HiveContext, h: ToolHandlers, agentId: AgentId, humanId: string, tool: T, args: ToolArgs[T]): Promise<ToolResults[T]> {
  const d = ctx.deps;
  const store = h.storeFor(agentId);
  switch (tool) {
    case "list_files": {
      const files = store.listFiles().map((f) => {
        const active = activeIntentsFor(d, f.path);
        const owners = [...new Set([...staticOwners(ctx, f.path).map((a) => a.humanId), ...active.map((i) => i.humanId)])];
        if (active.length === 0 && owners.length === 0) return f;
        return {
          ...f,
          activeIntents: active.map((i) => ({ id: i.id, agentId: i.agentId, symbol: i.symbol })),
          owners,
        };
      });
      return { files } as ToolResults[T];
    }

    case "read_file": {
      const a = args as ToolArgs["read_file"];
      const file = store.readFile(a.path);
      if (!file) throw new ToolError("NOT_FOUND", `no file ${a.path}`);
      const lines = file.content.split("\n");
      const start = Math.max(1, Math.floor(a.startLine ?? 1));
      const end = Math.min(lines.length, Math.floor(a.endLine ?? lines.length));
      if (end < start) throw new ToolError("BAD_ARGS", "endLine before startLine");
      const whole = start === 1 && end === lines.length;
      const content = whole ? file.content : lines.slice(start - 1, end).join("\n");
      let symbols: SymbolInfo[] = [];
      if (a.path.endsWith(".ts") || a.path.endsWith(".tsx") || a.path.endsWith(".js")) {
        try {
          symbols = d.analyzeFile(a.path, file.content).symbols.filter((s) => s.startLine <= end && s.endLine >= start);
        } catch {
          symbols = [];
        }
      }
      d.reads.record(agentId, a.path, file.rev, symbols.map((s) => s.name));
      d.emitter.emit({ type: "file_read", agentId, path: a.path, rev: file.rev });
      const activeIntents = activeIntentsFor(d, a.path);
      const out: ToolResults["read_file"] & { activeIntents?: ActiveIntent[]; note?: string } = { path: a.path, rev: file.rev, content, symbols };
      if (activeIntents.length > 0) {
        out.activeIntents = activeIntents;
        out.note = activeIntents
          .map((i) => `${i.agentId} is working on ${i.symbol} here (${i.id}, ${i.status}): ${i.what}. Promised: ${i.output}.`)
          .join(" ");
      }
      return out as ToolResults[T];
    }

    case "declare_intent": {
      const a = args as ToolArgs["declare_intent"];
      requireOwnership(ctx, agentId, a.target.file);
      const result = await d.intents.declare(agentId, humanId, a, store.rev);
      d.history.beginIntent(result.intent);
      return result as ToolResults[T];
    }

    case "edit_region": {
      const a = args as ToolArgs["edit_region"];
      requireOwnership(ctx, agentId, a.path);
      const intentId = gateEdit(ctx, agentId, a.intentId);
      const r = store.editRegion(intentId ? { actor: agentId, intentId, path: a.path, oldText: a.oldText, newText: a.newText } : { actor: agentId, path: a.path, oldText: a.oldText, newText: a.newText });
      if (!r.ok) throw new ToolError(r.code, editMessage(r.code, a.path), r.current);
      markInProgress(ctx, intentId);
      return { path: a.path, rev: r.rev } as ToolResults[T];
    }

    case "create_file": {
      const a = args as ToolArgs["create_file"];
      requireOwnership(ctx, agentId, a.path);
      const intentId = gateEdit(ctx, agentId, a.intentId);
      const r = store.createFile(intentId ? { actor: agentId, intentId, path: a.path, content: a.content } : { actor: agentId, path: a.path, content: a.content });
      if (!r.ok) throw new ToolError("BAD_ARGS", `cannot create ${a.path}: it exists or the path is not inside the project`);
      markInProgress(ctx, intentId);
      return { path: a.path, rev: r.rev } as ToolResults[T];
    }

    case "finish_intent": {
      const a = args as ToolArgs["finish_intent"];
      const intent = d.intents.get(a.intentId);
      if (!intent) throw new ToolError("NO_INTENT", `unknown intent ${a.intentId}`);
      if (intent.agentId !== agentId) throw new ToolError("NOT_YOUR_INTENT", `${a.intentId} belongs to ${intent.agentId}`);
      if (intent.status === "in_progress") {
        finishIntent(ctx, a.intentId, store.rev);
      } else if (intent.status === "approved" || intent.status === "conflict" || intent.status === "declared") {
        // No edits were made under this intent: finishing it releases the target instead of promising a change.
        d.intents.setStatus(a.intentId, "cancelled");
      } else {
        throw new ToolError("INTENT_NOT_APPROVED", `${a.intentId} is already ${intent.status}`);
      }
      return { intent: d.intents.get(a.intentId) ?? intent } as ToolResults[T];
    }

    case "run_command": {
      const a = args as ToolArgs["run_command"];
      try {
        return (await d.runner.runCommand(store.allFiles(), a.cmd, a.timeoutSec)) as ToolResults[T];
      } catch (err) {
        throw new ToolError("RUNNER_ERROR", err instanceof Error ? err.message : String(err));
      }
    }

    case "run_tests": {
      const a = args as ToolArgs["run_tests"];
      const runId = `run_${agentId}_${Date.now()}`;
      const rev = store.rev;
      const view = agentView(ctx, agentId, store);
      d.emitter.emit({ type: "test_run_started", runId, rev, reason: `run_tests by ${agentId}${view.view ? " (own view)" : ""}` });
      try {
        const raw = await d.runner.runTests(view.files, a.filter ? { filter: a.filter } : {});
        const empty = emptyFilterNote(raw, a.filter);
        const result: TestResult = empty ? { ...raw, ok: false, failures: [...raw.failures, { name: "filter", message: empty }] } : raw;
        d.emitter.emit({ type: "test_run_finished", runId, rev, result });
        const out: RunTestsData = { ...result, note: empty ? `${empty} ${view.note}` : view.note };
        if (view.view) out.view = view.view;
        return out as ToolResults[T];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        d.emitter.emit({ type: "test_run_finished", runId, rev, result: { ok: false, passed: 0, failed: 0, failures: [{ name: "runner", message }], durationMs: 0 } });
        throw new ToolError("RUNNER_ERROR", message);
      }
    }

    case "ack_briefing": {
      const a = args as ToolArgs["ack_briefing"];
      const ok = d.briefings.ack(agentId, a.briefingId, a.note !== undefined ? { response: a.response, note: a.note } : { response: a.response });
      if (!ok) throw new ToolError("NOT_FOUND", `no briefing ${a.briefingId} for ${agentId}`);
      return { briefingId: a.briefingId } as ToolResults[T];
    }

    case "ask_agent": {
      const a = args as ToolArgs["ask_agent"];
      if (!ctx.agents.get(a.to)) throw new ToolError("NOT_FOUND", `unknown agent ${a.to}`);
      const r = d.mailbox.ask(agentId, a.to, a.about, a.question);
      if ("error" in r) throw new ToolError(r.error, "this thread reached 3 exchanges; it was handed to the humans");
      return { messageId: r.id } as ToolResults[T];
    }

    case "reply": {
      const a = args as ToolArgs["reply"];
      const r = d.mailbox.reply(agentId, a.messageId, a.text);
      if ("error" in r) throw new ToolError(r.error, r.error === "NOT_FOUND" ? `no message ${a.messageId}` : "this thread reached 3 exchanges; it was handed to the humans");
      return { messageId: r.id } as ToolResults[T];
    }

    default:
      throw new ToolError("BAD_ARGS", `unknown tool ${String(tool)}`);
  }
}

/** True when `path` falls inside an ownership list: exact path, or under a prefix ending with "/". */
export function ownsPath(owns: readonly string[], path: string): boolean {
  return owns.some((o) => (o.endsWith("/") ? path.startsWith(o) : o === path));
}

/** Agents whose declared `owns` cover the path. */
export function staticOwners(ctx: HiveContext, path: string): { agentId: AgentId; humanId: string }[] {
  return ctx.agents
    .list()
    .filter((a) => a.owns !== undefined && ownsPath(a.owns, path))
    .map((a) => ({ agentId: a.agentId, humanId: a.humanId }));
}

/** Ownership zones: an agent with `owns` may only declare on / edit / create its own files. Agents without `owns` are unrestricted. */
function requireOwnership(ctx: HiveContext, agentId: AgentId, path: string): void {
  const me = ctx.agents.get(agentId);
  if (!me?.owns || ownsPath(me.owns, path)) return;
  const owner = staticOwners(ctx, path).find((o) => o.agentId !== agentId);
  const who = owner ? `is owned by ${owner.agentId} (${owner.humanId})` : "is outside your files";
  throw new ToolError("NOT_OWNER", `${path} ${who}. Do not edit it; use ask_agent to tell the owner what you need.`);
}

export interface ActiveIntent {
  id: IntentId;
  agentId: AgentId;
  humanId: string;
  symbol: string;
  status: "approved" | "in_progress" | "conflict";
  what: string;
  output: string;
}

const ACTIVE_FOR_PRESENCE = new Set(["approved", "in_progress", "conflict"]);

/** Presence: live intents (any agent, the caller included) whose target is in this file. */
export function activeIntentsFor(d: HiveContext["deps"], path: string): ActiveIntent[] {
  return d.intents
    .list()
    .filter((i) => i.target.file === path && ACTIVE_FOR_PRESENCE.has(i.status))
    .map((i) => ({ id: i.id, agentId: i.agentId, humanId: i.humanId, symbol: i.target.symbol, status: i.status as ActiveIntent["status"], what: i.what, output: i.output }));
}

/** A filter that selects no test must not count as green: vitest reports 0 passed / 0 failed and exit 0. */
export function emptyFilterNote(result: TestResult, filter: string | undefined): string | undefined {
  if (!filter || result.passed + result.failed !== 0) return undefined;
  return `filter '${filter}' matched no tests; run without filter or use a test-name regex.`;
}

export interface RunTestsView {
  finishedSets: IntentId[];
  ownOpenIntents: IntentId[];
  excludedInProgress: { intentId: IntentId; agentId: AgentId; files: string[] }[];
}
export type RunTestsData = TestResult & { view?: RunTestsView; note?: string };

/**
 * The files an agent's run_tests is judged on. In hive mode: last green snapshot + finished change
 * sets since it + the agent's own open edits, so another agent's half-done work cannot fail its run.
 * Falls back to the live store (and says so) when the view cannot be built.
 */
export function agentView(ctx: HiveContext, agentId: AgentId, store: ProjectStoreLike): { files: Record<string, string>; view?: RunTestsView; note: string } {
  const d = ctx.deps;
  const live = () => store.allFiles();
  if (d.mode !== "hive") {
    return { files: live(), note: d.mode === "isolated" ? "Ran on your private copy of the project." : "Ran on the live shared project." };
  }
  const h = d.history;
  const green = h.lastGreen();
  const base = green ? { rev: green.rev, files: green.files } : { rev: 0, files: d.initialFiles };
  const sets = h.changeSetsSince(base.rev);
  const all = d.intents.list().filter((i) => i.status === "in_progress");
  const ownIntents = all.filter((i) => i.agentId === agentId);
  const own = ownIntents.flatMap((i) => h.openEdits(i.id));
  const excluded = all
    .filter((i) => i.agentId !== agentId)
    .map((i) => ({ intentId: i.id, agentId: i.agentId, files: [...new Set(h.openEdits(i.id).map((e) => e.path))] }));
  const view: RunTestsView = { finishedSets: sets.map((s) => s.id), ownOpenIntents: ownIntents.map((i) => i.id), excludedInProgress: excluded };
  const built = buildView(base.files, sets, own);
  const excludedText = excluded.length
    ? ` Excluded in-progress edits of ${excluded.map((e) => `${e.agentId} (${e.intentId}: ${e.files.join(", ") || "no edits yet"})`).join(", ")}.`
    : "";
  if (!built.ok) {
    return {
      files: live(),
      view,
      note: `Could not build your view (patch of ${built.failedAt.intentId ?? "open edits"} did not apply at ${built.failedAt.path}#${built.failedAt.index}); ran on the live shared project instead, which includes other agents' in-progress edits.${excludedText}`,
    };
  }
  const parts = [`green rev ${base.rev}`];
  parts.push(view.finishedSets.length ? `finished ${view.finishedSets.join(", ")}` : "no finished intents since");
  parts.push(view.ownOpenIntents.length ? `your open ${view.ownOpenIntents.join(", ")}` : "no open edits of yours");
  return { files: built.files, view, note: `Ran on your view: ${parts.join(" + ")}.${excludedText}` };
}

/** The finish_intent path: status done (with endRev), close the change set, hand it to the TestOrchestrator. */
export function finishIntent(ctx: HiveContext, intentId: IntentId, rev: Rev): void {
  const d = ctx.deps;
  d.intents.setStatus(intentId, "done", { rev });
  try {
    d.history.finishIntent(intentId);
  } catch {
    // history may not know the intent if beginIntent was skipped (e.g. after a reset)
  }
  void d.orchestrator.onIntentFinished(intentId).catch((err: unknown) => {
    console.error(`[hive] orchestrator failed for ${intentId}:`, err instanceof Error ? err.message : err);
  });
}

/**
 * When an agent run ends, close what it left open so other agents are not blocked forever:
 * in_progress (edits made, never finished) -> same path as finish_intent;
 * declared | approved | conflict (no edits yet) -> cancelled, which re-approves conflicting intents;
 * failed (verification failed, agent gave up) -> done, without re-running the orchestrator.
 */
export function closeOpenIntents(ctx: HiveContext, h: ToolHandlers, agentId: AgentId): { finished: IntentId[]; cancelled: IntentId[]; closedFailed: IntentId[] } {
  const d = ctx.deps;
  const finished: IntentId[] = [];
  const cancelled: IntentId[] = [];
  const closedFailed: IntentId[] = [];
  for (const intent of d.intents.list()) {
    if (intent.agentId !== agentId) continue;
    if (intent.status === "in_progress") {
      finishIntent(ctx, intent.id, h.storeFor(agentId).rev);
      finished.push(intent.id);
    } else if (intent.status === "approved" || intent.status === "conflict" || intent.status === "declared") {
      d.intents.setStatus(intent.id, "cancelled");
      cancelled.push(intent.id);
    } else if (intent.status === "failed") {
      // Nobody will fix it any more: its edits stay, the promise is closed as done so it stops blocking same-target intents.
      d.intents.setStatus(intent.id, "done", { rev: h.storeFor(agentId).rev });
      closedFailed.push(intent.id);
    }
  }
  return { finished, cancelled, closedFailed };
}

/** Mode and intent checks before an edit. Returns the intentId to attribute the edit to (if any). */
function gateEdit(ctx: HiveContext, agentId: AgentId, intentId: IntentId | undefined): IntentId | undefined {
  const d = ctx.deps;
  if (d.mode !== "hive") {
    // intents are optional: attribute the edit if the id is a real intent of this agent
    if (intentId && d.intents.get(intentId)?.agentId === agentId) return intentId;
    return undefined;
  }
  if (!intentId) throw new ToolError("NO_INTENT", "declare_intent first and pass its intentId");
  const can = d.intents.canEdit(agentId, intentId);
  if (!can.ok) throw new ToolError(can.code, canEditMessage(can.code, intentId));
  const pending = d.briefings.unackedRequired(agentId);
  if (pending.length > 0) {
    throw new ToolError("UNACKED_BRIEFINGS", `ack these briefings first: ${pending.map((b) => b.id).join(", ")}`);
  }
  return intentId;
}

function markInProgress(ctx: HiveContext, intentId: IntentId | undefined): void {
  if (!intentId) return;
  const intent = ctx.deps.intents.get(intentId);
  if (intent && intent.status === "approved") ctx.deps.intents.setStatus(intentId, "in_progress");
}

function canEditMessage(code: "NO_INTENT" | "INTENT_NOT_APPROVED" | "NOT_YOUR_INTENT", intentId: IntentId): string {
  switch (code) {
    case "NO_INTENT":
      return `unknown intent ${intentId}; declare_intent first`;
    case "NOT_YOUR_INTENT":
      return `${intentId} belongs to another agent`;
    case "INTENT_NOT_APPROVED":
      return `${intentId} is not approved (conflict, done or cancelled); wait for approval or declare a new intent`;
  }
}

function editMessage(code: "NOT_FOUND" | "OLD_TEXT_NOT_FOUND" | "OLD_TEXT_AMBIGUOUS", path: string): string {
  switch (code) {
    case "NOT_FOUND":
      return `no file ${path}`;
    case "OLD_TEXT_NOT_FOUND":
      return `oldText not found in ${path}; the file changed, see error.current for the fresh content`;
    case "OLD_TEXT_AMBIGUOUS":
      return `oldText matches more than once in ${path}; include more context`;
  }
}
