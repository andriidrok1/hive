import type {
  AgentId,
  DeclareIntentResult,
  FeedEventBody,
  HiveMode,
  HumanId,
  Intent,
  IntentConflict,
  IntentId,
  IntentInput,
  IntentStatus,
  LLM,
  Rev,
} from "@hive/shared";
import type { BriefingQueue } from "./BriefingQueue.js";
import type { CallGraph } from "./CallGraph.js";
import { badArgs, type ReadLogLike } from "./deps.js";
import { CHECK_PROMPTS } from "./llm.js";

export interface IntentRegistryDeps {
  llm: LLM;
  graph: CallGraph;
  reads: ReadLogLike;
  briefings: BriefingQueue;
  onEvent: (e: FeedEventBody) => void;
  mode: HiveMode;
}

const ACTIVE: readonly IntentStatus[] = ["approved", "in_progress"];
const PROMISING: readonly IntentStatus[] = ["approved", "in_progress", "done", "verified"];
const RELEASING: readonly IntentStatus[] = ["done", "verified", "cancelled", "failed"];
const VAGUE_WORDS = new Set(["works", "work", "working", "done", "fixed", "fix", "updated", "update", "changed", "improved", "better", "ok", "okay", "good", "correct", "correctly"]);
const FILLER = new Set(["it", "is", "the", "a", "an", "and", "now", "this", "that", "code", "function", "should", "will", "be", "all", "everything", "properly", "as", "expected"]);

export function isVagueOutput(output: string): boolean {
  const words = output
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  if (words.length === 0) return true;
  const meaningful = words.filter((w) => !FILLER.has(w));
  if (meaningful.length === 0) return true;
  return meaningful.every((w) => VAGUE_WORDS.has(w));
}

export function validateIntentInput(input: IntentInput): void {
  if (!input || typeof input !== "object") throw badArgs("intent input must be an object");
  const { target, action, what, output } = input;
  if (!target || typeof target.file !== "string" || !target.file || typeof target.symbol !== "string" || !target.symbol) {
    throw badArgs("target.file and target.symbol are required");
  }
  if (action !== "modify" && action !== "add" && action !== "delete") throw badArgs("action must be modify | add | delete");
  if (typeof what !== "string" || what.trim().length < 5 || what.length > 200) throw badArgs("what must be 5..200 chars");
  if (typeof output !== "string" || output.trim().length < 10 || output.length > 300) throw badArgs("output must be 10..300 chars");
  if (typeof input.input !== "string") throw badArgs("input must be a string");
  if (isVagueOutput(output)) {
    throw badArgs('output is too vague: describe the concrete promised behavior, e.g. "returns subtotal minus discount, no tax"');
  }
}

export class IntentRegistry {
  private intents = new Map<IntentId, Intent>();
  private order: IntentId[] = [];
  private conflictsOf = new Map<IntentId, IntentConflict[]>();
  private prefixOf = new Map<AgentId, string>();
  private counters = new Map<AgentId, number>();

  constructor(private readonly deps: IntentRegistryDeps) {}

  get mode(): HiveMode {
    return this.deps.mode;
  }

  // ---------- ids ----------

  private prefixFor(agentId: AgentId): string {
    const known = this.prefixOf.get(agentId);
    if (known) return known;
    const base = agentId.replace(/^agent-/, "");
    const letter = (base.match(/[a-z0-9]/i)?.[0] ?? "X").toUpperCase();
    const taken = new Set(this.prefixOf.values());
    let prefix = letter;
    while (taken.has(prefix)) prefix += letter;
    this.prefixOf.set(agentId, prefix);
    return prefix;
  }

  private nextId(agentId: AgentId): IntentId {
    const n = (this.counters.get(agentId) ?? 0) + 1;
    this.counters.set(agentId, n);
    return `${this.prefixFor(agentId)}${n}`;
  }

  // ---------- queries ----------

  get(id: IntentId): Intent | undefined {
    return this.intents.get(id);
  }

  list(): Intent[] {
    return this.order.map((id) => this.intents.get(id)!).filter(Boolean);
  }

  conflicts(id: IntentId): IntentConflict[] {
    return [...(this.conflictsOf.get(id) ?? [])];
  }

  canEdit(agentId: AgentId, intentId: IntentId): { ok: true } | { ok: false; code: "NO_INTENT" | "INTENT_NOT_APPROVED" | "NOT_YOUR_INTENT" } {
    const intent = this.intents.get(intentId);
    if (!intent) return { ok: false, code: "NO_INTENT" };
    if (intent.agentId !== agentId) return { ok: false, code: "NOT_YOUR_INTENT" };
    if (!ACTIVE.includes(intent.status)) return { ok: false, code: "INTENT_NOT_APPROVED" };
    return { ok: true };
  }

