import { describe, expect, it } from "vitest";
import type { FeedEvent } from "@hive/shared";
import { currentIntentOf, initialUiState, reduce, resync, type UiState } from "./state";
import { MOCK_EVENTS, mockInitialState } from "./mock";

function pick<T extends FeedEvent["type"]>(type: T, n = 0): Extract<FeedEvent, { type: T }> {
  const found = MOCK_EVENTS.filter((e): e is Extract<FeedEvent, { type: T }> => e.type === type)[n];
  if (!found) throw new Error(`no mock event ${type}#${n}`);
  return found;
}

function run(events: FeedEvent[], start: UiState = initialUiState(mockInitialState())): UiState {
  return events.reduce(reduce, start);
}

describe("reducer", () => {
  it("intent_declared adds an intent and intent_status updates it", () => {
    const declared = pick("intent_declared", 0);
    let s = run([declared]);
    expect(s.intents.map((i) => i.id)).toEqual(["A1"]);
    expect(s.intents[0]?.status).toBe("approved");
    s = reduce(s, { id: declared.id + 1, ts: 1, type: "intent_status", intentId: "A1", status: "in_progress" });
    expect(s.intents[0]?.status).toBe("in_progress");
    expect(currentIntentOf(s, "agent-andrii")?.id).toBe("A1");
  });

  it("briefing_acked with adapted increments plan changes, other responses do not", () => {
    const sent = pick("briefing_sent", 0);
    const acked = pick("briefing_acked", 0);
    expect(acked.ack.response).toBe("adapted");
    let s = run([sent, acked]);
    expect(s.counters.briefingsSent).toBe(1);
    expect(s.counters.planChanges).toBe(1);
    expect(s.briefings[sent.briefing.id]?.ack?.response).toBe("adapted");
    s = reduce(s, { id: 999, ts: 1, type: "briefing_acked", briefingId: sent.briefing.id, agentId: "agent-masha", ack: { response: "not_relevant", at: 1 } });
    expect(s.counters.planChanges).toBe(1);
  });

  it("intent_declared with conflicts increments conflicts caught before code", () => {
    const ok = pick("intent_declared", 0);
    const conflict = pick("intent_declared", 1);
    expect(conflict.conflicts.length).toBeGreaterThan(0);
    const s = run([ok, conflict]);
    expect(s.counters.conflictsCaught).toBe(1);
    expect(s.conflictsOf["M1"]?.[0]?.intentId).toBe("A1");
    expect(s.intents.find((i) => i.id === "M1")?.status).toBe("conflict");
  });

  it("culprit events build the grid and the final report", () => {
    const started = pick("culprit_search_started");
    const variants = MOCK_EVENTS.filter((e) => e.type === "culprit_variant_result");
    const found = pick("culprit_found");
    let s = run([started]);
    expect(s.counters.culpritSearches).toBe(1);
    expect(s.culprit?.suspects).toEqual(["A1", "M2"]);
    expect(Object.keys(s.culprit?.variants ?? {})).toHaveLength(0);
    s = run(variants, s);
    expect(s.culprit?.variants["green+A1"]?.ok).toBe(true);
    expect(s.culprit?.variants["all"]?.ok).toBe(false);
    expect(s.culprit?.order).toContain("all-M2");
    expect(s.culprit?.report).toBeUndefined();
    s = reduce(s, found);
    expect(s.culprit?.report?.kind).toBe("pair");
    expect(s.culprit?.report?.culprits).toEqual(["A1", "M2"]);
  });

  it("ignores duplicate event ids", () => {
    const sent = pick("briefing_sent", 0);
    const s1 = run([sent]);
    const s2 = reduce(s1, sent);
    expect(s2).toBe(s1);
    expect(s2.counters.briefingsSent).toBe(1);
    expect(s2.events).toHaveLength(1);
    // A full replay changes nothing either.
    const full = run(MOCK_EVENTS);
    const replayed = run(MOCK_EVENTS, full);
    expect(replayed).toBe(full);
    expect(full.counters.conflictsCaught).toBe(1);
    expect(full.counters.planChanges).toBe(4);
  });

  it("edit_applied bumps rev and file rev, test_run_finished green moves lastGreen", () => {
    const s = run(MOCK_EVENTS);
    expect(s.rev).toBe(6);
    expect(s.files.find((f) => f.path === "test/checkout.test.ts")?.rev).toBe(6);
    expect(s.lastGreen?.rev).toBe(6);
    expect(s.tests.running).toBeUndefined();
    expect(s.tests.last?.result.ok).toBe(true);
    expect(s.agents.map((a) => a.status)).toEqual(["done", "done"]);
  });

  it("resync keeps counters and applies only newer events", () => {
    const half = run(MOCK_EVENTS.slice(0, 20));
    const fresh = mockInitialState();
    fresh.rev = 6;
    fresh.recentEvents = MOCK_EVENTS.slice(10);
    const s = resync(half, fresh);
    expect(s.rev).toBe(6);
    expect(s.counters.briefingsSent).toBe(run(MOCK_EVENTS).counters.briefingsSent);
    expect(s.events).toHaveLength(MOCK_EVENTS.length);
  });

  it("resync after a server reset starts counters from zero even though ids keep growing", () => {
    const full = run(MOCK_EVENTS);
    expect(full.counters.briefingsSent).toBeGreaterThan(0);
    const fresh = mockInitialState(); // rev 0, no events: what /api/state returns right after /api/reset
    const explicit = resync(full, fresh, { reset: true });
    expect(explicit.counters).toEqual({ briefingsSent: 0, planChanges: 0, conflictsCaught: 0, culpritSearches: 0 });
    expect(explicit.intents).toEqual([]);
    expect(explicit.connection).toBe(full.connection);
    // Rev going backwards is treated as a reset too, with no flag.
    const inferred = resync(full, { ...fresh, rev: 0 });
    expect(inferred.counters.briefingsSent).toBe(0);
    // Plain reconnect with the same rev keeps counters.
    const same = resync(full, { ...fresh, rev: full.rev });
    expect(same.counters.briefingsSent).toBe(full.counters.briefingsSent);
  });
});
