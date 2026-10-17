// Human and UI routes from CONTRACTS.md ("Humans and UI").
import type { FastifyInstance, FastifyReply } from "fastify";
import { applyPatch, createPatch } from "diff";
import type { HiveMode, HiveState, MergeResult, TestRequest, TestResult } from "@hive/shared";
import type { HiveContext } from "./deps.js";
import type { ToolHandlers } from "./tools.js";

const MODES: readonly HiveMode[] = ["hive", "naive", "isolated"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function bad(reply: FastifyReply, message: string, status = 400) {
  return reply.code(status).send({ ok: false, error: { code: "BAD_ARGS", message } });
}

export function hiveState(ctx: HiveContext): HiveState {
  const d = ctx.deps;
  const green = d.history.lastGreen();
  const state: HiveState = {
    mode: d.mode,
    rev: d.store.rev,
    files: d.store.listFiles(),
    agents: ctx.agents.list().map((a) => {
      const row: HiveState["agents"][number] = { agentId: a.agentId, humanId: a.humanId, status: a.status, control: a.control };
      if (a.task !== undefined) row.task = a.task;
      return row;
    }),
    intents: d.intents.list(),
    history: d.history.changeSets(),
    recentEvents: d.emitter.recent(),
  };
  if (green) state.lastGreen = { rev: green.rev, at: green.at };
  return state;
}

export async function runSuite(ctx: HiveContext, req: TestRequest, reason: string): Promise<TestResult> {
  const d = ctx.deps;
  const files = { ...d.store.allFiles(), ...(req.extraFiles ?? {}) };
  const runId = `run_api_${Date.now()}`;
  const rev = d.store.rev;
  d.emitter.emit({ type: "test_run_started", runId, rev, reason });
  let result: TestResult;
  try {
    result = await d.runner.runTests(files, req.filter ? { filter: req.filter } : {});
  } catch (err) {
    result = { ok: false, passed: 0, failed: 0, failures: [{ name: "runner", message: err instanceof Error ? err.message : String(err) }], durationMs: 0 };
  }
  d.emitter.emit({ type: "test_run_finished", runId, rev, result });
  // A green run of the project as it is (no scenario extras) is a valid green baseline for the culprit search.
  if (result.ok && !req.extraFiles && d.store.rev === rev) d.history.saveSnapshot(true);
  return result;
}

/** Isolated mode: 3-way merge of every agent copy into the main store, agents in start order. */
export function mergeCopies(ctx: HiveContext, tools: ToolHandlers): MergeResult {
  const d = ctx.deps;
  const main = d.store;
  const result: Record<string, string> = main.allFiles();
  const conflicts: { path: string }[] = [];
  for (const { agentId, store, base } of tools.copies()) {
    const mine = store.allFiles();
    const paths = new Set([...Object.keys(base), ...Object.keys(mine)]);
    for (const path of paths) {
      const before = base[path] ?? "";
      const after = mine[path];
      if (after === undefined || after === before) continue; // untouched (deletes are not merged)
      const current = result[path];
      if (current === undefined || current === before) {
        result[path] = after;
        continue;
      }
      const patch = createPatch(path, before, after, "", "", { context: 3 });
      const merged = applyPatch(current, patch, { fuzzFactor: 2 });
      if (merged === false) {
        conflicts.push({ path });
        result[path] = `<<<<<<< main\n${current}\n=======\n${after}\n>>>>>>> ${agentId}\n`;
      } else {
        result[path] = merged;
      }
    }
  }
  const existing = main.allFiles();
  for (const [path, content] of Object.entries(result)) {
    if (existing[path] === content) continue;
    if (existing[path] === undefined) main.createFile({ actor: "merge", path, content });
    else main.humanReplaceFile("merge", path, content);
  }
  return { ok: conflicts.length === 0, conflicts, rev: main.rev };
}

export function registerHumanRoutes(app: FastifyInstance, ctx: HiveContext, tools: ToolHandlers): void {
  app.get("/api/state", async () => hiveState(ctx));

  app.get("/api/agents", async () => ({ agents: hiveState(ctx).agents }));

  app.get<{ Params: { "*": string } }>("/api/files/*", async (req, reply) => {
    const path = decodeURIComponent(req.params["*"] ?? "");
    const d = ctx.deps;
    const file = d.store.readFile(path);
    if (!file) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: `no file ${path}` } });
    let symbols: HiveState extends never ? never : ReturnType<typeof d.analyzeFile>["symbols"] = [];
    try {
      symbols = /\.(ts|tsx|js)$/.test(path) ? d.analyzeFile(path, file.content).symbols : [];
    } catch {
      symbols = [];
    }
    return { content: file.content, rev: file.rev, symbols };
  });

  app.post("/api/agents", async (req, reply) => {
    const b = req.body;
    if (!isObj(b) || typeof b.agentId !== "string" || typeof b.humanId !== "string" || typeof b.task !== "string") {
      return bad(reply, "body must be { agentId, humanId, task }");
    }
    if (!b.agentId || !b.humanId) return bad(reply, "agentId and humanId must not be empty");
    const r = ctx.agents.start({ agentId: b.agentId, humanId: b.humanId, task: b.task });
    if (!r.ok) return reply.code(409).send({ ok: false, error: { code: r.code, message: `${b.agentId} is already running` } });
    return { ok: true };
  });

  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/control", async (req, reply) => {
    const b = req.body;
    if (!isObj(b) || typeof b.humanId !== "string" || !["run", "pause", "stop"].includes(String(b.control))) {
      return bad(reply, "body must be { humanId, control: run | pause | stop }");
    }
    const control = b.control as "run" | "pause" | "stop";
    const ok = ctx.agents.control(req.params.agentId, control);
    if (!ok) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: `unknown agent ${req.params.agentId}` } });
    ctx.deps.emitter.emit({ type: "human_action", humanId: b.humanId, action: `control:${control}`, target: req.params.agentId });
    return { ok: true };
  });

  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/note", async (req, reply) => {
    const b = req.body;
    if (!isObj(b) || typeof b.humanId !== "string" || typeof b.text !== "string" || !b.text.trim()) {
      return bad(reply, "body must be { humanId, text, urgent? }");
    }
    const urgent = b.urgent === true;
    const ok = ctx.agents.note(req.params.agentId, b.humanId, b.text, urgent);
    if (!ok) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: `unknown agent ${req.params.agentId}` } });
    ctx.deps.emitter.emit({ type: "human_action", humanId: b.humanId, action: urgent ? "urgent_note" : "note", target: req.params.agentId });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/intents/:id/output", async (req, reply) => {
    const b = req.body;
    if (!isObj(b) || typeof b.humanId !== "string" || typeof b.output !== "string") return bad(reply, "body must be { humanId, output }");
    if (!ctx.deps.intents.get(req.params.id)) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: `unknown intent ${req.params.id}` } });
    try {
      ctx.deps.intents.humanEditOutput(b.humanId, req.params.id, b.output);
    } catch (err) {
      return bad(reply, err instanceof Error ? err.message : String(err));
    }
    return { ok: true, intent: ctx.deps.intents.get(req.params.id) };
  });

  app.post("/api/intents/resolve", async (req, reply) => {
    const b = req.body;
    if (!isObj(b) || typeof b.humanId !== "string" || typeof b.keep !== "string" || typeof b.cancel !== "string") {
      return bad(reply, "body must be { humanId, keep, cancel }");
    }
    const d = ctx.deps;
    if (!d.intents.get(b.keep) || !d.intents.get(b.cancel)) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "unknown intent" } });
    d.intents.resolveConflict(b.humanId, b.keep, b.cancel);
    return { ok: true, keep: d.intents.get(b.keep), cancel: d.intents.get(b.cancel) };
  });

  app.post("/api/reset", async (req, reply) => {
    const b = isObj(req.body) ? req.body : {};
    let mode: HiveMode | undefined;
    if (b.mode !== undefined) {
      if (!MODES.includes(b.mode as HiveMode)) return bad(reply, "mode must be hive | naive | isolated");
      mode = b.mode as HiveMode;
    }
    await ctx.reset(mode);
    return { ok: true, mode: ctx.deps.mode, rev: ctx.deps.store.rev };
  });

  app.post("/api/test", async (req, reply) => {
    const b = isObj(req.body) ? req.body : {};
    const request: TestRequest = {};
    if (b.extraFiles !== undefined) {
      if (!isObj(b.extraFiles) || Object.values(b.extraFiles).some((v) => typeof v !== "string")) return bad(reply, "extraFiles must map path -> content");
      request.extraFiles = b.extraFiles as Record<string, string>;
    }
    if (b.filter !== undefined) {
      if (typeof b.filter !== "string") return bad(reply, "filter must be a string");
      request.filter = b.filter;
    }
    return runSuite(ctx, request, "POST /api/test");
  });

  app.post("/api/merge", async (_req, reply) => {
    if (ctx.deps.mode !== "isolated") return bad(reply, "merge is only available in isolated mode");
    const result = mergeCopies(ctx, tools);
    ctx.deps.emitter.emit({ type: "human_action", humanId: "system", action: "merge", target: result.ok ? "clean" : `${result.conflicts.length} conflicts` });
    return result;
  });

  app.get("/api/messages", async () => ({ messages: ctx.deps.mailbox.forHumans() }));
}
