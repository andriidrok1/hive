import type {
  AgentId,
  Briefing,
  CallSite,
  ChangeSet,
  CulpritReport,
  FeedEventBody,
  HiveMode,
  Intent,
  IntentId,
  IntentStatus,
  Rev,
  Runner,
  Snapshot,
  TestResult,
} from "@hive/shared";
import type { CulpritFinder } from "./CulpritFinder.js";
import { runId } from "./util.js";

// Structural views of the core/coord classes this module uses (CONTRACTS.md). The real
// ProjectStore, History, IntentRegistry, BriefingQueue, ReadLog and CallGraph satisfy them.
export interface StoreLike {
  readonly rev: Rev;
  allFiles(): Record<string, string>;
  onChange(cb: (c: { path: string; rev: Rev }) => void): () => void;
}
export interface HistoryLike {
  saveSnapshot(green: boolean): Snapshot;
  lastGreen(): Snapshot | undefined;
  changeSetsSince(rev: Rev): ChangeSet[];
}
export interface IntentsLike {
  get(id: IntentId): Intent | undefined;
  list(): Intent[];
  setStatus(id: IntentId, status: IntentStatus): void;
}
export interface BriefingsLike {
  push(b: Omit<Briefing, "id" | "createdAt">): Briefing;
}
export interface ReadsLike {
  readersOf(path: string, symbol?: string): { agentId: AgentId; rev: Rev }[];
}
export interface GraphLike {
  callersOf(symbol: string): CallSite[];
}

export interface TestOrchestratorDeps {
  store: StoreLike;
  history: HistoryLike;
  intents: IntentsLike;
  briefings: BriefingsLike;
  reads: ReadsLike;
  graph: GraphLike;
  runner: Runner;
  culprit: CulpritFinder;
  onEvent: (e: FeedEventBody) => void;
  mode: HiveMode;
  /** Quiet period before snapshotting (ms). Default 1000. */
  quietMs?: number;
  /** Max wait for quiet (ms). Default 5000. */
  maxQuietWaitMs?: number;
}

export const CHECK_TEST_PATH = "test/__hive_check__.test.ts";
const CHECK_TEST_NAME = "__hive_check__";

/**
 * After an intent finishes: wait for the store to go quiet, run the intent's check, run the full
 * suite, and either save a green snapshot or run the culprit search and brief the owners.
 */