  // ---------- declare ----------

  async declare(agentId: AgentId, humanId: HumanId, input: IntentInput, rev: Rev): Promise<DeclareIntentResult> {
    validateIntentInput(input);
    const now = Date.now();
    const intent: Intent = {
      ...input,
      target: { file: input.target.file, symbol: input.target.symbol },
      id: this.nextId(agentId),
      agentId,
      humanId,
      status: "declared",
      createdAt: now,
      updatedAt: now,
      baseRev: rev,
    };

    if (this.deps.mode !== "hive") {
      intent.status = "approved";
      this.store(intent, []);
      this.deps.onEvent({ type: "intent_declared", intent, conflicts: [], dependents: [] });
      return { intent, status: "approved", conflicts: [], dependents: [] };
    }

    const conflicts: IntentConflict[] = [];
    const others = this.list().filter((i) => i.agentId !== agentId);

    // 3. same target
    for (const o of others) {
      if (!ACTIVE.includes(o.status)) continue;
      if (o.target.file === intent.target.file && o.target.symbol === intent.target.symbol) {
        conflicts.push({ intentId: o.id, kind: "same_target", reason: `${o.agentId} is already changing ${o.target.symbol} in ${o.target.file} (${o.id}: ${o.what})` });
      }
    }

    // 4. contradiction
    const flagged = new Set(conflicts.map((c) => c.intentId));
    const related = this.relatedSymbols(intent.target.symbol);
    const candidates = others.filter((o) => PROMISING.includes(o.status) && !flagged.has(o.id) && related.has(o.target.symbol));
    if (candidates.length > 0) {
      const verdict = await this.askContradiction(intent, candidates);
      if (verdict.conflict) {
        let hit = candidates.filter((c) => verdict.with.includes(c.id));
        if (hit.length === 0) hit = candidates;
        for (const c of hit) conflicts.push({ intentId: c.id, kind: "contradiction", reason: verdict.reason });
      }
    }

    // 5. status + conflict briefings
    intent.status = conflicts.length > 0 ? "conflict" : "approved";
    this.store(intent, conflicts);
    const briefed = new Set<AgentId>();
    if (conflicts.length > 0) {
      const otherIds = conflicts.map((c) => c.intentId).join(", ");
      this.deps.briefings.push({
        toAgent: agentId,
        kind: "intent_conflict",
        summary: `Your intent ${intent.id} (${intent.what}) conflicts with ${otherIds}: ${conflicts.map((c) => c.reason).join("; ")}. Wait: a human resolves it or the other intent finishes; you will get a briefing when it is approved.`,
        details: { file: intent.target.file, symbol: intent.target.symbol, intentId: intent.id },
        requiresAck: true,
      });
      briefed.add(agentId);
      for (const c of conflicts) {
        const o = this.intents.get(c.intentId);
        if (!o || briefed.has(o.agentId)) continue;
        briefed.add(o.agentId);
        this.deps.briefings.push({
          toAgent: o.agentId,
          kind: "intent_conflict",
          fromAgent: agentId,
          summary: `${agentId} declared ${intent.id} on ${intent.target.symbol} (${intent.target.file}) which conflicts with your ${o.id} (${c.kind}): ${c.reason}. Their promised output: ${intent.output}. Your intent stays active; theirs waits.`,
          details: { file: intent.target.file, symbol: intent.target.symbol, intentId: intent.id },
          requiresAck: true,
        });
      }
    }

    // 6. dependents
    const dependents = this.dependentsOf(intent.target.file, intent.target.symbol, agentId).filter((d) => !briefed.has(d));
    for (const dep of dependents) {
      this.deps.briefings.push({
        toAgent: dep,
        kind: "intent_declared",
        fromAgent: agentId,
        summary: `${agentId} is about to ${intent.action} ${intent.target.symbol} in ${intent.target.file} (${intent.id}): ${intent.what}. Promised output: ${intent.output}. You read or call it; check your assumptions before editing.`,
        details: { file: intent.target.file, symbol: intent.target.symbol, intentId: intent.id, yourUsages: this.usagesOf(dep, intent.target.symbol) },
        requiresAck: true,
      });
    }

    // 7. event
    this.deps.onEvent({ type: "intent_declared", intent, conflicts, dependents });
    return { intent, status: intent.status as "approved" | "conflict", conflicts, dependents };
  }

  private store(intent: Intent, conflicts: IntentConflict[]): void {
    this.intents.set(intent.id, intent);
    this.order.push(intent.id);
    this.conflictsOf.set(intent.id, conflicts);
  }

