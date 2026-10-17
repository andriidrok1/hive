import type {
  AgentControl,
  AgentId,
  AgentMessage,
  Briefing,
  CulpritReport,
  CulpritVariant,
  FeedEvent,
  HiveState,
  Intent,
  IntentConflict,
  IntentId,
  IntentStatus,
  TestResult,
} from "@hive/shared";

// ---------- UI state (HiveState plus what the feed accumulates) ----------

export interface Counters {
  briefingsSent: number;
  planChanges: number; // acks with response "adapted"
  conflictsCaught: number; // intent_declared with conflicts.length > 0
  culpritSearches: number;
}

export interface CulpritGrid {
  searchId: string;
  suspects: IntentId[];
  variants: Record<string, CulpritVariant>; // keyed by server label
  order: string[]; // labels in arrival order
  report?: CulpritReport;
}

export interface TestsState {
  running?: { runId: string; rev: number; reason: string; startedAt: number };
  last?: { runId: string; rev: number; result: TestResult; at: number };
}

export type Connection = "mock" | "connecting" | "open" | "reconnecting";

export interface UiState extends HiveState {
  connection: Connection;
  conflictsOf: Record<IntentId, IntentConflict[]>; // from intent_declared, for the resolve buttons
  events: FeedEvent[]; // newest first
  lastEventId: number;
  counters: Counters;
  briefings: Record<string, Briefing>;
  messages: AgentMessage[];
  actions: Record<AgentId, string[]>; // last 3 actions per agent, newest first
  tests: TestsState;
  culprit?: CulpritGrid;
}

export const MAX_EVENTS = 400;

export const emptyHiveState: HiveState = {
  mode: "hive",
  rev: 0,
  files: [],
  agents: [],
  intents: [],
  history: [],
  recentEvents: [],
};

export function initialUiState(h: HiveState = emptyHiveState): UiState {
  const base: UiState = {
    ...h,
    recentEvents: [],
    connection: "connecting",
    conflictsOf: {},
    events: [],
    lastEventId: 0,
    counters: { briefingsSent: 0, planChanges: 0, conflictsCaught: 0, culpritSearches: 0 },
    briefings: {},
    messages: [],
    actions: {},
    tests: {},
  };
  // Replay the tail the server keeps so counters are not zero after a reload.
  return [...h.recentEvents].sort((a, b) => a.id - b.id).reduce(reduce, base);
}

// Merge a fresh GET /api/state (after a reconnect) into what we already have:
// authoritative lists come from the server, counters keep accumulating from new events only.
export function resync(state: UiState, h: HiveState): UiState {
  const newest = h.recentEvents.reduce((m, e) => Math.max(m, e.id), 0);
  if (newest < state.lastEventId && h.recentEvents.length > 0) return { ...initialUiState(h), connection: state.connection }; // server restarted
  const merged: UiState = {
    ...state,
    mode: h.mode,
    rev: h.rev,
    files: h.files,
    agents: h.agents,
    intents: h.intents,
    history: h.history,
    lastGreen: h.lastGreen,
  };
  return [...h.recentEvents].sort((a, b) => a.id - b.id).reduce(reduce, merged);
}

// ---------- Reducer ----------

const ACTIVE_INTENT: readonly IntentStatus[] = ["declared", "approved", "conflict", "in_progress"];

function pushAction(actions: UiState["actions"], agentId: AgentId, text: string): UiState["actions"] {
  const prev = actions[agentId] ?? [];
  return { ...actions, [agentId]: [text, ...prev].slice(0, 3) };
}

function upsertIntent(intents: Intent[], intent: Intent): Intent[] {
  const i = intents.findIndex((x) => x.id === intent.id);
  if (i < 0) return [...intents, intent];
  const next = intents.slice();
  next[i] = intent;
  return next;
}

