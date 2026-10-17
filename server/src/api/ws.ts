// /ws/feed (FeedEvent JSON stream) and /yjs/project (Yjs sync of the main store's ydoc).
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { HiveContext } from "./deps.js";
import { YjsHub } from "./yjsWs.js";

export function registerWs(app: FastifyInstance, ctx: HiveContext, hub: YjsHub): void {
  const feedClients = new Set<WebSocket>();

  // The emitter instance survives resets (see HiveContext.reset), so one subscription per connection is enough.
  app.get("/ws/feed", { websocket: true }, (socket: WebSocket) => {
    feedClients.add(socket);
    const unsubscribe = ctx.deps.emitter.subscribe((event) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(event), (err) => {
        if (err) socket.close();
      });
    });
    const cleanup = () => {
      unsubscribe();
      feedClients.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("message", () => {
      // clients do not talk on the feed; ignore (keeps pings harmless)
    });
  });

  app.get("/yjs/project", { websocket: true }, (socket: WebSocket) => {
    hub.handle(socket);
  });

  app.addHook("onClose", async () => {
    hub.closeAll();
    for (const s of feedClients) {
      try {
        s.close(1001, "server closing");
      } catch {
        // ignore
      }
    }
    feedClients.clear();
  });
}
