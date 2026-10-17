import type { Briefing, ChangeSet, FeedEventBody, Intent, IntentStatus, Rev, Runner, Snapshot, TestResult } from "@hive/shared";
import { describe, expect, it } from "vitest";
import { History, ProjectStore, ReadLog } from "../../src/core/index.js";
import { BriefingQueue, CallGraph, IntentRegistry } from "../../src/coord/index.js";
import { CulpritFinder } from "../../src/runner/CulpritFinder.js";
import { checkTestSource, CHECK_TEST_PATH, TestOrchestrator, type TestOrchestratorDeps } from "../../src/runner/TestOrchestrator.js";
import { applyAll, breakDiscount, harmlessFormatChange, taxInCalculateTotal, taxLineInOrderSummary } from "./fixtures/changeSets.js";
import { DEMO_APP_FILES } from "./fixtures/demoApp.js";

// Compile-time check: the real core/coord classes satisfy the orchestrator's structural deps.
type Satisfies<T extends U, U> = T;
type _Store = Satisfies<ProjectStore, TestOrchestratorDeps["store"]>;
type _History = Satisfies<History, TestOrchestratorDeps["history"]>;
type _Intents = Satisfies<IntentRegistry, TestOrchestratorDeps["intents"]>;
type _Briefings = Satisfies<BriefingQueue, TestOrchestratorDeps["briefings"]>;
type _Reads = Satisfies<ReadLog, TestOrchestratorDeps["reads"]>;
type _Graph = Satisfies<CallGraph, TestOrchestratorDeps["graph"]>;

// ---------- fakes ----------

