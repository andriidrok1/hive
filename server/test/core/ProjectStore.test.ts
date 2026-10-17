import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";
import type { FeedEventBody } from "@hive/shared";
import { ProjectStore, FOREIGN_DEBOUNCE_MS, type FileChange } from "../../src/core/index.js";
import { FILES, CHECKOUT } from "./fixtures.js";

function makeStore(opts?: ConstructorParameters<typeof ProjectStore>[0]): ProjectStore {
  const store = new ProjectStore(opts);
  store.loadFiles(FILES);
  return store;
}

/** A second Yjs peer (the web editor) synced with the store's doc. */
function peer(store: ProjectStore): { doc: Y.Doc; text(path: string): Y.Text; push(): void } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.ydoc));
  return {
    doc,
    text: (path) => doc.getMap<Y.Text>("files").get(path)!,
    push: () => Y.applyUpdate(store.ydoc, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(store.ydoc))),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectStore", () => {
  it("1. loads 3 files at rev 0", () => {
    const events: FeedEventBody[] = [];
    const store = makeStore({ onEvent: (e) => events.push(e) });
    expect(store.rev).toBe(0);
    const list = store.listFiles();
    expect(list).toHaveLength(3);
    expect(list.every((f) => f.rev === 0)).toBe(true);
    expect(list.map((f) => f.path)).toEqual(["src/checkout.ts", "src/format.ts", "test/checkout.test.ts"]);
    expect(events).toEqual([]);
    expect(store.readFile("src/format.ts")).toEqual({ content: FILES["src/format.ts"], rev: 0 });
    expect(store.readFile("nope.ts")).toBeNull();
  });

  it("2. editRegion with a unique match updates content, rev and line counts", () => {
    const events: FeedEventBody[] = [];
    const changes: FileChange[] = [];
    const store = makeStore({ onEvent: (e) => events.push(e) });
    store.onChange((c) => changes.push(c));
    const res = store.editRegion({
      actor: "agent-a",
      intentId: "A1",
      path: "src/checkout.ts",
      oldText: "  return applyDiscount(subtotal, promo);\n",
      newText: "  const discounted = applyDiscount(subtotal, promo);\n  return Math.max(0, discounted);\n",
    });
    expect(res).toEqual({ ok: true, rev: 1, added: 2, removed: 1 });
    expect(store.rev).toBe(1);
    const file = store.readFile("src/checkout.ts")!;
    expect(file.rev).toBe(1);
    expect(file.content).toContain("return Math.max(0, discounted);");
    expect(file.content).not.toContain("  return applyDiscount(subtotal, promo);\n");
    expect(store.listFiles().find((f) => f.path === "src/format.ts")?.rev).toBe(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "src/checkout.ts", rev: 1, actor: "agent-a", intentId: "A1", before: CHECKOUT });
    expect(changes[0]!.after).toBe(file.content);
    expect(events).toEqual([{ type: "edit_applied", agentId: "agent-a", intentId: "A1", path: "src/checkout.ts", rev: 1, added: 2, removed: 1 }]);
  });

  it("3. editRegion with missing text returns OLD_TEXT_NOT_FOUND with the latest content", () => {
    const store = makeStore();
    store.editRegion({ actor: "agent-b", path: "src/checkout.ts", oldText: "0.0725", newText: "0.0875" });
    const latest = store.readFile("src/checkout.ts")!.content;
    const res = store.editRegion({ actor: "agent-a", path: "src/checkout.ts", oldText: "does not exist", newText: "x" });
    expect(res).toEqual({ ok: false, code: "OLD_TEXT_NOT_FOUND", current: latest });
    expect(store.rev).toBe(1);
    expect(store.editRegion({ actor: "agent-a", path: "missing.ts", oldText: "a", newText: "b" })).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("4. editRegion with an ambiguous match changes nothing", () => {
    const changes: FileChange[] = [];
    const store = makeStore();
    store.onChange((c) => changes.push(c));
    const res = store.editRegion({ actor: "agent-a", path: "src/checkout.ts", oldText: "subtotal", newText: "sub" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("OLD_TEXT_AMBIGUOUS");
    expect(store.rev).toBe(0);
    expect(store.readFile("src/checkout.ts")!.content).toBe(CHECKOUT);
    expect(changes).toEqual([]);
  });

  it("5. two agents editing different functions back to back both land", () => {
    const store = makeStore();
    const a = store.editRegion({
      actor: "agent-a",
      intentId: "A1",
      path: "src/checkout.ts",
      oldText: "  return applyDiscount(subtotal, promo);",
      newText: "  return Math.max(0, applyDiscount(subtotal, promo));",
    });
    const b = store.editRegion({
      actor: "agent-b",
      intentId: "B1",
      path: "src/checkout.ts",
      oldText: '  const rate = state === "CA" ? 0.0725 : 0;',
      newText: '  const rate = state === "CA" ? 0.0725 : state === "NY" ? 0.08875 : 0;',
    });
    expect(a.ok && b.ok).toBe(true);
    expect(store.rev).toBe(2);
    const content = store.readFile("src/checkout.ts")!.content;
    expect(content).toContain("Math.max(0, applyDiscount(subtotal, promo))");
    expect(content).toContain('state === "NY" ? 0.08875 : 0');
    expect(content.split("\n")).toHaveLength(CHECKOUT.split("\n").length);
  });

  it("6. a foreign Yjs update bumps rev and fires onChange with actor human after the debounce", () => {
    vi.useFakeTimers();
    const changes: FileChange[] = [];
    const events: FeedEventBody[] = [];
    const store = makeStore({ onEvent: (e) => events.push(e) });
    store.onChange((c) => changes.push(c));
    const p = peer(store);
    p.text("src/format.ts").insert(0, "// human was here\n");
    p.push();
    // typing is debounced: nothing yet
    expect(changes).toHaveLength(0);
    expect(store.rev).toBe(0);
    p.text("src/format.ts").insert(0, "// more\n");
    p.push();
    vi.advanceTimersByTime(FOREIGN_DEBOUNCE_MS + 10);
    expect(store.rev).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "src/format.ts", rev: 1, actor: "human", before: FILES["src/format.ts"] });
    expect(changes[0]!.intentId).toBeUndefined();
    expect(changes[0]!.after.startsWith("// more\n// human was here\n")).toBe(true);
    expect(store.readFile("src/format.ts")!.rev).toBe(1);
    expect(events).toEqual([{ type: "edit_applied", agentId: "human", path: "src/format.ts", rev: 1, added: 2, removed: 0 }]);
  });

  it("6b. resolveActor attributes foreign updates and reads flush pending typing early", () => {
    vi.useFakeTimers();
    const changes: FileChange[] = [];
    const store = makeStore({ resolveActor: (origin) => (origin === "conn-1" ? "bob" : "human") });
    store.onChange((c) => changes.push(c));
    const p = peer(store);
    p.text("src/format.ts").insert(0, "// bob\n");
    Y.applyUpdate(store.ydoc, Y.encodeStateAsUpdate(p.doc, Y.encodeStateVector(store.ydoc)), "conn-1");
    expect(store.rev).toBe(0);
    const read = store.readFile("src/format.ts")!;
    expect(read.rev).toBe(1);
    expect(read.content.startsWith("// bob\n")).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.actor).toBe("bob");
    vi.advanceTimersByTime(FOREIGN_DEBOUNCE_MS * 2);
    expect(changes).toHaveLength(1);
  });

  it("7. a human inserting text at the top between two agent edits does not break the second edit", () => {
    vi.useFakeTimers();
    const store = makeStore();
    const changes: FileChange[] = [];
    store.onChange((c) => changes.push(c));
    const a = store.editRegion({
      actor: "agent-a",
      intentId: "A1",
      path: "src/checkout.ts",
      oldText: "  return applyDiscount(subtotal, promo);",
      newText: "  return Math.max(0, applyDiscount(subtotal, promo));",
    });
    expect(a.ok).toBe(true);
    const p = peer(store);
    p.text("src/checkout.ts").insert(0, "// checkout module\nimport { log } from './log.js';\n");
    p.push();
    const b = store.editRegion({
      actor: "agent-b",
      intentId: "B1",
      path: "src/checkout.ts",
      oldText: '  const rate = state === "CA" ? 0.0725 : 0;',
      newText: '  const rate = state === "CA" ? 0.0725 : state === "NY" ? 0.08875 : 0;',
    });
    expect(b).toMatchObject({ ok: true, rev: 3 });
    const content = store.readFile("src/checkout.ts")!.content;
    expect(content.startsWith("// checkout module\n")).toBe(true);
    expect(content).toContain("Math.max(0, applyDiscount(subtotal, promo))");
    expect(content).toContain('state === "NY"');
    // the human's change was recorded as its own rev before agent-b's edit
    expect(changes.map((c) => [c.actor, c.rev])).toEqual([
      ["agent-a", 1],
      ["human", 2],
      ["agent-b", 3],
    ]);
    expect(changes[1]!.before).toBe(changes[0]!.after);
    expect(changes[2]!.before).toBe(changes[1]!.after);
    vi.advanceTimersByTime(FOREIGN_DEBOUNCE_MS * 2);
    expect(changes).toHaveLength(3);
  });

  it("7b. agent region edit and concurrent human typing elsewhere both survive", () => {
    vi.useFakeTimers();
    const store = makeStore();
    const p = peer(store);
    // human types at the end while the agent edits the middle; neither has seen the other yet
    p.text("src/checkout.ts").insert(p.text("src/checkout.ts").length, "export const VERSION = 2;\n");
    const a = store.editRegion({ actor: "agent-a", path: "src/checkout.ts", oldText: "0.0725", newText: "0.0875" });
    expect(a.ok).toBe(true);
    p.push();
    Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(store.ydoc, Y.encodeStateVector(p.doc)));
    vi.advanceTimersByTime(FOREIGN_DEBOUNCE_MS + 10);
    const content = store.readFile("src/checkout.ts")!.content;
    expect(content).toContain("0.0875");
    expect(content.endsWith("export const VERSION = 2;\n")).toBe(true);
    expect(p.text("src/checkout.ts").toString()).toBe(content);
    expect(store.rev).toBe(2);
  });

  it("8. createFile happy path, duplicate and bad paths", () => {
    const events: FeedEventBody[] = [];
    const store = makeStore({ onEvent: (e) => events.push(e) });
    const res = store.createFile({ actor: "agent-a", intentId: "A1", path: "src/log.ts", content: "export const log = console.log;\n" });
    expect(res).toEqual({ ok: true, rev: 1 });
    expect(store.readFile("src/log.ts")).toEqual({ content: "export const log = console.log;\n", rev: 1 });
    expect(store.listFiles()).toHaveLength(4);
    expect(events).toEqual([{ type: "edit_applied", agentId: "agent-a", intentId: "A1", path: "src/log.ts", rev: 1, added: 1, removed: 0 }]);
    expect(store.createFile({ actor: "agent-b", path: "src/log.ts", content: "x" })).toEqual({ ok: false, code: "BAD_ARGS" });
    for (const bad of ["/etc/passwd", "../x.ts", "src/../../x.ts", "src\\x.ts", "", "src/", "./x.ts", "C:/x.ts"]) {
      expect(store.createFile({ actor: "agent-b", path: bad, content: "x" }), bad).toEqual({ ok: false, code: "BAD_ARGS" });
    }
    expect(store.rev).toBe(1);
  });

  it("humanReplaceFile replaces the whole file and attributes it to the human", () => {
    const changes: FileChange[] = [];
    const store = makeStore();
    store.onChange((c) => changes.push(c));
    expect(store.humanReplaceFile("andrii", "src/format.ts", "export const formatPrice = (c: number) => `$${c / 100}`;\n")).toEqual({ rev: 1 });
    expect(changes[0]).toMatchObject({ actor: "andrii", path: "src/format.ts", rev: 1, before: FILES["src/format.ts"] });
    expect(store.humanReplaceFile("andrii", "src/new.ts", "// new\n")).toEqual({ rev: 2 });
    expect(store.readFile("src/new.ts")).toEqual({ content: "// new\n", rev: 2 });
    expect(store.allFiles()["src/new.ts"]).toBe("// new\n");
  });

  it("onChange unsubscribe stops delivery; empty oldText throws BAD_ARGS", () => {
    const store = makeStore();
    const seen: FileChange[] = [];
    const off = store.onChange((c) => seen.push(c));
    off();
    store.editRegion({ actor: "agent-a", path: "src/checkout.ts", oldText: "0.0725", newText: "0.08" });
    expect(seen).toEqual([]);
    expect(() => store.editRegion({ actor: "agent-a", path: "src/checkout.ts", oldText: "", newText: "x" })).toThrowError(
      expect.objectContaining({ code: "BAD_ARGS" }),
    );
  });
});
