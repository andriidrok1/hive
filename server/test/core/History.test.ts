import { describe, it, expect } from "vitest";
import { applyPatch } from "diff";
import type { Intent } from "@hive/shared";
import { ProjectStore, History, applyEdits, buildView } from "../../src/core/index.js";
import { FILES, CHECKOUT } from "./fixtures.js";

function intent(id: string, agentId: string, symbol: string, baseRev: number): Intent {
  return {
    id,
    agentId,
    humanId: agentId.replace("agent-", ""),
    status: "approved",
    createdAt: 0,
    updatedAt: 0,
    baseRev,
    target: { file: "src/checkout.ts", symbol },
    action: "modify",
    what: `change ${symbol}`,
    input: "same",
    output: `${symbol} does something new`,
  };
}

function setup() {
  const store = new ProjectStore();
  store.loadFiles(FILES);
  const history = new History(store);
  store.onChange((c) => history.recordEdit(c)); // brief 03 wires this once
  const green = history.saveSnapshot(true);
  return { store, history, green };
}

function edit(store: ProjectStore, actor: string, intentId: string, oldText: string, newText: string) {
  const r = store.editRegion({ actor, intentId, path: "src/checkout.ts", oldText, newText });
  if (!r.ok) throw new Error(`edit failed: ${r.code}`);
  return r.rev;
}

function applySequentially(base: string, edits: { path: string; patch: string }[]): string {
  let text = base;
  for (const e of edits) {
    const next = applyPatch(text, e.patch);
    if (next === false) throw new Error("patch did not apply");
    text = next;
  }
  return text;
}

const A_EDIT_1 = ["  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);", "  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);\n  if (subtotal < 0) throw new Error(\"negative subtotal\");"] as const;
const B_EDIT = ['  const rate = state === "CA" ? 0.0725 : 0;', '  const rate = state === "CA" ? 0.0725 : state === "NY" ? 0.08875 : 0;'] as const;
const A_EDIT_2 = ["  return applyDiscount(subtotal, promo);", "  return Math.max(0, applyDiscount(subtotal, promo));"] as const;