function fakeStore(files: Record<string, string>, rev = 0) {
  const listeners = new Set<(c: { path: string; rev: Rev }) => void>();
  return {
    rev,
    files,
    allFiles: () => ({ ...files }),
    onChange(cb: (c: { path: string; rev: Rev }) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emitChange(path: string) {
      this.rev += 1;
      for (const l of listeners) l({ path, rev: this.rev });
    },
  };
}

function fakeHistory(store: ReturnType<typeof fakeStore>, changeSets: ChangeSet[], green?: Snapshot) {
  const snapshots: Snapshot[] = green ? [green] : [];
  return {
    snapshots,
    saveSnapshot(isGreen: boolean): Snapshot {
      const s: Snapshot = { rev: store.rev, files: store.allFiles(), green: isGreen, at: Date.now() };
      snapshots.push(s);
      return s;
    },
    lastGreen: () => [...snapshots].reverse().find((s) => s.green),
    changeSetsSince: (rev: Rev) => changeSets.filter((c) => c.endRev > rev).sort((a, b) => a.endRev - b.endRev),
  };
}

function fakeIntents(list: Intent[]) {
  const statuses: { id: string; status: IntentStatus }[] = [];
  return {
    statuses,
    get: (id: string) => list.find((i) => i.id === id),
    list: () => list,
    setStatus(id: string, status: IntentStatus) {
      statuses.push({ id, status });
      const i = list.find((x) => x.id === id);
      if (i) i.status = status;
    },
  };
}

function fakeBriefings() {
  const all: Briefing[] = [];
  return {
    all,
    push(b: Omit<Briefing, "id" | "createdAt">): Briefing {
      const full = { ...b, id: `br_${all.length + 1}`, createdAt: Date.now() };
      all.push(full);
      return full;
    },
  };
}

function intentOf(cs: ChangeSet, extra: Partial<Intent> = {}): Intent {
  return {
    id: cs.id,
    agentId: cs.agentId,
    humanId: cs.humanId,
    status: "done",
    createdAt: 0,
    updatedAt: 0,
    baseRev: cs.baseRev,
    endRev: cs.endRev,
    target: { file: cs.files[0]!, symbol: "calculateTotal" },
    action: "modify",
    what: cs.what,
    input: "items, promo",
    output: `output of ${cs.id}`,
    ...extra,
  };
}

/** Runner whose verdict depends on the files, so the culprit finder gets meaningful variants. */
function predicateRunner(isGreen: (files: Record<string, string>) => boolean) {
  const calls: { files: Record<string, string>; filter?: string }[] = [];
  const runner: Runner = {
    async runTests(files, opts) {
      calls.push({ files, filter: opts?.filter });
      const ok = isGreen(files);
      const r: TestResult = { ok, passed: ok ? 5 : 4, failed: ok ? 0 : 1, failures: ok ? [] : [{ name: "calculateTotal > applies a percent promo", message: "expected 9000" }], durationMs: 3 };
      return r;
    },
    async runCommand() {
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    },
  };
  return { runner, calls };
}

function setup(opts: {
  files: Record<string, string>;
  changeSets: ChangeSet[];
  intents: Intent[];
  isGreen: (files: Record<string, string>) => boolean;
  readers?: Record<string, string[]>;
  callers?: { file: string; line: number; caller: string | null; callee: string }[];
  mode?: "hive" | "naive" | "isolated";
}) {
  const store = fakeStore(opts.files, 10);
  const green: Snapshot = { rev: 0, files: { ...DEMO_APP_FILES }, green: true, at: 0 };
  const history = fakeHistory(store, opts.changeSets, green);
  const intents = fakeIntents(opts.intents);
  const briefings = fakeBriefings();
  const events: FeedEventBody[] = [];
  const { runner, calls } = predicateRunner(opts.isGreen);
  const deps: TestOrchestratorDeps = {
    store,
    history,
    intents,
    briefings,
    reads: { readersOf: (path, symbol) => (opts.readers?.[`${path}#${symbol ?? ""}`] ?? []).map((agentId) => ({ agentId, rev: 1 })) },
    graph: { callersOf: (symbol) => (opts.callers ?? []).filter((c) => c.callee === symbol) },
    runner,
    culprit: new CulpritFinder(runner, 4),
    onEvent: (e) => events.push(e),
    mode: opts.mode ?? "hive",
    quietMs: 20,
    maxQuietWaitMs: 200,
  };
  return { deps, store, history, intents, briefings, events, calls, orchestrator: new TestOrchestrator(deps) };
}

const alwaysGreen = () => true;

describe("TestOrchestrator", () => {
  it("8a. green path: waits for quiet, runs the suite, marks verified, saves a green snapshot", async () => {
    const cs = harmlessFormatChange();
    const t = setup({ files: DEMO_APP_FILES, changeSets: [cs], intents: [intentOf(cs)], isGreen: alwaysGreen });
    const started = Date.now();
    const p = t.orchestrator.onIntentFinished("A1");
    // keep the store busy for a moment: the run must not start before it goes quiet
    t.store.emitChange("src/format.ts");
    await new Promise((r) => setTimeout(r, 10));
    t.store.emitChange("src/format.ts");
    await p;
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(t.calls.length).toBe(1);
    expect(t.intents.statuses).toEqual([{ id: "A1", status: "verified" }]);
    const greens = t.history.snapshots.filter((s) => s.green);
    expect(greens.length).toBe(2);
    expect(greens[1]!.rev).toBe(t.store.rev);
    const types = t.events.map((e) => e.type);
    expect(types).toEqual(["test_run_started", "test_run_finished"]);
    const finished = t.events[1] as Extract<FeedEventBody, { type: "test_run_finished" }>;
    expect(finished.result.ok).toBe(true);
    expect((t.events[0] as Extract<FeedEventBody, { type: "test_run_started" }>).reason).toContain("A1");
    expect(t.briefings.all).toEqual([]);
  });

  it("8b. red path, single culprit: culprit events, failed status, briefing to the culprit's owner only", async () => {
    const s1 = harmlessFormatChange();
    const s2 = breakDiscount();
    const t = setup({
      files: applyAll(DEMO_APP_FILES, [s1, s2]),
      changeSets: [s1, s2],
      intents: [intentOf(s1, { status: "verified" }), intentOf(s2)],
      // red whenever the broken discount is present
      isGreen: (files) => !files["src/discount.ts"]!.includes("Math.floor"),
    });
    await t.orchestrator.onIntentFinished("B1");
    const types = t.events.map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["test_run_started", "test_run_finished", "culprit_search_started"]);
    expect(types.filter((x) => x === "culprit_variant_result").length).toBe(4);
    expect(types[types.length - 1]).toBe("culprit_found");
    const found = t.events[t.events.length - 1] as Extract<FeedEventBody, { type: "culprit_found" }>;
    expect(found.report.kind).toBe("single");
    expect(found.report.culprits).toEqual(["B1"]);
    const search = t.events[2] as Extract<FeedEventBody, { type: "culprit_search_started" }>;
    expect(search.suspects).toEqual(["A1", "B1"]);
    expect(search.searchId).toBe(found.searchId);
    expect(t.intents.statuses).toEqual([{ id: "B1", status: "failed" }]);
    expect(t.history.snapshots.filter((s) => s.green).length).toBe(1);
    expect(t.briefings.all.length).toBe(1);
    const b = t.briefings.all[0]!;
    expect(b.toAgent).toBe("agent-masha");
    expect(b.kind).toBe("culprit");
    expect(b.requiresAck).toBe(true);
    expect(b.summary.length).toBeLessThanOrEqual(400);
    expect(b.details.intentId).toBe("B1");
    expect(b.details.failingTests?.[0]?.name).toContain("calculateTotal");
  });

  it("8c. red path, pair: both owners get a briefing naming both promised outputs", async () => {
    const s1 = taxInCalculateTotal();
    const s2 = taxLineInOrderSummary();
    const t = setup({
      files: applyAll(DEMO_APP_FILES, [s1, s2]),
      changeSets: [s1, s2],
      intents: [intentOf(s1, { output: "total includes CA tax" }), intentOf(s2, { output: "orderSummary has a tax line" })],
      isGreen: (files) => !(files["src/checkout.ts"]!.includes("applyTax") && files["src/order.ts"]!.includes("applyTax")),
    });
    await t.orchestrator.onIntentFinished("B2");
    const found = t.events.find((e) => e.type === "culprit_found") as Extract<FeedEventBody, { type: "culprit_found" }>;
    expect(found.report.kind).toBe("pair");
    expect(found.report.culprits).toEqual(["A2", "B2"]);
    expect(t.briefings.all.map((b) => b.toAgent).sort()).toEqual(["agent-andrii", "agent-masha"]);
    for (const b of t.briefings.all) {
      expect(b.kind).toBe("culprit");
      expect(b.summary).toContain("total includes CA tax");
      expect(b.summary).toContain("orderSummary has a tax line");
    }
    expect(t.intents.statuses.map((s) => s.id).sort()).toEqual(["A2", "B2"]);
    expect(t.intents.statuses.every((s) => s.status === "failed")).toBe(true);
  });

  it("8d. red path, unknown: every suspect's owner is briefed once", async () => {
    const s1 = harmlessFormatChange();
    const s2 = breakDiscount();
    const t = setup({ files: DEMO_APP_FILES, changeSets: [s1, s2], intents: [intentOf(s1), intentOf(s2)], isGreen: () => false });
    await t.orchestrator.onIntentFinished("B1");
    const found = t.events.find((e) => e.type === "culprit_found") as Extract<FeedEventBody, { type: "culprit_found" }>;
    expect(found.report.kind).toBe("unknown");
    expect(t.briefings.all.map((b) => b.toAgent).sort()).toEqual(["agent-andrii", "agent-masha"]);
  });

  it("9. check failure -> intent failed, verification_failed to the owner and to dependents, no suite run", async () => {
    const cs = harmlessFormatChange();
    const intent = intentOf(cs, {
      target: { file: "src/format.ts", symbol: "formatPrice" },
      check: `expect(formatPrice(1234)).toBe("$12.34");\nexpect(formatPrice(0)).toBe("$0.00");`,
    });
    const t = setup({
      files: DEMO_APP_FILES,
      changeSets: [cs],
      intents: [
        intent,
        intentOf(breakDiscount(), { id: "C9", agentId: "agent-caller", target: { file: "src/order.ts", symbol: "orderSummary" }, status: "in_progress" }),
      ],
      // the check run (has the temp test file) fails; anything else is green
      isGreen: (files) => !(CHECK_TEST_PATH in files),
      readers: { "src/format.ts#formatPrice": ["agent-masha", "agent-andrii"] },
      callers: [{ file: "src/order.ts", line: 20, caller: "orderSummary", callee: "formatPrice" }],
    });
    await t.orchestrator.onIntentFinished("A1");
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]!.filter).toBe("__hive_check__");
    const src = t.calls[0]!.files[CHECK_TEST_PATH]!;
    expect(src).toContain(`from "../src/format.js"`);
    expect(src).toContain(`expect(formatPrice(1234)).toBe("$12.34");`);
    expect(t.intents.statuses).toEqual([{ id: "A1", status: "failed" }]);
    const kinds = t.briefings.all.map((b) => `${b.kind}->${b.toAgent}`).sort();
    expect(kinds).toEqual(["verification_failed->agent-andrii", "verification_failed->agent-caller", "verification_failed->agent-masha"]);
    for (const b of t.briefings.all) expect(b.details.intentId).toBe("A1");
    expect(t.events.map((e) => e.type)).toEqual(["test_run_started", "test_run_finished"]);
    expect((t.events[0] as Extract<FeedEventBody, { type: "test_run_started" }>).reason).toContain("check");
    expect(t.history.snapshots.filter((s) => s.green).length).toBe(1);
  });

  it("9b. check passes -> suite runs next and the intent is verified", async () => {
    const cs = harmlessFormatChange();
    const t = setup({
      files: DEMO_APP_FILES,
      changeSets: [cs],
      intents: [intentOf(cs, { target: { file: "src/format.ts", symbol: "formatPrice" }, check: `expect(formatPrice(5)).toBe("$0.05");` })],
      isGreen: alwaysGreen,
    });
    await t.orchestrator.onIntentFinished("A1");
    expect(t.calls.map((c) => c.filter)).toEqual(["__hive_check__", undefined]);
    expect(t.intents.statuses).toEqual([{ id: "A1", status: "verified" }]);
  });

  it("naive mode: tests run, red result produces no culprit search and no briefings", async () => {
    const s2 = breakDiscount();
    const t = setup({ files: DEMO_APP_FILES, changeSets: [s2], intents: [intentOf(s2)], isGreen: () => false, mode: "naive" });
    await t.orchestrator.onIntentFinished("B1");
    expect(t.events.map((e) => e.type)).toEqual(["test_run_started", "test_run_finished"]);
    expect(t.briefings.all).toEqual([]);
  });

  it("serializes concurrent onIntentFinished calls", async () => {
    const s1 = harmlessFormatChange();
    const s2 = { ...breakDiscount(), edits: [] };
    const t = setup({ files: DEMO_APP_FILES, changeSets: [s1, s2], intents: [intentOf(s1), intentOf(s2)], isGreen: alwaysGreen });
    await Promise.all([t.orchestrator.onIntentFinished("A1"), t.orchestrator.onIntentFinished("B1")]);
    expect(t.calls.length).toBe(2);
    expect(t.intents.statuses).toEqual([
      { id: "A1", status: "verified" },
      { id: "B1", status: "verified" },
    ]);
  });

  it("checkTestSource imports the target with a .js extension and wraps the lines in one it()", () => {
    const cs = harmlessFormatChange();
    const src = checkTestSource(intentOf(cs, { id: "Z1", target: { file: "src/checkout.ts", symbol: "calculateTotal" }, check: "expect(calculateTotal([])).toBe(0);" }));
    expect(src).toContain(`import * as __target from "../src/checkout.js";`);
    expect(src).toContain(`it("__hive_check__ Z1"`);
    expect(src).toContain("  expect(calculateTotal([])).toBe(0);");
  });
});