  /** The symbol itself, its callers and its callees. */
  private relatedSymbols(symbol: string): Set<string> {
    const out = new Set<string>([symbol]);
    for (const c of this.deps.graph.callersOf(symbol)) if (c.caller) out.add(c.caller);
    for (const callee of this.deps.graph.calleesOf(symbol)) out.add(callee);
    return out;
  }

  private async askContradiction(intent: Intent, candidates: Intent[]): Promise<{ conflict: boolean; with: string[]; reason: string }> {
    const describe = (i: Intent) => ({ id: i.id, agent: i.agentId, status: i.status, target: `${i.target.file}#${i.target.symbol}`, action: i.action, what: i.what, input: i.input, output: i.output });
    const user = JSON.stringify(
      {
        new_intent: describe(intent),
        existing_intents: candidates.map(describe),
        instructions: "Report a conflict only if the new intent's promised output cannot hold together with an existing intent's promise. `with` lists the ids of the existing intents it contradicts.",
      },
      null,
      2,
    );
    try {
      const raw = await this.deps.llm.json<{ conflict?: unknown; with?: unknown; reason?: unknown }>(CHECK_PROMPTS.contradiction, user, "{conflict: boolean, with: string[], reason: string}");
      return {
        conflict: raw?.conflict === true,
        with: Array.isArray(raw?.with) ? raw.with.filter((x): x is string => typeof x === "string") : [],
        reason: typeof raw?.reason === "string" && raw.reason ? raw.reason : "promised behaviors contradict",
      };
    } catch {
      // Fail open: a dead check must not block the whole hive.
      return { conflict: false, with: [], reason: "" };
    }
  }

  /** Readers of the symbol plus owners of active intents on its callers, excluding `self`. */
  dependentsOf(file: string, symbol: string, self?: AgentId): AgentId[] {
    const out = new Set<AgentId>();
    for (const r of this.deps.reads.readersOf(file, symbol)) out.add(r.agentId);
    const callerNames = new Set<string>();
    for (const c of this.deps.graph.callersOf(symbol)) if (c.caller) callerNames.add(c.caller);
    for (const i of this.list()) {
      if (ACTIVE.includes(i.status) && callerNames.has(i.target.symbol)) out.add(i.agentId);
    }
    if (self) out.delete(self);
    return [...out];
  }

  /** Call sites of `symbol` in files this agent read or whose enclosing symbol this agent targets. */
  private usagesOf(agentId: AgentId, symbol: string): { file: string; line: number }[] {
    const readFiles = new Set(this.deps.reads.readsOf(agentId).map((r) => r.path));
    const targets = new Set(this.list().filter((i) => i.agentId === agentId && ACTIVE.includes(i.status)).map((i) => i.target.symbol));
    return this.deps.graph
      .callersOf(symbol)
      .filter((c) => readFiles.has(c.file) || (c.caller !== null && targets.has(c.caller)))
      .map((c) => ({ file: c.file, line: c.line }));
  }

  // ---------- status ----------

  setStatus(id: IntentId, status: IntentStatus, opts?: { rev?: Rev }): void {
    const intent = this.intents.get(id);
    if (!intent) throw badArgs(`unknown intent ${id}`);
    intent.status = status;
    intent.updatedAt = Date.now();
    if (opts?.rev !== undefined && (status === "done" || status === "verified")) intent.endRev = opts.rev;
    this.deps.onEvent({ type: "intent_status", intentId: id, status });
    if (RELEASING.includes(status)) this.reevaluateConflicts(id);
  }

  private conflictStillActive(c: IntentConflict): boolean {
    const other = this.intents.get(c.intentId);
    if (!other) return false;
    return ACTIVE.includes(other.status) || other.status === "conflict";
  }

  /** `resolved` left the active set: intents in `conflict` only because of it become approved. */
  private reevaluateConflicts(resolved: IntentId): void {
    for (const intent of this.list()) {
      if (intent.status !== "conflict") continue;
      const conflicts = this.conflictsOf.get(intent.id) ?? [];
      if (!conflicts.some((c) => c.intentId === resolved)) continue;
      const remaining = conflicts.filter((c) => this.conflictStillActive(c));
      if (remaining.length > 0) continue;
      this.approveAfterConflict(intent, `the conflicting intent ${resolved} is no longer active`);
    }
  }

