// createHive: builds every module, wires store.onChange -> History + CallGraph + ChangeWatcher,
// saves the green baseline, creates the AgentManager and the Fastify app, and supports reset(mode).
//
// Core, coord, runner and the agent loop (@hive/agent) are the real modules. Tests may swap the
// TestOrchestrator through `modules` (api/fakes.ts) to keep runs fast and deterministic.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FeedEventBody, HiveMode, LLM, Runner } from "@hive/shared";
import { runAgent as realRunAgent } from "@hive/agent";
import { createEmitter } from "./emit.js";
import { History, ProjectStore, ReadLog } from "./core/index.js";
import { analyzeFile, BriefingQueue, CallGraph, ChangeWatcher, IntentRegistry, Mailbox } from "./coord/index.js";
import { CulpritFinder, TestOrchestrator } from "./runner/index.js";
import { buildApp, type BuiltApp } from "./api/app.js";
import type {
  BriefingQueueLike,
  CallGraphLike,
  HistoryLike,
  HiveContext,
  HiveDeps,
  IntentRegistryLike,
  ProjectStoreLike,
  ProjectStoreOptions,
  ReadLogLike,
  TestOrchestratorLike,
} from "./api/deps.js";
import { closeOpenIntents, toolHandlers } from "./api/tools.js";
import { YjsHub } from "./api/yjsWs.js";
import { AgentManager, type RunAgentFn } from "./agents/AgentManager.js";

type OnEvent = (e: FeedEventBody) => void;

export interface HiveModules {
  TestOrchestrator: new (deps: {
    store: ProjectStoreLike;
    history: HistoryLike;
    intents: IntentRegistryLike;
    briefings: BriefingQueueLike;
    reads: ReadLogLike;
    graph: CallGraphLike;
    runner: Runner;
    onEvent: OnEvent;
    mode: HiveMode;
  }) => TestOrchestratorLike;
}

export interface CreateHiveOptions {
  mode: HiveMode;
  initialFiles: Record<string, string>;
  runner: Runner;
  /** An LLM, or a factory that receives the feed emit function (OpenAILLM emits llm_call for checks). */
  llm: LLM | ((emit: OnEvent) => LLM);
  /** Overrides for tests; by default the real runner TestOrchestrator (+ CulpritFinder) is used. */
  modules?: HiveModules;
  /** Passed to the real TestOrchestrator (quiet period before snapshotting, default 1000 ms). */
  orchestrator?: { quietMs?: number; maxQuietWaitMs?: number; maxParallel?: number };
  /** Defaults to runAgent from @hive/agent; tests inject a scripted one. */
  runAgent?: RunAgentFn;
  model?: string;
  logger?: boolean;
}

export interface Hive {
  ctx: HiveContext;
  agents: AgentManager;
  hub: YjsHub;
  built: BuiltApp;
  close(): Promise<void>;
}

export function createHive(opts: CreateHiveOptions): Hive {
  const emitter = createEmitter();
  const hub = new YjsHub();
  const emit: OnEvent = (e) => {
    emitter.emit(e);
  };
  const llm: LLM = typeof opts.llm === "function" ? opts.llm(emit) : opts.llm;

  const buildDeps = (mode: HiveMode): HiveDeps => {
    const m = opts.modules;
    const createStore = (storeOpts: ProjectStoreOptions = {}): ProjectStoreLike => new ProjectStore(storeOpts);
    const store = new ProjectStore({ onEvent: emit, resolveActor: hub.resolveActor });
    store.loadFiles(opts.initialFiles);
    const reads = new ReadLog();
    const history = new History(store);
    const graph = new CallGraph();
    graph.update(store.allFiles());
    const briefings = new BriefingQueue({ onEvent: emit });
    const intents = new IntentRegistry({ llm, graph, reads, briefings, onEvent: emit, mode });
    const watcher = new ChangeWatcher({ llm, graph, reads, intents, briefings, onEvent: emit, mode });
    const mailbox = new Mailbox({ briefings, onEvent: emit });
    const orchestratorDeps = { store, history, intents, briefings, reads, graph, runner: opts.runner, onEvent: emit, mode };
    const o = opts.orchestrator ?? {};
    const orchestrator: TestOrchestratorLike = m
      ? new m.TestOrchestrator(orchestratorDeps)
      : new TestOrchestrator({
          ...orchestratorDeps,
          culprit: new CulpritFinder(opts.runner, o.maxParallel ?? 8),
          ...(o.quietMs !== undefined ? { quietMs: o.quietMs } : {}),
          ...(o.maxQuietWaitMs !== undefined ? { maxQuietWaitMs: o.maxQuietWaitMs } : {}),
        });

    // The only subscription to store.onChange: History records edits, CallGraph re-analyzes, ChangeWatcher briefs.
    store.onChange((c) => {
      try {
        graph.update(store.allFiles());
      } catch (err) {
        console.error("[hive] call graph update failed:", err instanceof Error ? err.message : err);
      }
      history.recordEdit(c);
      void watcher.onEdit(c).catch((err: unknown) => {
        console.error("[hive] change watcher failed:", err instanceof Error ? err.message : err);
      });
    });
    history.saveSnapshot(true); // green baseline at rev 0

    return {
      mode,
      emitter,
      store,
      reads,
      history,
      graph,
      briefings,
      intents,
      watcher,
      mailbox,
      orchestrator,
      runner: opts.runner,
      analyzeFile,
      initialFiles: opts.initialFiles,
      createStore,
    };
  };

  const ctx: HiveContext = {
    deps: buildDeps(opts.mode),
    agents: undefined as unknown as AgentManager, // set right below
    async reset(mode) {
      await agents.stopAll();
      emitter.clear();
      ctx.deps = buildDeps(mode ?? ctx.deps.mode);
      hub.bind(ctx.deps.store.ydoc); // closes Yjs clients; they reconnect and sync the fresh doc
    },
  };
  const tools = toolHandlers(ctx);
  const managerOpts = {
    runAgent: opts.runAgent ?? (realRunAgent as RunAgentFn),
    tools,
    emitter,
    briefings: () => ctx.deps.briefings,
    mode: () => ctx.deps.mode,
    onTerminal: (agentId: string) => {
      const closed = closeOpenIntents(ctx, tools, agentId);
      if (closed.finished.length || closed.cancelled.length || closed.closedFailed.length) {
        console.log(`[hive] ${agentId} ended; finished ${closed.finished.join(",") || "-"}, cancelled ${closed.cancelled.join(",") || "-"}, failed->done ${closed.closedFailed.join(",") || "-"}`);
      }
    },
    ...(opts.model ? { model: opts.model } : {}),
  };
  const agents = new AgentManager(managerOpts);
  ctx.agents = agents;
  hub.bind(ctx.deps.store.ydoc);

  const built = buildApp(ctx, { tools, hub, ...(opts.logger !== undefined ? { logger: opts.logger } : {}) });
  return {
    ctx,
    agents,
    hub,
    built,
    async close() {
      await agents.stopAll();
      await built.app.close();
    },
  };
}

const LOADED_TOP = new Set(["package.json", "tsconfig.json"]);
const LOADED_DIRS = ["src", "test"];

/** Initial files of a project dir: src/**, test/**, package.json, tsconfig.json; never node_modules. */
export function loadProjectDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string) => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(abs, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  for (const name of LOADED_TOP) {
    try {
      const full = join(dir, name);
      if (statSync(full).isFile()) out[name] = readFileSync(full, "utf8");
    } catch {
      // optional
    }
  }
  for (const sub of LOADED_DIRS) walk(join(dir, sub));
  return out;
}