export class TestOrchestrator {
  private readonly deps: TestOrchestratorDeps;
  private readonly initial: Snapshot;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: TestOrchestratorDeps) {
    this.deps = deps;
    // Fallback green baseline when history has no green snapshot: rev 0 = initial files.
    this.initial = { rev: deps.store.rev, files: deps.store.allFiles(), green: true, at: Date.now() };
  }

  /** Serialized: a second finished intent waits for the current run. */
  onIntentFinished(intentId: IntentId): Promise<void> {
    const run = this.queue.then(() => this.handle(intentId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async handle(intentId: IntentId): Promise<void> {
    const { store, history, intents, runner, onEvent, mode } = this.deps;
    await this.waitForQuiet();
    const rev = store.rev;
    const files = store.allFiles();
    const intent = intents.get(intentId);

    if (mode === "hive" && intent?.check && intent.action !== "delete") {
      const checkRun = runId("check");
      onEvent({ type: "test_run_started", runId: checkRun, rev, reason: `check ${intentId}` });
      const checkResult = await this.safeRun(() =>
        runner.runTests({ ...files, [CHECK_TEST_PATH]: checkTestSource(intent) }, { filter: CHECK_TEST_NAME }),
      );
      onEvent({ type: "test_run_finished", runId: checkRun, rev, result: checkResult });
      if (!checkResult.ok) {
        intents.setStatus(intentId, "failed");
        this.briefVerificationFailed(intent, checkResult);
        return;
      }
    }

    const suiteRun = runId("test");
    onEvent({ type: "test_run_started", runId: suiteRun, rev, reason: `intent ${intentId} finished` });
    const result = await this.safeRun(() => runner.runTests(files));
    onEvent({ type: "test_run_finished", runId: suiteRun, rev, result });

    if (result.ok) {
      history.saveSnapshot(true);
      if (intent) intents.setStatus(intentId, "verified");
      return;
    }

    if (mode !== "hive") return; // naive / isolated: tests run, no culprit search, no briefings

    const green = history.lastGreen() ?? this.initial;
    const suspects = history.changeSetsSince(green.rev);
    if (suspects.length === 0) {
      if (intent) {
        intents.setStatus(intentId, "failed");
        this.push(intent.agentId, "culprit", `Tests are red after ${intentId} finished and no change set explains it; your intent is marked failed.`, {
          intentId,
          file: intent.target.file,
          symbol: intent.target.symbol,
          failingTests: result.failures.slice(0, 10),
        });
      }
      return;
    }

    const searchId = runId("culprit");
    onEvent({ type: "culprit_search_started", searchId, suspects: suspects.map((s) => s.id) });
    const report = await this.deps.culprit.find(green, suspects, (variant) => onEvent({ type: "culprit_variant_result", searchId, variant }));
    onEvent({ type: "culprit_found", searchId, report });
    this.applyReport(report, suspects, result, intentId);
  }

  private applyReport(report: CulpritReport, suspects: ChangeSet[], result: TestResult, finishedId: IntentId): void {
    const { intents } = this.deps;
    const byId = new Map(suspects.map((s) => [s.id, s]));
    const culpritIds = report.culprits.length > 0 ? report.culprits : [finishedId];
    for (const id of culpritIds) {
      const st = intents.get(id)?.status;
      if (st === "done" || st === "verified" || st === "in_progress" || st === "approved") intents.setStatus(id, "failed");
    }
    const failing = result.failures.slice(0, 10);
    const describe = (id: IntentId): string => {
      const intent = intents.get(id);
      const cs = byId.get(id);
      const what = intent?.what ?? cs?.what ?? id;
      return intent ? `${id} (${what}; promised: ${intent.output})` : `${id} (${what})`;
    };
    const ownerOf = (id: IntentId): AgentId | undefined => intents.get(id)?.agentId ?? byId.get(id)?.agentId;
    const detailsFor = (id: IntentId): Briefing["details"] => {
      const intent = intents.get(id);
      return { intentId: id, file: intent?.target.file, symbol: intent?.target.symbol, failingTests: failing, diff: byId.get(id)?.patch.slice(0, 2000) };
    };

    if (report.kind === "single") {
      const id = report.culprits[0]!;
      const owner = ownerOf(id);
      if (owner) {
        this.push(owner, "culprit", clip(`Tests fail because of your change set ${describe(id)}. With it removed the suite is green. Fix it or revert.`), detailsFor(id));
      }
      return;
    }
    if (report.kind === "pair") {
      const [a, b] = report.culprits as [IntentId, IntentId];
      for (const [mine, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const owner = ownerOf(mine);
        if (!owner) continue;
        this.push(
          owner,
          "culprit",
          clip(`Your change set ${describe(mine)} and ${describe(other)} are each green alone but red together. Coordinate with ${ownerOf(other) ?? "the other agent"}: one of the two promised outputs must change.`),
          detailsFor(mine),
        );
      }
      return;
    }
    // dependent / unknown: every suspect's owner
    const owners = new Map<AgentId, IntentId[]>();
    for (const id of culpritIds) {
      const owner = ownerOf(id);
      if (!owner) continue;
      owners.set(owner, [...(owners.get(owner) ?? []), id]);
    }
    const why = report.kind === "dependent" ? "a change set only applies on top of another, so they could not be isolated" : "no single change set or pair explains the failure";
    for (const [owner, ids] of owners) {
      this.push(
        owner,
        "culprit",
        clip(`Tests are red and ${why}. Suspects: ${culpritIds.join(", ")}. Yours: ${ids.map(describe).join("; ")}. Check the failing tests.`),
        detailsFor(ids[0]!),
      );
    }
  }

  private briefVerificationFailed(intent: Intent, result: TestResult): void {
    const failing = result.failures.slice(0, 10);
    const base = { intentId: intent.id, file: intent.target.file, symbol: intent.target.symbol, failingTests: failing };
    this.push(intent.agentId, "verification_failed", clip(`Your intent ${intent.id} (${intent.what}) failed its own check: ${failing[0]?.message ?? "check failed"}. Promised: ${intent.output}`), base);
    for (const agentId of this.dependentsOf(intent)) {
      this.push(
        agentId,
        "verification_failed",
        clip(`${intent.agentId} finished ${intent.id} on ${intent.target.symbol} (${intent.target.file}) but it failed its check, so the promised output "${intent.output}" does not hold yet. Do not rely on it.`),
        base,
      );
    }
  }

  /** Agents (other than the owner) that read the target symbol, or whose intents target a caller of it. */
  private dependentsOf(intent: Intent): AgentId[] {
    const { reads, graph, intents } = this.deps;
    const out = new Set<AgentId>();
    for (const r of reads.readersOf(intent.target.file, intent.target.symbol)) out.add(r.agentId);
    const callers = graph.callersOf(intent.target.symbol);
    if (callers.length > 0) {
      for (const other of intents.list()) {
        if (other.agentId === intent.agentId) continue;
        if (!["approved", "in_progress", "done", "verified"].includes(other.status)) continue;
        if (callers.some((c) => c.file === other.target.file && (c.caller === other.target.symbol || c.caller === null))) out.add(other.agentId);
      }
    }
    out.delete(intent.agentId);
    return [...out];
  }

  private push(toAgent: AgentId, kind: Briefing["kind"], summary: string, details: Briefing["details"]): void {
    this.deps.briefings.push({ toAgent, kind, summary: clip(summary), details, requiresAck: true });
  }

  private async safeRun(fn: () => Promise<TestResult>): Promise<TestResult> {
    try {
      return await fn();
    } catch (err) {
      return { ok: false, passed: 0, failed: 1, failures: [{ name: "runner", message: err instanceof Error ? err.message : String(err) }], durationMs: 0 };
    }
  }

  /** Resolve once `quietMs` passed without a store change, or after `maxQuietWaitMs`. */
  private waitForQuiet(): Promise<void> {
    const quietMs = this.deps.quietMs ?? 1000;
    const maxWait = this.deps.maxQuietWaitMs ?? 5000;
    return new Promise((resolve) => {
      let unsub: () => void = () => undefined;
      let quietTimer: NodeJS.Timeout;
      const done = () => {
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        unsub();
        resolve();
      };
      const maxTimer = setTimeout(done, maxWait);
      const arm = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quietMs);
      };
      arm();
      unsub = this.deps.store.onChange(() => arm());
    });
  }
}

/** The temp vitest file that proves an intent's `check` lines against the live files. */
export function checkTestSource(intent: Intent): string {
  const file = intent.target.file.replace(/\.tsx?$/, "");
  const symbol = intent.target.symbol;
  const validIdent = /^[A-Za-z_$][\w$]*$/.test(symbol);
  const lines = [
    `import { it, expect } from "vitest";`,
    `import * as __target from "../${file}.js";`,
    validIdent ? `const ${symbol} = (__target as Record<string, unknown>)["${symbol}"] as any;` : "",
    `it("${CHECK_TEST_NAME} ${intent.id}", () => {`,
    ...intent.check!.split("\n").map((l) => `  ${l}`),
    `});`,
    "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

function clip(s: string, max = 400): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
