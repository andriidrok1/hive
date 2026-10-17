// createHive: builds every module, wires store.onChange -> History + CallGraph + ChangeWatcher,
// saves the green baseline, creates the AgentManager and the Fastify app, and supports reset(mode).
//
// The module constructors are injected (HiveModules) so this file compiles against the structural
// interfaces in api/deps.ts; index.ts passes the real classes where they exist and fakes otherwise.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FeedEventBody, HiveMode, LLM, Runner } from "@hive/shared";
import { createEmitter } from "./emit.js";
import { buildApp, type BuiltApp } from "./api/app.js";
import type {
  AnalyzeFile,
  BriefingQueueLike,
  CallGraphLike,
  ChangeWatcherLike,
  HistoryLike,
  HiveContext,
  HiveDeps,
  IntentRegistryLike,
  MailboxLike,
  ProjectStoreLike,
  ProjectStoreOptions,
  ReadLogLike,
  TestOrchestratorLike,
} from "./api/deps.js";
import { toolHandlers } from "./api/tools.js";
import { YjsHub } from "./api/yjsWs.js";
import { AgentManager, type RunAgentFn } from "./agents/AgentManager.js";

type OnEvent = (e: FeedEventBody) => void;

export interface HiveModules {
  ProjectStore: new (opts?: ProjectStoreOptions) => ProjectStoreLike;
  ReadLog: new () => ReadLogLike;
  History: new (store: ProjectStoreLike) => HistoryLike;
  CallGraph: new () => CallGraphLike;
  BriefingQueue: new (opts?: { onEvent?: OnEvent }) => BriefingQueueLike;
  IntentRegistry: new (deps: { llm: LLM; graph: CallGraphLike; reads: ReadLogLike; briefings: BriefingQueueLike; onEvent: OnEvent; mode: HiveMode }) => IntentRegistryLike;
  ChangeWatcher: new (deps: {
    llm: LLM;
    graph: CallGraphLike;
    reads: ReadLogLike;
    intents: IntentRegistryLike;
    briefings: BriefingQueueLike;
    onEvent: OnEvent;
    mode: HiveMode;
  }) => ChangeWatcherLike;
  Mailbox: new (deps: { briefings: BriefingQueueLike; onEvent: OnEvent }) => MailboxLike;
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
  analyzeFile: AnalyzeFile;
}

export interface CreateHiveOptions {
  mode: HiveMode;
  initialFiles: Record<string, string>;
  runner: Runner;
  llm: LLM;
  modules: HiveModules;
  runAgent: RunAgentFn;
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

  const buildDeps = (mode: HiveMode): HiveDeps => {
    const m = opts.modules;
    const createStore = (storeOpts: ProjectStoreOptions = {}) => new m.ProjectStore(storeOpts);
    const store = createStore({ onEvent: emit, resolveActor: hub.resolveActor });
    store.loadFiles(opts.initialFiles);
    const reads = new m.ReadLog();
    const history = new m.History(store);
    const graph = new m.CallGraph();
    graph.update(store.allFiles());
    const briefings = new m.BriefingQueue({ onEvent: emit });
    const intents = new m.IntentRegistry({ llm: opts.llm, graph, reads, briefings, onEvent: emit, mode });
    const watcher = new m.ChangeWatcher({ llm: opts.llm, graph, reads, intents, briefings, onEvent: emit, mode });
    const mailbox = new m.Mailbox({ briefings, onEvent: emit });
    const orchestrator = new m.TestOrchestrator({ store, history, intents, briefings, reads, graph, runner: opts.runner, onEvent: emit, mode });

    // The only subscription to store.onChange: History records edits, CallGraph re-analyzes, ChangeWatcher briefs.
    store.onChange((c) => {
      history.recordEdit(c);
      try {
        graph.update(store.allFiles());
      } catch (err) {
        console.error("[hive] call graph update failed:", err instanceof Error ? err.message : err);
      }
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
      analyzeFile: m.analyzeFile,
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
    runAgent: opts.runAgent,
    tools,
    emitter,
    briefings: () => ctx.deps.briefings,
    mode: () => ctx.deps.mode,
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
