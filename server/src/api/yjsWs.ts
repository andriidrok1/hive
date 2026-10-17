// Hand-written y-websocket server protocol over a ws WebSocket, bound to an external Y.Doc.
// Wire format (same as y-websocket): varUint message type, then payload.
//   0 = sync (y-protocols/sync), 1 = awareness (y-protocols/awareness).
// The stock WebsocketProvider client connects unchanged.
import * as Y from "yjs";
import type { WebSocket, RawData } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export interface AwarenessUser {
  name?: string;
  color?: string;
  kind?: "human" | "agent";
}

/** Awareness state in the shape y-codemirror.next renders: a named colored caret. */
export interface AgentPresenceState {
  user: { name: string; color: string; kind: "agent"; agentId: string }; // name = the human behind the agent
  cursor: { anchor: unknown; head: unknown };
}

const AGENT_CLIENT_BASE = 0x40000000; // synthetic awareness client ids live far from Yjs's random 32-bit ids

export class YjsHub {
  private doc: Y.Doc | null = null;
  private awareness: awarenessProtocol.Awareness | null = null;
  private readonly conns = new Map<WebSocket, Set<number>>(); // conn -> awareness client ids it controls
  private detach: (() => void) | null = null;
  /** One synthetic awareness client per agent: fake clientID + the clock we advance like a remote peer would. */
  private readonly agentClients = new Map<string, { clientId: number; clock: number }>();
  private nextAgentClient = 0;

  /** Binds (or re-binds) the hub to a document; existing connections are closed so clients resync. */
  bind(doc: Y.Doc): void {
    this.closeAll(4000, "rebind");
    this.detach?.();
    this.agentClients.clear(); // the old awareness dies with the old doc; clients reconnect to a clean one
    this.doc = doc;
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    this.awareness = awareness;

    const onDocUpdate = (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
    };
    const onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (origin && typeof origin === "object" && this.conns.has(origin as WebSocket)) {
        const ids = this.conns.get(origin as WebSocket);
        if (ids) {
          for (const id of added) ids.add(id);
          for (const id of removed) ids.delete(id);
        }
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      this.broadcast(encoding.toUint8Array(encoder));
    };
    doc.on("update", onDocUpdate);
    awareness.on("update", onAwarenessUpdate);
    this.detach = () => {
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessUpdate);
      awareness.destroy();
    };
  }

  /** Maps a transaction origin (the connection used when applying remote updates) to an actor id. */
  resolveActor = (origin: unknown): string => {
    const user = this.userOf(origin);
    return user?.name ?? "human";
  };

  userOf(origin: unknown): AwarenessUser | undefined {
    if (!origin || typeof origin !== "object" || !this.awareness) return undefined;
    const ids = this.conns.get(origin as WebSocket);
    if (!ids) return undefined;
    for (const id of ids) {
      const state = this.awareness.getStates().get(id) as { user?: AwarenessUser } | undefined;
      if (state?.user) return state.user;
    }
    return undefined;
  }

  /**
   * Publishes (or with null, removes) an agent's caret as if a remote client had sent it: the update
   * goes through applyAwarenessUpdate, so states/meta/clock are maintained by y-protocols itself and
   * the hub's own awareness listener broadcasts it to every connection.
   */
  setAgentPresence(agentId: string, state: AgentPresenceState | null): void {
    const awareness = this.awareness;
    if (!awareness) return;
    let client = this.agentClients.get(agentId);
    if (!client) {
      if (state === null) return;
      client = { clientId: AGENT_CLIENT_BASE + this.nextAgentClient++, clock: 0 };
      this.agentClients.set(agentId, client);
    }
    client.clock += 1;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, client.clientId);
    encoding.writeVarUint(encoder, client.clock);
    encoding.writeVarString(encoder, JSON.stringify(state));
    awarenessProtocol.applyAwarenessUpdate(awareness, encoding.toUint8Array(encoder), "agent-presence");
    if (state === null) this.agentClients.delete(agentId);
  }

  /** Cursor state for an index inside a file of the bound doc, or null if the file is not in it. */
  cursorAt(path: string, index: number): AgentPresenceState["cursor"] | null {
    const text = this.doc?.getMap<Y.Text>("files").get(path);
    if (!text) return null;
    const pos = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, Math.max(0, Math.min(index, text.length))));
    return { anchor: pos, head: pos };
  }

  agentPresenceCount(): number {
    return this.agentClients.size;
  }

  connectionCount(): number {
    return this.conns.size;
  }

  handle(socket: WebSocket): void {
    const doc = this.doc;
    const awareness = this.awareness;
    if (!doc || !awareness) {
      socket.close(1011, "no document bound");
      return;
    }
    socket.binaryType = "arraybuffer";
    this.conns.set(socket, new Set());

    socket.on("message", (raw: RawData) => {
      try {
        const data = toUint8(raw);
        const decoder = decoding.createDecoder(data);
        const type = decoding.readVarUint(decoder);
        switch (type) {
          case MESSAGE_SYNC: {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
            if (encoding.length(encoder) > 1) send(socket, encoding.toUint8Array(encoder));
            break;
          }
          case MESSAGE_AWARENESS:
            awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), socket);
            break;
          default:
            break;
        }
      } catch (err) {
        console.error("[yjs] bad message:", err instanceof Error ? err.message : err);
      }
    });

    const cleanup = () => {
      const ids = this.conns.get(socket);
      this.conns.delete(socket);
      if (ids && ids.size > 0) awarenessProtocol.removeAwarenessStates(awareness, [...ids], null);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    // sync step 1
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(socket, encoding.toUint8Array(encoder));

    // current awareness states
    const states = awareness.getStates();
    if (states.size > 0) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(awareness, [...states.keys()]));
      send(socket, encoding.toUint8Array(aw));
    }
  }

  closeAll(code = 1001, reason = "server closing"): void {
    for (const socket of [...this.conns.keys()]) {
      try {
        socket.close(code, reason);
      } catch {
        // already closed
      }
    }
    this.conns.clear();
  }

  private broadcast(message: Uint8Array): void {
    for (const socket of this.conns.keys()) send(socket, message);
  }
}

function send(socket: WebSocket, message: Uint8Array): void {
  if (socket.readyState !== socket.OPEN && socket.readyState !== socket.CONNECTING) return;
  try {
    socket.send(message, (err) => {
      if (err) socket.close();
    });
  } catch {
    socket.close();
  }
}

function toUint8(raw: RawData): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  const buf = raw as Buffer;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
