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
import { applyEdits } from "../core/index.js";
import type { CulpritFinder } from "./CulpritFinder.js";
import { runId } from "./util.js";

// Structural views of the core/coord classes this module uses (CONTRACTS.md). The real
// ProjectStore, History, IntentRegistry, BriefingQueue, ReadLog and CallGraph satisfy them.
export interface StoreLike {
  readonly rev: Rev;
  allFiles(): Record<string, string>;
  onChange(cb: (c: { path: string; rev: Rev }) => void): () => void;
}
/** Files of a green base plus a set of finished change sets; mirrors core's applyEdits result shape. */
export type ViewResult = { ok: true; files: Record<string, string> } | { ok: false; path: string; index: number; intentId?: IntentId };

export interface HistoryLike {
  /** `view` pins the snapshot to the tested view (rev + files) instead of the live store. */
  saveSnapshot(green: boolean, view?: { rev: Rev; files: Record<string, string> }): Snapshot;
  lastGreen(): Snapshot | undefined;
  changeSetsSince(rev: Rev): ChangeSet[];
  /** Intents that began but have not finished (their edits are excluded from views). Optional until core lands it. */
  openIntents?(): ReadonlyArray<IntentId | { id: IntentId }>;
  /** Base files plus the given finished change sets. Optional until core lands it (local applyEdits is used meanwhile). */
  buildView?(base: Record<string, string>, sets: ChangeSet[], extraEdits?: ChangeSet["edits"]): ViewResult;
}
export interface IntentsLike {
  get(id: IntentId): Intent | undefined;
  list(): Intent[];
  setStatus(id: IntentId, status: IntentStatus, opts?: { rev?: Rev }): void;
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
  /** Skip a new culprit search when one ran within this window and the failing tests are unchanged (ms). Default 20000. */
  culpritCooldownMs?: number;
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
  private lastSearch: { at: number; failingKey: string } | undefined;

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
    const intent = intents.get(intentId);

    // The view under test: last green base plus every FINISHED change set since it. Other agents'
    // in-progress edits stay out, so one agent's unfinished work cannot fail another's verification.
    const base = history.lastGreen() ?? this.initial;
    const sets = history.changeSetsSince(base.rev);
    let rev = store.rev;
    let files: Record<string, string>;
    let where: string;
    if (mode !== "hive") {
      files = store.allFiles(); // no intents, no change sets: the live project is the only view
      where = "live";
    } else {
      const view = history.buildView ? history.buildView(base.files, sets) : applyEdits(base.files, sets.flatMap((s) => s.edits));
      if (view.ok) {
        files = view.files;
        rev = intent?.endRev ?? sets[sets.length - 1]?.endRev ?? store.rev;
        const excluded = (history.openIntents?.() ?? []).map((o) => (typeof o === "string" ? o : o.id)).filter((id) => id !== intentId);
        where = `view: ${sets.length} finished set${sets.length === 1 ? "" : "s"}, excluded in-progress: ${excluded.length > 0 ? excluded.join(", ") : "none"}`;
      } else {
        files = store.allFiles();
        const failedId = "intentId" in view && view.intentId ? ` of ${view.intentId}` : "";
        where = `fallback: live, view failed at ${view.path}#${view.index}${failedId}`;
      }
    }

    if (mode === "hive" && intent?.check && intent.action !== "delete") {
      const checkRun = runId("check");
      onEvent({ type: "test_run_started", runId: checkRun, rev, reason: `check ${intentId} (${where})` });
      const checkResult = await this.safeRun(() =>
        runner.runTests({ ...files, [CHECK_TEST_PATH]: checkTestSource(intent, files[intent.target.file]) }, { filter: CHECK_TEST_NAME }),
      );
      onEvent({ type: "test_run_finished", runId: checkRun, rev, result: checkResult });
      const verdict = classifyCheck(checkResult);
      if (verdict === "failed") {
        intents.setStatus(intentId, "failed", { rev });
        this.briefVerificationFailed(intent, checkResult);
        return;
      }
      if (verdict === "invalid") {
        // The check itself could not run (ReferenceError, SyntaxError, ...): the code was not judged.
        const firstLine = (checkResult.failures[0]?.message ?? "check did not run").split("\n").find((l) => l.trim().length > 0)?.trim() ?? "check did not run";
        this.deps.briefings.push({
          toAgent: intent.agentId,
          kind: "verification_failed",
          summary: clip(`Your check for ${intentId} could not run: ${firstLine}. Re-declare with a self-contained check; code was not judged.`),
          details: { intentId, file: intent.target.file, symbol: intent.target.symbol, failingTests: checkResult.failures.slice(0, 3) },
          requiresAck: false,
        });
      }
    }

    const suiteRun = runId("test");
    onEvent({ type: "test_run_started", runId: suiteRun, rev, reason: `intent ${intentId} finished (${where})` });
    const result = await this.safeRun(() => runner.runTests(files));
    onEvent({ type: "test_run_finished", runId: suiteRun, rev, result });

    if (result.ok) {
      if (mode === "hive" && where.startsWith("view")) history.saveSnapshot(true, { rev, files });
      else history.saveSnapshot(true);
      if (intent) intents.setStatus(intentId, "verified", { rev });
      return;
    }

    if (mode !== "hive") return; // naive / isolated: tests run, no culprit search, no briefings

    const green = base;
    const suspects = sets;
    if (suspects.length === 0) {
      if (intent) {
        intents.setStatus(intentId, "failed", { rev });
        this.push(intent.agentId, "culprit", `Tests are red after ${intentId} finished and no change set explains it; your intent is marked failed.`, {
          intentId,
          file: intent.target.file,
          symbol: intent.target.symbol,
          failingTests: result.failures.slice(0, 10),
        });
      }
      return;
    }

