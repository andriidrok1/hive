import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { agentColor } from "../state";

export interface Shared {
  doc: Y.Doc;
  provider: WebsocketProvider;
  files: Y.Map<Y.Text>;
}

let shared: Shared | null = null;

// One Yjs connection per page, exactly as CONTRACTS.md spells it out.
export function getShared(humanId: string): Shared {
  if (!shared) {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/yjs`, "project", doc);
    shared = { doc, provider, files: doc.getMap<Y.Text>("files") };
  }
  shared.provider.awareness.setLocalStateField("user", { name: humanId, color: agentColor(humanId), kind: "human" });
  return shared;
}
