// buildApp(ctx): a Fastify instance (no listen) with the agent tool API, human routes and both
// WebSocket endpoints. Tests drive it with app.inject / app.listen on port 0.
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { HiveContext } from "./deps.js";
import { isToolName, toolHandlers, UnknownAgentError, type ToolHandlers } from "./tools.js";
import { registerHumanRoutes } from "./humans.js";
import { registerWs } from "./ws.js";
import { YjsHub } from "./yjsWs.js";

export interface BuiltApp {
  app: FastifyInstance;
  tools: ToolHandlers;
  hub: YjsHub;
  ready: Promise<void>;
}

export interface BuildAppOptions {
  /** Pre-built tool handlers (so the AgentManager and the HTTP layer share one instance). */
  tools?: ToolHandlers;
  /** Pre-built Yjs hub (hive.ts creates it first so ProjectStore gets hub.resolveActor). */
  hub?: YjsHub;
  logger?: boolean;
}

export function buildApp(ctx: HiveContext, opts: BuildAppOptions = {}): BuiltApp {
  const app = Fastify({ logger: opts.logger ?? false });
  const tools = opts.tools ?? toolHandlers(ctx);
  const hub = opts.hub ?? new YjsHub();
  if (!opts.hub) hub.bind(ctx.deps.store.ydoc);

  const ready = (async () => {
    await app.register(cors, { origin: true });
    await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

    app.post<{ Params: { agentId: string; tool: string } }>("/api/agents/:agentId/tools/:tool", async (req, reply) => {
      const { agentId, tool } = req.params;
      if (!isToolName(tool)) {
        return reply.code(200).send({
          ok: false,
          error: { code: "BAD_ARGS", message: `unknown tool ${tool}` },
          briefings: [],
          control: ctx.agents.controlOf(agentId),
          rev: ctx.deps.store.rev,
        });
      }
      try {
        return await tools.callRaw(agentId, tool, req.body);
      } catch (err) {
        if (err instanceof UnknownAgentError) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: err.message } });
        throw err;
      }
    });

    registerHumanRoutes(app, ctx, tools);
    registerWs(app, ctx, hub);
    await app.ready();
  })();

  return { app, tools, hub, ready };
}