describe("History", () => {
  it("10. per-intent change sets replay independently and compose to the current state", () => {
    const { store, history, green } = setup();
    history.beginIntent(intent("A1", "agent-a", "calculateTotal", 0));
    history.beginIntent(intent("B1", "agent-b", "applyTax", 0));

    edit(store, "agent-a", "A1", ...A_EDIT_1);
    edit(store, "agent-b", "B1", ...B_EDIT);
    edit(store, "agent-a", "A1", ...A_EDIT_2);

    const a = history.finishIntent("A1");
    const b = history.finishIntent("B1");
    expect(a.edits).toHaveLength(2);
    expect(b.edits).toHaveLength(1);
    expect(a).toMatchObject({ id: "A1", agentId: "agent-a", humanId: "a", files: ["src/checkout.ts"], baseRev: 0, endRev: 3, added: 2, removed: 1 });
    expect(b).toMatchObject({ id: "B1", agentId: "agent-b", humanId: "b", baseRev: 0, endRev: 2, added: 1, removed: 1 });

    const base = green.files["src/checkout.ts"]!;
    expect(base).toBe(CHECKOUT);

    const onlyA = applySequentially(base, a.edits);
    expect(onlyA).toContain("negative subtotal");
    expect(onlyA).toContain("Math.max(0, applyDiscount");
    expect(onlyA).not.toContain('state === "NY"');

    const onlyB = applySequentially(base, b.edits);
    expect(onlyB).toContain('state === "NY"');
    expect(onlyB).not.toContain("negative subtotal");
    expect(onlyB).not.toContain("Math.max(0, applyDiscount");

    const both = applySequentially(onlyA, b.edits);
    expect(both).toBe(store.readFile("src/checkout.ts")!.content);

    // the display patch spans first-before to last-after and is not meant to be applied alone
    expect(a.patch).toContain("Index: src/checkout.ts");
    expect(a.patch).toContain("+  return Math.max(0, applyDiscount(subtotal, promo));");
  });

  it("13a. applyEdits reports the failing edit", () => {
    const { store, history, green } = setup();
    history.beginIntent(intent("A1", "agent-a", "calculateTotal", 0));
    edit(store, "agent-a", "A1", ...A_EDIT_2);
    const a = history.finishIntent("A1");
    const broken = { ...green.files, "src/checkout.ts": "export function somethingElse() {}\n" };
    const res = applyEdits(broken, [{ path: "src/format.ts", patch: a.edits[0]!.patch.replace("src/checkout.ts", "src/format.ts") }, ...a.edits]);
    expect(res).toEqual({ ok: false, path: "src/format.ts", index: 0 });
    const res2 = applyEdits(broken, a.edits);
    expect(res2).toEqual({ ok: false, path: "src/checkout.ts", index: 0 });
    const good = applyEdits(green.files, a.edits);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.files["src/checkout.ts"]).toBe(store.readFile("src/checkout.ts")!.content);
      expect(green.files["src/checkout.ts"]).toBe(CHECKOUT); // input not mutated
    }
  });

  it("13b. two intents editing adjacent lines each apply alone on the green snapshot", () => {
    const { store, history, green } = setup();
    history.beginIntent(intent("A1", "agent-a", "applyTax", 0));
    history.beginIntent(intent("B1", "agent-b", "applyTax", 0));
    // A changes the `rate` line, then B changes the very next line, then A touches the line above `rate`
    edit(store, "agent-a", "A1", ...B_EDIT);
    edit(store, "agent-b", "B1", "  return Math.round(total * (1 + rate));", "  return Math.ceil(total * (1 + rate));");
    edit(store, "agent-a", "A1", "export function applyTax(total: number, state: string): number {", "export function applyTax(total: number, state: string = \"CA\"): number {");
    const a = history.finishIntent("A1");
    const b = history.finishIntent("B1");

    const onlyA = applyEdits(green.files, a.edits);
    expect(onlyA.ok).toBe(true);
    if (onlyA.ok) {
      expect(onlyA.files["src/checkout.ts"]).toContain('state === "NY"');
      expect(onlyA.files["src/checkout.ts"]).toContain('state: string = "CA"');
      expect(onlyA.files["src/checkout.ts"]).toContain("Math.round(total");
    }
    const onlyB = applyEdits(green.files, b.edits);
    expect(onlyB.ok).toBe(true);
    if (onlyB.ok) {
      expect(onlyB.files["src/checkout.ts"]).toContain("Math.ceil(total");
      expect(onlyB.files["src/checkout.ts"]).not.toContain('state === "NY"');
      expect(onlyB.files["src/checkout.ts"]).not.toContain('string = "CA"');
    }
    const all = applyEdits(green.files, [...a.edits, ...b.edits]);
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.files["src/checkout.ts"]).toBe(store.readFile("src/checkout.ts")!.content);
  });

  it("13c. adjacent edits in a file without a trailing newline still replay alone", () => {
    const store = new ProjectStore();
    store.loadFiles({ "src/t.ts": "export function f() {\n  const a = 1;\n  return a;\n}" });
    const history = new History(store);
    store.onChange((c) => history.recordEdit(c));
    const green = history.saveSnapshot(true);
    history.beginIntent({ ...intent("A1", "agent-a", "f", 0), target: { file: "src/t.ts", symbol: "f" } });
    history.beginIntent({ ...intent("B1", "agent-b", "f", 0), target: { file: "src/t.ts", symbol: "f" } });
    expect(store.editRegion({ actor: "agent-a", intentId: "A1", path: "src/t.ts", oldText: "  const a = 1;", newText: "  const a = 2;" }).ok).toBe(true);
    expect(store.editRegion({ actor: "agent-b", intentId: "B1", path: "src/t.ts", oldText: "  return a;\n}", newText: "  return a * 2;\n}" }).ok).toBe(true);
    const a = history.finishIntent("A1");
    const b = history.finishIntent("B1");
    const onlyB = applyEdits(green.files, b.edits);
    expect(onlyB.ok).toBe(true);
    if (onlyB.ok) expect(onlyB.files["src/t.ts"]).toBe("export function f() {\n  const a = 1;\n  return a * 2;\n}");
    const onlyA = applyEdits(green.files, a.edits);
    expect(onlyA.ok).toBe(true);
    if (onlyA.ok) expect(onlyA.files["src/t.ts"]).toBe("export function f() {\n  const a = 2;\n  return a;\n}");
    const all = applyEdits(green.files, [...b.edits, ...a.edits]); // any order, both land
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.files["src/t.ts"]).toBe(store.readFile("src/t.ts")!.content);
  });

  it("applyEdits creates files from a create_file patch", () => {
    const { store, history, green } = setup();
    history.beginIntent(intent("A1", "agent-a", "log", 0));
    store.createFile({ actor: "agent-a", intentId: "A1", path: "src/log.ts", content: "export const log = console.log;\n" });
    const a = history.finishIntent("A1");
    expect(a.files).toEqual(["src/log.ts"]);
    const res = applyEdits(green.files, a.edits);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.files["src/log.ts"]).toBe("export const log = console.log;\n");
  });

  it("11. changeSetsSince(greenRev) returns finished change sets in endRev order", () => {
    const { store, history } = setup();
    history.beginIntent(intent("A1", "agent-a", "calculateTotal", 0));
    history.beginIntent(intent("B1", "agent-b", "applyTax", 0));
    history.beginIntent(intent("C1", "agent-c", "applyDiscount", 0));
    edit(store, "agent-c", "C1", "  if (!promo) return subtotal;", "  if (!promo || promo.percent <= 0) return subtotal;"); // rev 1
    history.finishIntent("C1");
    const greenRev = history.saveSnapshot(true).rev; // 1
    edit(store, "agent-a", "A1", ...A_EDIT_1); // rev 2
    edit(store, "agent-b", "B1", ...B_EDIT); // rev 3
    edit(store, "agent-a", "A1", ...A_EDIT_2); // rev 4
    // B finishes before A but A's last edit is later
    history.finishIntent("B1");
    history.finishIntent("A1");
    expect(history.changeSets().map((c) => c.id)).toEqual(["C1", "B1", "A1"]);
    const since = history.changeSetsSince(greenRev);
    expect(since.map((c) => [c.id, c.endRev])).toEqual([
      ["B1", 3],
      ["A1", 4],
    ]);
    expect(history.changeSetsSince(0).map((c) => c.id)).toEqual(["C1", "B1", "A1"]);
    expect(history.changeSetsSince(4)).toEqual([]);
  });

  it("12. lastGreen() is a frozen copy unaffected by later edits", () => {
    const { store, history } = setup();
    history.beginIntent(intent("A1", "agent-a", "calculateTotal", 0));
    edit(store, "agent-a", "A1", ...A_EDIT_2);
    const green = history.saveSnapshot(true);
    expect(green.rev).toBe(1);
    edit(store, "agent-a", "A1", ...A_EDIT_1);
    store.humanReplaceFile("andrii", "src/format.ts", "// gone\n");
    const red = history.saveSnapshot(false);
    expect(red.rev).toBe(3);
    const last = history.lastGreen()!;
    expect(last).toBe(green);
    expect(last.files["src/checkout.ts"]).toContain("Math.max(0, applyDiscount");
    expect(last.files["src/checkout.ts"]).not.toContain("negative subtotal");
    expect(last.files["src/format.ts"]).toBe(FILES["src/format.ts"]);
    expect(history.allSnapshots()).toHaveLength(3);
  });

  it("openEdits returns in-progress edits in order and nothing after finish", () => {
    const { store, history, green } = setup();
    expect(history.openEdits("A1")).toEqual([]);
    history.beginIntent(intent("A1", "agent-a", "calculateTotal", 0));
    expect(history.openEdits("A1")).toEqual([]);
    edit(store, "agent-a", "A1", ...A_EDIT_1);
    const one = history.openEdits("A1");
    expect(one).toHaveLength(1);
    expect(one[0]!.path).toBe("src/checkout.ts");
    expect(one[0]!.patch).toContain("+  if (subtotal < 0)");
    edit(store, "agent-a", "A1", ...A_EDIT_2);
    const two = history.openEdits("A1");
    expect(two).toHaveLength(2);
    expect(two[1]!.patch).toContain("+  return Math.max(0, applyDiscount");
    const replay = applyEdits(green.files, two);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.files["src/checkout.ts"]).toBe(store.readFile("src/checkout.ts")!.content);
    const cs = history.finishIntent("A1");
    expect(cs.edits).toEqual(two);
    expect(history.openEdits("A1")).toEqual([]);
  });

  it("openIntents lists begun-and-unfinished intents, optionally per agent", () => {
    const { store, history } = setup();
    expect(history.openIntents()).toEqual([]);
    history.beginIntent(intent("A1", "agent-a", "calculateTotal", 0));
    history.beginIntent(intent("B1", "agent-b", "applyTax", 0));
    history.beginIntent(intent("A2", "agent-a", "applyDiscount", 0));
    edit(store, "agent-a", "A1", ...A_EDIT_1);
    store.createFile({ actor: "agent-a", intentId: "A1", path: "src/log.ts", content: "// log\n" });
    expect(history.openIntents()).toEqual([
      { intentId: "A1", agentId: "agent-a", files: ["src/checkout.ts", "src/log.ts"] },
      { intentId: "B1", agentId: "agent-b", files: [] },
      { intentId: "A2", agentId: "agent-a", files: [] },
    ]);
    expect(history.openIntents("agent-b")).toEqual([{ intentId: "B1", agentId: "agent-b", files: [] }]);
    expect(history.openIntents("agent-z")).toEqual([]);
    history.finishIntent("A1");
    expect(history.openIntents("agent-a")).toEqual([{ intentId: "A2", agentId: "agent-a", files: [] }]);
  });

  it("saveSnapshot with a view stores the view, not the live store", () => {
    const { store, history } = setup();
    history.beginIntent(intent("A1", "agent-a", "calculateTotal", 0));
    edit(store, "agent-a", "A1", ...A_EDIT_2); // rev 1
    const view = { rev: 1, files: store.allFiles() };
    // a concurrent edit by someone else lands before the orchestrator saves the result
    store.editRegion({ actor: "agent-b", intentId: "B1", path: "src/checkout.ts", oldText: "0.0725", newText: "0.0875" }); // rev 2
    const snap = history.saveSnapshot(true, view);
    expect(snap.rev).toBe(1);
    expect(snap.green).toBe(true);
    expect(snap.files["src/checkout.ts"]).toContain("Math.max(0, applyDiscount");
    expect(snap.files["src/checkout.ts"]).not.toContain("0.0875");
    expect(history.lastGreen()).toBe(snap);
    // the stored files are a copy: mutating the caller's view afterwards changes nothing
    view.files["src/checkout.ts"] = "mutated";
    expect(snap.files["src/checkout.ts"]).not.toBe("mutated");
    const live = history.saveSnapshot(false);
    expect(live.rev).toBe(2);
    expect(live.files["src/checkout.ts"]).toContain("0.0875");
  });

  it("buildView = base + finished sets in order + extra edits", () => {
    const { store, history, green } = setup();
    history.beginIntent(intent("A1", "agent-a", "calculateTotal", 0));
    history.beginIntent(intent("B1", "agent-b", "applyTax", 0));
    history.beginIntent(intent("C1", "agent-c", "applyDiscount", 0));
    edit(store, "agent-a", "A1", ...A_EDIT_1);
    edit(store, "agent-b", "B1", ...B_EDIT);
    edit(store, "agent-a", "A1", ...A_EDIT_2);
    edit(store, "agent-c", "C1", "  if (!promo) return subtotal;", "  if (!promo || promo.percent <= 0) return subtotal;");
    history.finishIntent("A1");
    history.finishIntent("B1");
    const sets = history.changeSetsSince(green.rev);
    expect(sets.map((s) => s.id)).toEqual(["B1", "A1"]);

    const withoutC = buildView(green.files, sets);
    expect(withoutC.ok).toBe(true);
    if (withoutC.ok) {
      const t = withoutC.files["src/checkout.ts"]!;
      expect(t).toContain("negative subtotal");
      expect(t).toContain('state === "NY"');
      expect(t).not.toContain("promo.percent <= 0");
    }

    const forC = buildView(green.files, sets, history.openEdits("C1"));
    expect(forC.ok).toBe(true);
    if (forC.ok) expect(forC.files["src/checkout.ts"]).toBe(store.readFile("src/checkout.ts")!.content);
    expect(green.files["src/checkout.ts"]).toBe(CHECKOUT); // base untouched

    const brokenSet = { ...sets[0]!, id: "X9", edits: [{ path: "src/checkout.ts", patch: sets[0]!.edits[0]!.patch.replace("0.0725", "9.9999") }] };
    const bad = buildView(green.files, [brokenSet]);
    expect(bad).toEqual({ ok: false, failedAt: { intentId: "X9", path: "src/checkout.ts", index: 0 } });
    const badExtra = buildView(green.files, [], brokenSet.edits);
    expect(badExtra).toEqual({ ok: false, failedAt: { path: "src/checkout.ts", index: 0 } });
  });

  it("ignores edits without an intent or outside an open intent; finishIntent is idempotent", () => {
    const { store, history } = setup();
    store.editRegion({ actor: "human", path: "src/checkout.ts", oldText: "0.0725", newText: "0.08" });
    history.beginIntent(intent("A1", "agent-a", "applyTax", 1));
    edit(store, "agent-a", "A1", "0.08", "0.0875");
    const first = history.finishIntent("A1");
    edit(store, "agent-a", "A1", "0.0875", "0.09"); // after finish: not part of the set
    const again = history.finishIntent("A1");
    expect(again).toBe(first);
    expect(first.edits).toHaveLength(1);
    expect(first.baseRev).toBe(1);
    expect(() => history.finishIntent("ZZ")).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    history.beginIntent(intent("E1", "agent-e", "formatPrice", 3));
    const empty = history.finishIntent("E1");
    expect(empty.edits).toEqual([]);
    expect(empty.endRev).toBe(store.rev);
    expect(empty.patch).toBe("");
  });
});