  private approveAfterConflict(intent: Intent, why: string): void {
    this.conflictsOf.set(intent.id, []);
    this.setStatus(intent.id, "approved");
    this.deps.briefings.push({
      toAgent: intent.agentId,
      kind: "intent_conflict",
      summary: `Your intent ${intent.id} (${intent.what}) is approved now: ${why}. You can edit ${intent.target.symbol} in ${intent.target.file}.`,
      details: { file: intent.target.file, symbol: intent.target.symbol, intentId: intent.id },
      requiresAck: false,
    });
  }

  // ---------- human actions ----------

  humanEditOutput(humanId: HumanId, intentId: IntentId, newOutput: string): void {
    const intent = this.intents.get(intentId);
    if (!intent) throw badArgs(`unknown intent ${intentId}`);
    if (typeof newOutput !== "string" || newOutput.trim().length < 10 || newOutput.length > 300) throw badArgs("output must be 10..300 chars");
    const oldOutput = intent.output;
    intent.output = newOutput;
    intent.updatedAt = Date.now();
    this.deps.onEvent({ type: "human_action", humanId, action: "edit_output", target: intentId });
    if (this.deps.mode !== "hive") return;

    this.deps.briefings.push({
      toAgent: intent.agentId,
      kind: "contract_changed",
      fromHuman: humanId,
      summary: `${humanId} changed the promised output of your intent ${intentId} (${intent.target.symbol}). Was: "${oldOutput}". Now: "${newOutput}". Make your change match the new promise.`,
      details: { file: intent.target.file, symbol: intent.target.symbol, intentId },
      requiresAck: true,
    });
    for (const dep of this.dependentsOf(intent.target.file, intent.target.symbol, intent.agentId)) {
      this.deps.briefings.push({
        toAgent: dep,
        kind: "contract_changed",
        fromHuman: humanId,
        summary: `${humanId} changed what ${intent.agentId} promises for ${intent.target.symbol} in ${intent.target.file} (${intentId}). Was: "${oldOutput}". Now: "${newOutput}". You read or call it; check your assumptions.`,
        details: { file: intent.target.file, symbol: intent.target.symbol, intentId, yourUsages: this.usagesOf(dep, intent.target.symbol) },
        requiresAck: true,
      });
    }
  }

  resolveConflict(humanId: HumanId, keepIntentId: IntentId, cancelIntentId: IntentId): void {
    const keep = this.intents.get(keepIntentId);
    const cancel = this.intents.get(cancelIntentId);
    if (!keep || !cancel) throw badArgs("unknown intent id");
    if (keep.id === cancel.id) throw badArgs("keep and cancel must differ");
    this.deps.onEvent({ type: "human_action", humanId, action: "resolve_conflict", target: `${keepIntentId}>${cancelIntentId}` });

    // Cancelling re-evaluates every intent stuck in conflict because of `cancel`, including `keep`.
    this.setStatus(cancel.id, "cancelled");
    this.deps.briefings.push({
      toAgent: cancel.agentId,
      kind: "intent_conflict",
      fromHuman: humanId,
      summary: `${humanId} resolved the conflict between ${keep.id} and your ${cancel.id} (${cancel.what}) in favour of ${keep.id}. Your intent is cancelled; do not edit ${cancel.target.symbol}. Declare a new intent if you still need a change.`,
      details: { file: cancel.target.file, symbol: cancel.target.symbol, intentId: cancel.id },
      requiresAck: false,
    });

    if (keep.status === "conflict") {
      // Still blocked by a third intent; tell the owner a human sided with them anyway.
      this.deps.briefings.push({
        toAgent: keep.agentId,
        kind: "intent_conflict",
        fromHuman: humanId,
        summary: `${humanId} kept your ${keep.id} over ${cancel.id}, but it still conflicts with another active intent; keep waiting.`,
        details: { file: keep.target.file, symbol: keep.target.symbol, intentId: keep.id },
        requiresAck: false,
      });
    } else if (!this.wasJustApproved(keep.id)) {
      this.deps.briefings.push({
        toAgent: keep.agentId,
        kind: "intent_conflict",
        fromHuman: humanId,
        summary: `${humanId} resolved the conflict in favour of your ${keep.id} (${keep.what}); ${cancel.id} is cancelled. Carry on.`,
        details: { file: keep.target.file, symbol: keep.target.symbol, intentId: keep.id },
        requiresAck: false,
      });
    }
  }

  /** True if the last briefing pushed to this intent's owner is the re-approval notice for it. */
  private wasJustApproved(intentId: IntentId): boolean {
    const intent = this.intents.get(intentId);
    if (!intent) return false;
    const mine = this.deps.briefings.forAgent(intent.agentId);
    const last = mine[mine.length - 1];
    return !!last && last.kind === "intent_conflict" && last.requiresAck === false && last.details.intentId === intentId && last.summary.includes("is approved now");
  }
}