export function reduce(state: UiState, e: FeedEvent): UiState {
  if (e.id <= state.lastEventId) return state; // duplicate or replayed event
  const base: UiState = {
    ...state,
    lastEventId: e.id,
    events: [e, ...state.events].slice(0, MAX_EVENTS),
  };
  switch (e.type) {
    case "agent_status": {
      const i = base.agents.findIndex((a) => a.agentId === e.agentId);
      const prev = i >= 0 ? base.agents[i] : undefined;
      // paused → control pause; any other live status clears a stale pause; terminal keeps what it had.
      const control: AgentControl = e.status === "paused" ? "pause" : prev?.control === "pause" ? "run" : (prev?.control ?? "run");
      const next = {
        agentId: e.agentId,
        humanId: e.humanId,
        status: e.status,
        task: e.task ?? prev?.task,
        control,
      };
      const agents = base.agents.slice();
      if (i >= 0) agents[i] = next;
      else agents.push(next);
      return { ...base, agents };
    }
    case "file_read":
      return { ...base, actions: pushAction(base.actions, e.agentId, `read ${e.path} @${e.rev}`) };
    case "intent_declared": {
      const conflicts = e.conflicts.length > 0;
      return {
        ...base,
        intents: upsertIntent(base.intents, e.intent),
        conflictsOf: conflicts ? { ...base.conflictsOf, [e.intent.id]: e.conflicts } : base.conflictsOf,
        counters: conflicts ? { ...base.counters, conflictsCaught: base.counters.conflictsCaught + 1 } : base.counters,
        actions: pushAction(base.actions, e.intent.agentId, `${conflicts ? "conflict" : "intent"} ${e.intent.id}: ${e.intent.what}`),
      };
    }
    case "intent_status": {
      const intents = base.intents.map((x) => (x.id === e.intentId ? { ...x, status: e.status, updatedAt: e.ts } : x));
      return { ...base, intents };
    }
    case "edit_applied": {
      const files = base.files.some((f) => f.path === e.path)
        ? base.files.map((f) => (f.path === e.path ? { ...f, rev: e.rev } : f))
        : [...base.files, { path: e.path, rev: e.rev }];
      const isAgent = base.agents.some((a) => a.agentId === e.agentId);
      const intents = e.intentId
        ? base.intents.map((x) => (x.id === e.intentId && x.status === "approved" ? { ...x, status: "in_progress" as const, updatedAt: e.ts } : x))
        : base.intents;
      return {
        ...base,
        rev: Math.max(base.rev, e.rev),
        files,
        intents,
        actions: isAgent ? pushAction(base.actions, e.agentId, `edit ${e.path} +${e.added} -${e.removed}`) : base.actions,
      };
    }
    case "briefing_sent":
      return {
        ...base,
        briefings: { ...base.briefings, [e.briefing.id]: e.briefing },
        counters: { ...base.counters, briefingsSent: base.counters.briefingsSent + 1 },
      };
    case "briefing_acked": {
      const b = base.briefings[e.briefingId];
      const briefings = b ? { ...base.briefings, [e.briefingId]: { ...b, ack: e.ack } } : base.briefings;
      return {
        ...base,
        briefings,
        counters: e.ack.response === "adapted" ? { ...base.counters, planChanges: base.counters.planChanges + 1 } : base.counters,
        actions: pushAction(base.actions, e.agentId, `ack ${e.briefingId}: ${e.ack.response}`),
      };
    }
    case "message_sent":
      return {
        ...base,
        messages: [...base.messages, e.message],
        actions: pushAction(base.actions, e.message.from, `asked ${e.message.to} about ${e.message.about}`),
      };
    case "test_run_started":
      return { ...base, tests: { ...base.tests, running: { runId: e.runId, rev: e.rev, reason: e.reason, startedAt: e.ts } } };
    case "test_run_finished": {
      const running = base.tests.running?.runId === e.runId ? undefined : base.tests.running;
      const lastGreen = e.result.ok ? { rev: e.rev, at: e.ts } : base.lastGreen;
      return { ...base, lastGreen, tests: { running, last: { runId: e.runId, rev: e.rev, result: e.result, at: e.ts } } };
    }
    case "culprit_search_started":
      return {
        ...base,
        culprit: { searchId: e.searchId, suspects: e.suspects, variants: {}, order: [] },
        counters: { ...base.counters, culpritSearches: base.counters.culpritSearches + 1 },
      };
    case "culprit_variant_result": {
      const grid: CulpritGrid =
        base.culprit && base.culprit.searchId === e.searchId
          ? base.culprit
          : { searchId: e.searchId, suspects: [], variants: {}, order: [] };
      const label = e.variant.label;
      const order = grid.order.includes(label) ? grid.order : [...grid.order, label];
      return { ...base, culprit: { ...grid, variants: { ...grid.variants, [label]: e.variant }, order } };
    }
    case "culprit_found": {
      const grid: CulpritGrid =
        base.culprit && base.culprit.searchId === e.searchId
          ? base.culprit
          : { searchId: e.searchId, suspects: e.report.culprits, variants: {}, order: [] };
      // Fill in any variants the report carries that we did not see live.
      let variants = grid.variants;
      let order = grid.order;
      for (const v of e.report.variants) {
        if (!variants[v.label]) {
          variants = { ...variants, [v.label]: v };
          order = [...order, v.label];
        }
      }
      return { ...base, culprit: { ...grid, variants, order, report: e.report } };
    }
    case "human_action":
    case "llm_call":
      return base;
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

// ---------- Selectors ----------

export function currentIntentOf(state: UiState, agentId: AgentId): Intent | undefined {
  const mine = state.intents.filter((i) => i.agentId === agentId);
  const active = mine.filter((i) => ACTIVE_INTENT.includes(i.status));
  const pool = active.length > 0 ? active : mine;
  return pool.reduce<Intent | undefined>((best, i) => (!best || i.createdAt >= best.createdAt ? i : best), undefined);
}

export function activeIntents(state: UiState): Intent[] {
  return state.intents.filter((i) => ACTIVE_INTENT.includes(i.status));
}

export function intentsForFile(state: UiState, path: string): Intent[] {
  const shown: readonly IntentStatus[] = [...ACTIVE_INTENT, "done", "verified", "failed"];
  return state.intents.filter((i) => i.target.file === path && shown.includes(i.status));
}

export function unresolvedConflicts(state: UiState): Intent[] {
  return state.intents.filter((i) => i.status === "conflict");
}

export function pendingBriefings(state: UiState): Briefing[] {
  return Object.values(state.briefings).filter((b) => b.requiresAck && !b.ack);
}

// Agent colour: stable per id, readable on dark.
const PALETTE = ["#f5a524", "#3b9cff", "#ff5c8a", "#2dd4bf", "#c084fc", "#a3e635", "#fb923c", "#38bdf8"];
export function agentColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? "#f5a524";
}

export function intentColor(status: IntentStatus, agentId: AgentId): string {
  switch (status) {
    case "declared":
    case "approved":
      return "#8b93a7";
    case "in_progress":
    case "done":
      return agentColor(agentId);
    case "verified":
      return "#22c55e";
    case "conflict":
    case "failed":
      return "#ef4444";
    case "cancelled":
      return "#4b5163";
    default: {
      const _x: never = status;
      return _x;
    }
  }
}