    // Cooldown: the same failure within 20s does not deserve another search (agents finish intents in bursts).
    const failingKey = [...new Set(result.failures.map((f) => f.name))].sort().join("\n");
    const cooldown = this.deps.culpritCooldownMs ?? 20_000;
    if (this.lastSearch && Date.now() - this.lastSearch.at < cooldown && this.lastSearch.failingKey === failingKey) return;

    const searchId = runId("culprit");
    onEvent({ type: "culprit_search_started", searchId, suspects: suspects.map((s) => s.id) });
    const report = await this.deps.culprit.find(green, suspects, (variant) => onEvent({ type: "culprit_variant_result", searchId, variant }));
    onEvent({ type: "culprit_found", searchId, report });
    this.lastSearch = { at: Date.now(), failingKey };
    this.applyReport(report, suspects, result, intentId, rev);
  }

  private applyReport(report: CulpritReport, suspects: ChangeSet[], result: TestResult, finishedId: IntentId, rev: Rev): void {
    const { intents } = this.deps;
    const byId = new Map(suspects.map((s) => [s.id, s]));
    const failingNames = [...new Set(result.failures.map((f) => f.name))];
    if (report.kind === "unknown") {
      // Cause unclear: judge nobody. One non-blocking note per suspect owner.
      const perOwner = new Map<AgentId, IntentId[]>();
      for (const s of suspects) perOwner.set(s.agentId, [...(perOwner.get(s.agentId) ?? []), s.id]);
      for (const [owner, ids] of perOwner) {
        this.deps.briefings.push({
          toAgent: owner,
          kind: "verification_failed",
          summary: clip(`Tests are red after your intents ${ids.join(", ")}, cause unclear; failing: ${failingNames.slice(0, 5).join(", ")}`),
          details: { intentId: ids[ids.length - 1], failingTests: result.failures.slice(0, 10) },
          requiresAck: false,
        });
      }
      return;
    }
    const culpritIds = report.culprits.length > 0 ? report.culprits : [finishedId];
    for (const id of culpritIds) {
      const st = intents.get(id)?.status;
      if (st === "done" || st === "verified" || st === "in_progress" || st === "approved") intents.setStatus(id, "failed", { rev });
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
    // dependent: every suspect's owner
    const owners = new Map<AgentId, IntentId[]>();
    for (const id of culpritIds) {
      const owner = ownerOf(id);
      if (!owner) continue;
      owners.set(owner, [...(owners.get(owner) ?? []), id]);
    }
    const why = "a change set only applies on top of another, so they could not be isolated";
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

/**
 * The temp vitest file that proves an intent's `check` lines against the live files.
 * Imports the whole target module and binds every value export of that file locally, so check
 * lines may reference sibling exports (e.g. `TAX_RATES` next to `applyTax`), not only the target symbol.
 */
export function checkTestSource(intent: Intent, fileContent?: string): string {
  const file = intent.target.file.replace(/\.tsx?$/, "");
  const names = new Set<string>();
  if (isIdent(intent.target.symbol)) names.add(intent.target.symbol);
  for (const n of exportedValueNames(fileContent ?? "")) names.add(n);
  const bindings = [...names].filter((n) => !RESERVED.has(n));
  const lines = [
    `import { describe, expect, it } from "vitest";`,
    `import * as __target from "../${file}.js";`,
    bindings.length > 0 ? `const { ${bindings.join(", ")} } = __target as Record<string, any>;` : "",
    `void describe;`,
    `it("${CHECK_TEST_NAME} ${intent.id}", () => {`,
    ...intent.check!.split("\n").map((l) => `  ${l}`),
    `});`,
    "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export type CheckVerdict = "ok" | "failed" | "invalid";

const RUNTIME_ERROR = /\b(ReferenceError|SyntaxError|TypeError|RangeError|EvalError|URIError)\b|is not defined|Failed to parse source|Transform failed|Cannot find (module|package)|failed to run/;

/**
 * `ok` when the check passed, `failed` when at least one failure is a real assertion
 * (vitest reports `AssertionError`), `invalid` when the check could not run at all
 * (ReferenceError/SyntaxError/TypeError, import failure, runner crash): the code was not judged.
 */
export function classifyCheck(result: TestResult): CheckVerdict {
  if (result.ok) return "ok";
  if (result.failures.length === 0) return "invalid";
  if (result.failures.some((f) => /AssertionError/.test(f.message))) return "failed";
  if (result.failures.some((f) => RUNTIME_ERROR.test(f.message) || f.name === "vitest" || f.name === "runner" || f.name.endsWith(CHECK_TEST_PATH))) return "invalid";
  return "failed";
}

const RESERVED = new Set(["it", "expect", "describe", "default", "__target"]);

function isIdent(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s);
}

/** Names of the runtime (value) exports of a TS module: functions, classes, consts, enums and `export { a, b as c }` lists. Types and interfaces are skipped. */
export function exportedValueNames(source: string): string[] {
  const out = new Set<string>();
  const decl = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(decl)) out.add(m[1]!);
  const list = /^\s*export\s*(?!type\b)\{([^}]*)\}/gm;
  for (const m of source.matchAll(list)) {
    for (const part of m[1]!.split(",")) {
      const seg = part.trim();
      if (!seg || seg.startsWith("type ")) continue;
      const name = (seg.split(/\s+as\s+/)[1] ?? seg.split(/\s+as\s+/)[0] ?? "").trim();
      if (isIdent(name)) out.add(name);
    }
  }
  return [...out];
}

function clip(s: string, max = 400): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
