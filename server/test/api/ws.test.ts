import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { FeedEvent } from "@hive/shared";
import { GOOD_INTENT, listen, makeHive, register, sleep, type TestHive, waitFor } from "./helpers.js";

let t: TestHive;
const providers: WebsocketProvider[] = [];
afterEach(async () => {
  for (const p of providers.splice(0)) {
    p.destroy();
  }
  await t?.close();
});

function wsUrl(http: string): string {
  return http.replace(/^http/, "ws");
}

function connectProvider(base: string, doc: Y.Doc, user?: { name: string; color: string; kind: "human" | "agent" }): WebsocketProvider {
  const provider = new WebsocketProvider(`${wsUrl(base)}/yjs`, "project", doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, disableBc: true });
  if (user) provider.awareness.setLocalStateField("user", user);
  providers.push(provider);
  return provider;
}

async function synced(provider: WebsocketProvider): Promise<void> {
  if (provider.synced) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sync timeout")), 4000);
    const onSync = (isSynced: boolean) => {
      if (!isSynced) return;
      provider.off("sync", onSync);
      clearTimeout(timer);
      resolve();
    };
    provider.on("sync", onSync);
  });
}

describe("websockets", () => {
  it("11. /ws/feed streams the event of a tool call", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const base = await listen(t);
    const socket = new WebSocket(`${wsUrl(base)}/ws/feed`);
    const received: FeedEvent[] = [];
    socket.on("message", (data) => received.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    await t.tool("agent-andrii", "read_file", { path: "src/tax.ts" });
    await waitFor(() => received.some((e) => e.type === "file_read"));
    const ev = received.find((e) => e.type === "file_read");
    expect(ev).toMatchObject({ type: "file_read", agentId: "agent-andrii", path: "src/tax.ts", rev: 0 });
    expect(typeof ev?.id).toBe("number");
    expect(typeof ev?.ts).toBe("number");
    socket.close();
  });

  it("12. /yjs/project: WebsocketProvider sees files, edits, and a client insert increments rev with the awareness actor", async () => {
    t = await makeHive();
    register(t, "agent-andrii");
    const base = await listen(t);

    const doc1 = new Y.Doc();
    const p1 = connectProvider(base, doc1, { name: "andrii", color: "#f00", kind: "human" });
    await synced(p1);
    const files1 = doc1.getMap<Y.Text>("files");
    await waitFor(() => files1.get("src/format.ts") !== undefined);
    expect(files1.get("src/format.ts")?.toString()).toContain("toFixed(2)");

    // an agent edit through the tool API shows up on the client
    const declared = await t.tool("agent-andrii", "declare_intent", { ...GOOD_INTENT, target: { file: "src/format.ts", symbol: "formatPrice" } });
    await t.tool("agent-andrii", "edit_region", { intentId: declared.data!.intent.id, path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    await waitFor(() => files1.get("src/format.ts")?.toString().includes("toFixed(3)") ?? false);

    // a client-side insert reaches the server store with the awareness user as actor
    const revBefore = t.hive.ctx.deps.store.rev;
    const changes: { actor: string; path: string }[] = [];
    t.hive.ctx.deps.store.onChange((c) => changes.push({ actor: c.actor, path: c.path }));
    // awareness must be known server-side before the edit is attributed
    await waitFor(() => t.hive.hub.connectionCount() === 1);
    await sleep(50);
    files1.get("src/format.ts")?.insert(0, "// typed by a human\n");
    await waitFor(() => t.hive.ctx.deps.store.rev > revBefore, 3000);
    (t.hive.ctx.deps.store as { flushForeign?: () => void }).flushForeign?.();
    await waitFor(() => changes.length > 0);
    expect(changes[0]).toEqual({ actor: "andrii", path: "src/format.ts" });
    expect(t.hive.ctx.deps.store.readFile("src/format.ts")?.content.startsWith("// typed by a human")).toBe(true);
    const editEvents = t.events("edit_applied");
    expect(editEvents[editEvents.length - 1]).toMatchObject({ agentId: "andrii", path: "src/format.ts" });

    // two clients see each other's awareness
    const doc2 = new Y.Doc();
    const p2 = connectProvider(base, doc2, { name: "masha", color: "#0f0", kind: "human" });
    await synced(p2);
    await waitFor(() => [...p1.awareness.getStates().values()].some((s) => (s as { user?: { name: string } }).user?.name === "masha"));
    await waitFor(() => [...p2.awareness.getStates().values()].some((s) => (s as { user?: { name: string } }).user?.name === "andrii"));
    expect(doc2.getMap<Y.Text>("files").get("src/format.ts")?.toString()).toContain("typed by a human");
  });

  it("12b. isolated mode: /yjs/project serves only the main store", async () => {
    t = await makeHive({ mode: "isolated" });
    register(t, "agent-andrii");
    const base = await listen(t);
    const doc = new Y.Doc();
    const p = connectProvider(base, doc);
    await synced(p);
    const files = doc.getMap<Y.Text>("files");
    await waitFor(() => files.get("src/format.ts") !== undefined);

    const edit = await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    expect(edit.ok).toBe(true);
    await sleep(150);
    expect(files.get("src/format.ts")?.toString()).toContain("toFixed(2)");
    expect(t.hive.ctx.deps.store.readFile("src/format.ts")?.content).toContain("toFixed(2)");
    expect(t.hive.built.tools.storeFor("agent-andrii").readFile("src/format.ts")?.content).toContain("toFixed(3)");
  });
});
