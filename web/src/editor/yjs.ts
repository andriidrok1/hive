import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { agentColor } from "../state";

// What the hub needs from a provider; WebsocketProvider satisfies it, tests pass a fake.
export interface ProviderLike {
  awareness: { setLocalStateField(field: string, value: unknown): void };
  synced: boolean;
  on(name: "connection-close", cb: (event: { code?: number } | null) => void): void;
  on(name: "sync", cb: (synced: boolean) => void): void;
  off(name: "connection-close", cb: (event: { code?: number } | null) => void): void;
  off(name: "sync", cb: (synced: boolean) => void): void;
  destroy(): void;
}

export interface Shared {
  doc: Y.Doc;
  provider: ProviderLike;
  files: Y.Map<Y.Text>;
  generation: number;
}

// Close code the server uses when POST /api/reset rebinds its hub to a fresh document.
// Reconnecting the old doc would merge stale state back into the new project, so we
// throw the doc away and start a new provider instead.
export const RESET_CLOSE_CODE = 4000;

export class YjsHub {
  private shared: Shared | null = null;
  private generation = 0;
  private readonly subs = new Set<() => void>();
  private readonly resetSubs = new Set<() => void>();

  constructor(private readonly connect: (doc: Y.Doc) => ProviderLike) {}

  /** Current shared doc, created on first use. Stable until a reset replaces it. */
  snapshot = (): Shared => this.shared ?? this.create();

  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  };

  /** Called after the doc has been replaced because the server reset. */
  onReset(cb: () => void): () => void {
    this.resetSubs.add(cb);
    return () => this.resetSubs.delete(cb);
  }

  setUser(name: string): void {
    this.shared?.provider.awareness.setLocalStateField("user", { name, color: agentColor(name), kind: "human" });
  }

  /** Socket closed: only the reset code replaces the doc, anything else is a normal reconnect. */
  handleClose(code: number | undefined): boolean {
    if (code !== RESET_CLOSE_CODE) return false;
    const old = this.shared;
    this.shared = null;
    old?.provider.destroy();
    old?.doc.destroy();
    this.create();
    for (const cb of this.subs) cb();
    for (const cb of this.resetSubs) cb();
    return true;
  }

  private create(): Shared {
    const doc = new Y.Doc();
    const provider = this.connect(doc);
    const shared: Shared = { doc, provider, files: doc.getMap<Y.Text>("files"), generation: ++this.generation };
    this.shared = shared;
    provider.on("connection-close", (event) => {
      if (this.shared !== shared) return; // already replaced
      // Defer: the provider is still inside its own close handling.
      setTimeout(() => this.handleClose(event?.code), 0);
    });
    return shared;
  }
}

export const hub = new YjsHub(
  (doc) => new WebsocketProvider(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/yjs`, "project", doc) as unknown as ProviderLike,
);

export function useShared(): Shared {
  return useSyncExternalStore(hub.subscribe, hub.snapshot, hub.snapshot);
}
