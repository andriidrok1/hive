import type { Briefing, ChangeSet, FeedEventBody, Intent, IntentStatus, Rev, Runner, Snapshot, TestResult } from "@hive/shared";
import { describe, expect, it } from "vitest";
import { History, ProjectStore, ReadLog } from "../../src/core/index.js";
import { BriefingQueue, CallGraph, IntentRegistry } from "../../src/coord/index.js";
import { CulpritFinder } from "../../src/runner/CulpritFinder.js";
import { checkTestSource, CHECK_TEST_PATH, classifyCheck, exportedValueNames, isTestFile, TestOrchestrator, type TestOrchestratorDeps } from "../../src/runner/TestOrchestrator.js";
import { LocalRunner } from "../../src/runner/LocalRunner.js";
import { applyAll, breakDiscount, dependentPair, harmlessFormatChange, taxInCalculateTotal, taxLineInOrderSummary } from "./fixtures/changeSets.js";
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

type OpenSpec = string | { intentId: string; agentId: string; files?: string[] };
function fakeHistory(store: ReturnType<typeof fakeStore>, changeSets: ChangeSet[], green?: Snapshot, opts: { open?: OpenSpec[] } = {}) {
  const snapshots: Snapshot[] = green ? [green] : [];
  const h = {
    snapshots,
    saveCalls: [] as { green: boolean; view?: { rev: Rev; files: Record<string, string> } }[],
    saveSnapshot(isGreen: boolean, view?: { rev: Rev; files: Record<string, string> }): Snapshot {
      h.saveCalls.push({ green: isGreen, view });
      const s: Snapshot = view ? { rev: view.rev, files: { ...view.files }, green: isGreen, at: Date.now() } : { rev: store.rev, files: store.allFiles(), green: isGreen, at: Date.now() };
      snapshots.push(s);
      return s;
    },
    lastGreen: () => [...snapshots].reverse().find((s) => s.green),
    changeSetsSince: (rev: Rev) => changeSets.filter((c) => c.endRev > rev).sort((a, b) => a.endRev - b.endRev),
    openIntents: (agentId?: string) =>
      (opts.open ?? [])
        .map((o) => (typeof o === "string" ? { intentId: o, agentId: `agent-${o.toLowerCase()}`, files: [] as string[] } : { intentId: o.intentId, agentId: o.agentId, files: o.files ?? [] }))
        .filter((o) => agentId === undefined || o.agentId === agentId),
  };
  return h;
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
function predicateRunner(isGreen: (files: Record<string, string>) => boolean, failureMessage = "AssertionError: expected 9000 to be 9653", failure = { name: "calculateTotal > applies a percent promo" }) {
  const calls: { files: Record<string, string>; filter?: string }[] = [];
  const runner: Runner = {
    async runTests(files, opts) {
      calls.push({ files, filter: opts?.filter });
      const ok = isGreen(files);
      const r: TestResult = { ok, passed: ok ? 5 : 4, failed: ok ? 0 : 1, failures: ok ? [] : [{ name: failure.name, message: failureMessage }], durationMs: 3 };
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
  failureMessage?: string;
  failure?: { name: string };
  culpritCooldownMs?: number;
  open?: OpenSpec[];
}) {
  const store = fakeStore(opts.files, 10);
  const green: Snapshot = { rev: 0, files: { ...DEMO_APP_FILES }, green: true, at: 0 };
  const history = fakeHistory(store, opts.changeSets, green, { open: opts.open });
  const intents = fakeIntents(opts.intents);
  const briefings = fakeBriefings();
  const events: FeedEventBody[] = [];
  const { runner, calls } = predicateRunner(opts.isGreen, opts.failureMessage, opts.failure);
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
    culpritCooldownMs: opts.culpritCooldownMs,
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
    expect(greens[1]!.rev).toBe(cs.endRev); // pinned to the verified view, not the live store rev
    expect(t.history.saveCalls[0]!.view?.files).toEqual(applyAll(DEMO_APP_FILES, [cs]));
    const types = t.events.map((e) => e.type);
    expect(types).toEqual(["test_run_started", "test_run_finished"]);
    const finished = t.events[1] as Extract<FeedEventBody, { type: "test_run_finished" }>;
    expect(finished.result.ok).toBe(true);
    expect((t.events[0] as Extract<FeedEventBody, { type: "test_run_started" }>).reason).toBe("intent A1 finished (view: 1 finished set, excluded in-progress: none)");
    expect(t.briefings.all).toEqual([]);
  });

  it("8g. view: a finished intent is green on its view although another agent's in-progress edit breaks the live store", async () => {
    const a1 = harmlessFormatChange();
    const live = applyAll(DEMO_APP_FILES, [a1, breakDiscount()]); // masha's M1 is in progress: broken discount is in the live store
    const t = setup({
      files: live,
      changeSets: [a1],
      intents: [intentOf(a1)],
      isGreen: (files) => !files["src/discount.ts"]!.includes("Math.floor"),
      open: [
        { intentId: "M1", agentId: "agent-masha", files: ["src/discount.ts", "test/discount.test.ts"] },
        { intentId: "A5", agentId: "agent-andrii", files: ["src/order.ts"] }, // the finishing agent's own open intent: not listed
        { intentId: "A1", agentId: "agent-andrii" }, // the intent being finished itself: not listed
        { intentId: "M2", agentId: "agent-masha" }, // no files yet: bare id
        { intentId: "", agentId: "agent-bob" }, // never an empty entry
      ],
    });
    await t.orchestrator.onIntentFinished("A1");
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]!.files["src/discount.ts"]).toBe(DEMO_APP_FILES["src/discount.ts"]); // M1's edit excluded
    expect(t.calls[0]!.files["src/format.ts"]).toBe(applyAll(DEMO_APP_FILES, [a1])["src/format.ts"]); // A1 included
    expect(t.intents.statuses).toEqual([{ id: "A1", status: "verified" }]);
    const started = t.events[0] as Extract<FeedEventBody, { type: "test_run_started" }>;
    expect(started.reason).toBe("intent A1 finished (view: 1 finished set, excluded in-progress: M1 (src/discount.ts, test/discount.test.ts), M2)");
    expect(started.rev).toBe(a1.endRev);
    expect(t.history.saveCalls).toEqual([{ green: true, view: { rev: a1.endRev, files: applyAll(DEMO_APP_FILES, [a1]) } }]);
    expect(t.history.lastGreen()!.files["src/discount.ts"]).toBe(DEMO_APP_FILES["src/discount.ts"]);
    expect(t.events.filter((e) => e.type === "culprit_search_started")).toEqual([]);
  });

  it("8h. view fallback: when buildView fails (a finished set does not apply on the base) the live files are tested and the reason says so", async () => {
    const { d2 } = dependentPair(); // B3 only applies on top of A3, which is not finished
    const live = applyAll(DEMO_APP_FILES, [breakDiscount()]);
    const t = setup({
      files: live,
      changeSets: [d2],
      intents: [intentOf(d2, { target: { file: "src/format.ts", symbol: "formatPrice" } })],
      isGreen: (files) => !files["src/discount.ts"]!.includes("Math.floor"),
      open: ["M1"],
    });
    await t.orchestrator.onIntentFinished("B3");
    expect(t.calls[0]!.files).toEqual(live);
    const started = t.events[0] as Extract<FeedEventBody, { type: "test_run_started" }>;
    expect(started.reason).toBe("intent B3 finished (fallback: live, view failed at src/format.ts#0 of B3)");
    expect(started.rev).toBe(t.store.rev);
    // live is red: a search over the finished sets runs against the green base
    expect(t.events.some((e) => e.type === "culprit_search_started")).toBe(true);
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

  it("8d. red path, unknown: nobody is failed, each suspect owner gets one non-blocking note", async () => {
    const s1 = harmlessFormatChange();
    const s1b = { ...harmlessFormatChange(), id: "A1b", edits: [], endRev: 2 };
    const s2 = { ...breakDiscount(), endRev: 3 };
    const t = setup({ files: DEMO_APP_FILES, changeSets: [s1, s1b, s2], intents: [intentOf(s1), intentOf(s1b), intentOf(s2)], isGreen: () => false });
    await t.orchestrator.onIntentFinished("B1");
    const found = t.events.find((e) => e.type === "culprit_found") as Extract<FeedEventBody, { type: "culprit_found" }>;
    expect(found.report.kind).toBe("unknown");
    expect(t.intents.statuses).toEqual([]);
    expect(t.briefings.all.map((b) => b.toAgent).sort()).toEqual(["agent-andrii", "agent-masha"]);
    for (const b of t.briefings.all) {
      expect(b.kind).toBe("verification_failed");
      expect(b.requiresAck).toBe(false);
    }
    const andrii = t.briefings.all.find((b) => b.toAgent === "agent-andrii")!;
    expect(andrii.summary).toBe("Tests are red after your intents A1, A1b, cause unclear; failing: calculateTotal > applies a percent promo");
  });

  it("8e. cooldown: a second red run within 20s with the same failing tests skips the culprit search; a new failure set runs it", async () => {
    const s1 = harmlessFormatChange();
    const s2 = breakDiscount();
    const failure = { name: "calculateTotal > applies a percent promo" };
    const t = setup({
      files: applyAll(DEMO_APP_FILES, [s1, s2]),
      changeSets: [s1, s2],
      intents: [intentOf(s1), intentOf(s2)],
      isGreen: (files) => !files["src/discount.ts"]!.includes("Math.floor"),
      failure,
    });
    await t.orchestrator.onIntentFinished("B1");
    expect(t.events.filter((e) => e.type === "culprit_search_started").length).toBe(1);
    const runsAfterFirst = t.events.filter((e) => e.type === "test_run_finished").length;

    await t.orchestrator.onIntentFinished("A1");
    expect(t.events.filter((e) => e.type === "test_run_finished").length).toBe(runsAfterFirst + 1);
    expect(t.events.filter((e) => e.type === "culprit_search_started").length).toBe(1);

    failure.name = "orderSummary > renders three lines";
    await t.orchestrator.onIntentFinished("A1");
    expect(t.events.filter((e) => e.type === "culprit_search_started").length).toBe(2);
  });

  it("8f. cooldown expires: the same failure after the window is searched again", async () => {
    const s2 = breakDiscount();
    const t = setup({ files: applyAll(DEMO_APP_FILES, [s2]), changeSets: [s2], intents: [intentOf(s2)], isGreen: () => false, culpritCooldownMs: 30 });
    await t.orchestrator.onIntentFinished("B1");
    await new Promise((r) => setTimeout(r, 40));
    await t.orchestrator.onIntentFinished("B1");
    expect(t.events.filter((e) => e.type === "culprit_search_started").length).toBe(2);
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

  it("9d. invalid check (ReferenceError) -> not failed, non-blocking briefing to the owner, suite still runs", async () => {
    const cs = harmlessFormatChange();
    const t = setup({
      files: DEMO_APP_FILES,
      changeSets: [cs],
      intents: [intentOf(cs, { target: { file: "src/checkout.ts", symbol: "calculateTotal" }, check: `expect(calculateTotal(items)).toBe(10000);` })],
      isGreen: (files) => !(CHECK_TEST_PATH in files),
      failureMessage: "ReferenceError: items is not defined\n ❯ test/__hive_check__.test.ts:5:30",
      readers: { "src/checkout.ts#calculateTotal": ["agent-masha"] },
    });
    await t.orchestrator.onIntentFinished("A1");
    expect(t.calls.map((c) => c.filter)).toEqual(["__hive_check__", undefined]);
    expect(t.intents.statuses).toEqual([{ id: "A1", status: "verified" }]);
    expect(t.briefings.all.length).toBe(1);
    const b = t.briefings.all[0]!;
    expect(b.toAgent).toBe("agent-andrii");
    expect(b.kind).toBe("verification_failed");
    expect(b.requiresAck).toBe(false);
    expect(b.summary).toBe("Your check for A1 could not run: ReferenceError: items is not defined. Re-declare with a self-contained check; code was not judged.");
    expect(t.history.snapshots.filter((s) => s.green).length).toBe(2);
    expect(t.events.map((e) => e.type)).toEqual(["test_run_started", "test_run_finished", "test_run_started", "test_run_finished"]);
  });

  it("9e. classifyCheck on real vitest output: ReferenceError/SyntaxError -> invalid, expect failure -> failed", async () => {
    const local = new LocalRunner({ templateDir: "demo-app" });
    const run = (check: string) => {
      const intent = intentOf(harmlessFormatChange(), { id: "C1", target: { file: "src/tax.ts", symbol: "applyTax" }, check });
      return local.runTests({ ...DEMO_APP_FILES, [CHECK_TEST_PATH]: checkTestSource(intent, DEMO_APP_FILES["src/tax.ts"]) }, { filter: "__hive_check__" });
    };
    const [ref, syntax, type, assertion, ok] = await Promise.all([
      run(`expect(applyTax(items, "CA")).toBe(10725);`),
      run(`expect(applyTax(10000, "CA")).toBe(10725;`),
      run(`expect(applyTax.nope()).toBe(1);`),
      run(`expect(applyTax(10000, "CA")).toBe(1);`),
      run(`expect(applyTax(10000, "CA")).toBe(10725);`),
    ]);
    expect(classifyCheck(ref)).toBe("invalid");
    expect(classifyCheck(syntax)).toBe("invalid");
    expect(classifyCheck(type)).toBe("invalid");
    expect(classifyCheck(assertion)).toBe("failed");
    expect(classifyCheck(ok)).toBe("ok");
    expect(ref.failures[0]!.message).toContain("items is not defined");
  }, 90_000);

  it("9f. an intent targeting a test file skips its check: suite only, verified", async () => {
    const cs = { ...harmlessFormatChange(), files: ["test/format.test.ts"] };
    const t = setup({
      files: DEMO_APP_FILES,
      changeSets: [cs],
      intents: [intentOf(cs, { target: { file: "test/format.test.ts", symbol: "formatPrice" }, action: "add", check: `expect(formatPrice(5)).toBe("$0.05");` })],
      isGreen: (files) => !(CHECK_TEST_PATH in files), // a check run would be red
    });
    await t.orchestrator.onIntentFinished("A1");
    expect(t.calls.map((c) => c.filter)).toEqual([undefined]);
    expect(CHECK_TEST_PATH in t.calls[0]!.files).toBe(false);
    expect(t.intents.statuses).toEqual([{ id: "A1", status: "verified" }]);
    expect(t.briefings.all).toEqual([]);
    expect(t.events.map((e) => e.type)).toEqual(["test_run_started", "test_run_finished"]);
    expect((t.events[0] as Extract<FeedEventBody, { type: "test_run_started" }>).reason).toContain("intent A1 finished");
    expect(isTestFile("test/order.test.ts")).toBe(true);
    expect(isTestFile("src/order.test.ts")).toBe(true);
    expect(isTestFile("src/__tests__/x.spec.tsx")).toBe(true);
    expect(isTestFile("src/order.ts")).toBe(false);
    expect(isTestFile("src/testing.ts")).toBe(false);
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
    expect(src).toContain(`import { describe, expect, it } from "vitest";`);
    expect(src).toContain(`import * as __target from "../src/checkout.js";`);
    expect(src).toContain(`it("__hive_check__ Z1"`);
    expect(src).toContain("  expect(calculateTotal([])).toBe(0);");
  });

  it("checkTestSource binds every value export of the target file, not only the target symbol", () => {
    const cs = harmlessFormatChange();
    const src = checkTestSource(intentOf(cs, { id: "Z2", target: { file: "src/tax.ts", symbol: "applyTax" }, check: "expect(1).toBe(1);" }), DEMO_APP_FILES["src/tax.ts"]);
    expect(src).toContain("const { applyTax, TAX_RATES } = __target");
    expect(src).not.toMatch(/\bState\b/); // types are not runtime values
    expect(exportedValueNames(DEMO_APP_FILES["src/checkout.ts"]!).sort()).toEqual(["calculateTotal", "subtotal"]);
    expect(exportedValueNames(`export class A {}\nexport default function b() {}\nexport enum E {}\nexport type T = 1;\nexport interface I {}\nconst c = 1, d = 2;\nexport { c, d as dee, type T as TT };\nexport let l = 1;`).sort()).toEqual(["A", "E", "b", "c", "dee", "l"]);
  });

  it("9c. a check that references a sibling export (TAX_RATES next to applyTax) passes on the real LocalRunner", async () => {
    const local = new LocalRunner({ templateDir: "demo-app" });
    const cs = harmlessFormatChange();
    const intent = intentOf(cs, {
      id: "T1",
      target: { file: "src/tax.ts", symbol: "applyTax" },
      check: `expect(applyTax(10000, "CA")).toBe(Math.round(10000 * (1 + TAX_RATES.CA)));\nexpect(TAX_RATES.OR).toBe(0);`,
    });
    const files = { ...DEMO_APP_FILES, [CHECK_TEST_PATH]: checkTestSource(intent, DEMO_APP_FILES["src/tax.ts"]) };
    const r = await local.runTests(files, { filter: "__hive_check__" });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(1);

    // and a failing check is still red
    const bad = { ...intent, check: `expect(applyTax(10000, "CA")).toBe(TAX_RATES.CA);` };
    const red = await local.runTests({ ...DEMO_APP_FILES, [CHECK_TEST_PATH]: checkTestSource(bad, DEMO_APP_FILES["src/tax.ts"]) }, { filter: "__hive_check__" });
    expect(red.ok).toBe(false);
    expect(red.failures[0]!.name).toContain("__hive_check__ T1");
  }, 60_000);
});
