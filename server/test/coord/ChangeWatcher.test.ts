import { describe, expect, it, vi } from "vitest";
import type { HiveMode } from "@hive/shared";
import { BriefingQueue } from "../../src/coord/BriefingQueue.js";
import { CallGraph } from "../../src/coord/CallGraph.js";
import { ChangeWatcher, diffSymbols } from "../../src/coord/ChangeWatcher.js";
import { IntentRegistry } from "../../src/coord/IntentRegistry.js";
import { CHECK_PROMPTS, FakeLLM } from "../../src/coord/llm.js";
import { CHECKOUT_TS, FakeReadLog, REPORT_TS, eventSink } from "./fakes.js";

const A = "agent-andrii";
const B = "agent-boris";
const M = "agent-masha";

function setup(mode: HiveMode = "hive", behaviorChanged: boolean | (() => boolean) = true) {
  const sink = eventSink();
  const graph = new CallGraph();
  graph.update({ "src/checkout.ts": CHECKOUT_TS, "src/report.ts": REPORT_TS });
  const reads = new FakeReadLog();
  const briefings = new BriefingQueue({ onEvent: sink.onEvent });
  const llm = new FakeLLM((system) => {
    if (system === CHECK_PROMPTS.meaning) {
      return { meaning: "calculateTotal was renamed to calcTotal; callers must use the new name", behaviorChanged: typeof behaviorChanged === "function" ? behaviorChanged() : behaviorChanged };
    }
    return { conflict: false, with: [], reason: "" };
  });
  const intents = new IntentRegistry({ llm, graph, reads, briefings, onEvent: sink.onEvent, mode });
  const watcher = new ChangeWatcher({ llm, graph, reads, intents, briefings, onEvent: sink.onEvent, mode });
  return { sink, graph, reads, briefings, llm, intents, watcher };
}

const RENAMED = CHECKOUT_TS.replace(/calculateTotal/g, "calcTotal");

describe("diffSymbols", () => {
  it("classifies signature, body, rename, add and remove", () => {
    expect(diffSymbols("x.ts", CHECKOUT_TS, RENAMED)).toEqual([
      { symbol: "applyTax", kind: "body" },
      { symbol: "helper", kind: "body" },
      { symbol: "calculateTotal", kind: "renamed", renamedTo: "calcTotal" },
    ]);
    const sig = CHECKOUT_TS.replace("applyTax(items: Item[], state: string, promo?: Promo)", "applyTax(items: Item[], state: string)");
    expect(diffSymbols("x.ts", CHECKOUT_TS, sig)).toEqual([{ symbol: "applyTax", kind: "signature" }]);
    const removedAndAdded = CHECKOUT_TS.replace(/export type Money = number;/, "export function nothingAlike(): void {}");
    expect(diffSymbols("x.ts", CHECKOUT_TS, removedAndAdded)).toEqual([
      { symbol: "Money", kind: "removed" },
      { symbol: "nothingAlike", kind: "added" },
    ]);
    // a comment-only or whitespace-only edit has no symbol changes
    expect(diffSymbols("x.ts", CHECKOUT_TS, CHECKOUT_TS.replace("No tax.", "No tax, ever."))).toEqual([]);
    expect(diffSymbols("x.ts", CHECKOUT_TS, CHECKOUT_TS.replace("\n  const rate", "\n\n  const rate"))).toEqual([]);
  });
});

describe("ChangeWatcher", () => {
  it("12. rename by A briefs B (reader + caller) with yourUsages; A gets nothing", async () => {
    const { watcher, reads, briefings, llm, intents } = setup();
    reads.record(A, "src/checkout.ts", 1, ["calculateTotal", "applyTax"]);
    reads.record(B, "src/checkout.ts", 1, ["calculateTotal", "applyTax"]);
    reads.record(B, "src/report.ts", 1, ["report"]);
    await intents.declare(A, "andrii", { target: { file: "src/checkout.ts", symbol: "calculateTotal" }, action: "modify", what: "rename to calcTotal", input: "same", output: "same behavior under the shorter name calcTotal" }, 1);
    briefings.takeUndelivered(B);

    await watcher.onEdit({ path: "src/checkout.ts", rev: 2, actor: A, intentId: "A1", before: CHECKOUT_TS, after: RENAMED });

    expect(llm.calls.filter((c) => c.system === CHECK_PROMPTS.meaning)).toHaveLength(1);
    expect(briefings.takeUndelivered(A)).toEqual([]);
    const toB = briefings.takeUndelivered(B);
    // one briefing per changed symbol B depends on: calculateTotal (renamed) and applyTax (body); helper was never read
    expect(toB.map((b) => [b.kind, b.details.symbol])).toEqual([
      ["symbol_changed", "applyTax"],
      ["symbol_changed", "calculateTotal"],
    ]);
    const calc = toB.find((b) => b.details.symbol === "calculateTotal")!;
    expect(calc).toMatchObject({ requiresAck: true, fromAgent: A, details: { file: "src/checkout.ts", intentId: "A1" } });
    expect(calc.summary).toContain("renamed calculateTotal to calcTotal");
    expect(calc.summary).toContain("callers must use the new name");
    expect(calc.summary.length).toBeLessThanOrEqual(400);
    expect(calc.details.yourUsages).toEqual(expect.arrayContaining([{ file: "src/checkout.ts", line: 15 }, { file: "src/report.ts", line: 5 }]));
    expect(calc.details.diff).toContain("-export function calculateTotal");
    expect(calc.details.diff).toContain("+export function calcTotal");
    expect(calc.details.diff!.length).toBeLessThanOrEqual(2000);
  });

  it("13. ignores comment-only and whitespace-only edits", async () => {
    const { watcher, reads, briefings, llm } = setup();
    reads.record(B, "src/checkout.ts", 1, ["calculateTotal"]);
    await watcher.onEdit({ path: "src/checkout.ts", rev: 2, actor: A, before: CHECKOUT_TS, after: CHECKOUT_TS.replace("No tax.", "Never any tax here.") });
    await watcher.onEdit({ path: "src/checkout.ts", rev: 3, actor: A, before: CHECKOUT_TS, after: CHECKOUT_TS.replace("  return promo", "    return promo") });
    await watcher.onEdit({ path: "src/checkout.ts", rev: 4, actor: A, before: CHECKOUT_TS, after: CHECKOUT_TS });
    expect(briefings.all()).toEqual([]);
    expect(llm.calls).toEqual([]);
  });

  it("briefs owners of active intents on callers and readers of caller files; skips actor and non-dependents", async () => {
    const { watcher, reads, briefings, intents } = setup();
    // M has an active intent on report (calls calculateTotal) but never read checkout.ts
    await intents.declare(M, "masha", { target: { file: "src/report.ts", symbol: "report" }, action: "modify", what: "prefix the report", input: "items", output: "returns 'Total: ' followed by the formatted price" }, 1);
    // B read report.ts (a caller file) only
    reads.record(B, "src/report.ts", 1, ["report"]);
    // human edit from the web editor, no intent
    const after = CHECKOUT_TS.replace("return promo ? applyDiscount(subtotal, promo) : subtotal;", "return Math.round((promo ? applyDiscount(subtotal, promo) : subtotal) * 1.0725);");
    await watcher.onEdit({ path: "src/checkout.ts", rev: 5, actor: "andrii", before: CHECKOUT_TS, after });

    const toM = briefings.takeUndelivered(M);
    expect(toM).toHaveLength(1);
    expect(toM[0]).toMatchObject({ kind: "symbol_changed", fromHuman: "andrii", details: { symbol: "calculateTotal", yourUsages: [{ file: "src/report.ts", line: 5 }] } });
    expect(toM[0]?.details.intentId).toBeUndefined();
    expect(toM[0]?.summary).toContain("M1");
    const toB = briefings.takeUndelivered(B);
    expect(toB).toHaveLength(1);
    expect(toB[0]?.details.yourUsages).toEqual([{ file: "src/report.ts", line: 5 }]);
    expect(briefings.takeUndelivered(A)).toEqual([]);
  });

  it("readers who re-read after the change are not briefed; a dead LLM still briefs mechanically", async () => {
    const { watcher, reads, briefings, llm } = setup();
    reads.record(B, "src/checkout.ts", 9, ["calculateTotal"]);
    reads.record(M, "src/checkout.ts", 1, ["calculateTotal"]);
    llm.calls.length = 0;
    const broken = new ChangeWatcher({ llm: new FakeLLM(() => { throw new Error("down"); }), graph: new CallGraph(), reads, intents: { list: () => [] }, briefings, onEvent: () => {}, mode: "hive" });
    void watcher;
    await broken.onEdit({ path: "src/checkout.ts", rev: 5, actor: A, before: CHECKOUT_TS, after: RENAMED });
    expect(briefings.takeUndelivered(B)).toEqual([]);
    const toM = briefings.takeUndelivered(M);
    expect(toM).toHaveLength(1);
    expect(toM[0]?.summary).toMatch(/^agent-andrii renamed calculateTotal to calcTotal in src\/checkout.ts\. /);
  });

  it("cosmetic body edits (behaviorChanged=false) produce no briefing; signature/rename/remove always do", async () => {
    const { watcher, reads, briefings, llm } = setup("hive", false);
    reads.record(B, "src/checkout.ts", 1, ["calculateTotal", "applyTax"]);
    // body-only: rename a local variable
    const cosmetic = CHECKOUT_TS.replace("const subtotal = items", "const sub = items").replace("applyDiscount(subtotal, promo) : subtotal;", "applyDiscount(sub, promo) : sub;");
    await watcher.onEdit({ path: "src/checkout.ts", rev: 2, actor: A, before: CHECKOUT_TS, after: cosmetic });
    expect(llm.calls.filter((c) => c.system === CHECK_PROMPTS.meaning)).toHaveLength(1);
    expect(llm.calls[0]?.shapeHint).toBe("{meaning: string, behaviorChanged: boolean}");
    expect(briefings.all()).toEqual([]);

    // signature change: briefed even though the model says behaviorChanged=false
    const sig = CHECKOUT_TS.replace("applyTax(items: Item[], state: string, promo?: Promo)", "applyTax(items: Item[], state: string)");
    await watcher.onEdit({ path: "src/checkout.ts", rev: 3, actor: A, before: CHECKOUT_TS, after: sig });
    expect(briefings.takeUndelivered(B).map((b) => b.details.symbol)).toEqual(["applyTax"]);

    // rename: briefed; the cosmetic body change of applyTax in the same edit is not
    await watcher.onEdit({ path: "src/checkout.ts", rev: 4, actor: A, before: CHECKOUT_TS, after: RENAMED });
    expect(briefings.takeUndelivered(B).map((b) => b.details.symbol)).toEqual(["calculateTotal"]);

    // removal: briefed
    await watcher.onEdit({ path: "src/checkout.ts", rev: 5, actor: A, before: CHECKOUT_TS, after: CHECKOUT_TS.replace(/export function applyTax[\s\S]*?\n}\n/, "") });
    expect(briefings.takeUndelivered(B).map((b) => [b.details.symbol, b.summary.startsWith(`${A} removed applyTax`)])).toEqual([["applyTax", true]]);

    // a body change the model flags as behavioral is briefed
    const { watcher: w2, reads: r2, briefings: q2 } = setup("hive", true);
    r2.record(B, "src/checkout.ts", 1, ["calculateTotal"]);
    await w2.onEdit({ path: "src/checkout.ts", rev: 2, actor: A, before: CHECKOUT_TS, after: CHECKOUT_TS.replace("Math.max(0, subtotal - promo.value)", "subtotal - promo.value") });
    // B read checkout.ts, whose calculateTotal calls applyDiscount: briefed as a reader of a caller file
    expect(q2.takeUndelivered(B).map((b) => [b.details.symbol, b.details.yourUsages])).toEqual([["applyDiscount", [{ file: "src/checkout.ts", line: 6 }]]]);
    await w2.onEdit({ path: "src/checkout.ts", rev: 3, actor: A, before: CHECKOUT_TS, after: CHECKOUT_TS.replace(": subtotal;", ": subtotal + 1;") });
    expect(q2.takeUndelivered(B).map((b) => b.details.symbol)).toEqual(["calculateTotal"]);
  });

  it("coalesces repeated edits of the same symbol by the same actor within 3 s into one pending briefing", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
      const { watcher, reads, briefings, sink } = setup();
      reads.record(B, "src/checkout.ts", 1, ["calculateTotal"]);
      const v1 = CHECKOUT_TS.replace(": subtotal;", ": subtotal + 1;");
      const v2 = v1.replace("subtotal + 1", "subtotal + 2");
      const v3 = v2.replace("subtotal + 2", "subtotal + 3");

      await watcher.onEdit({ path: "src/checkout.ts", rev: 2, actor: A, before: CHECKOUT_TS, after: v1 });
      vi.advanceTimersByTime(1000);
      await watcher.onEdit({ path: "src/checkout.ts", rev: 3, actor: A, before: v1, after: v2 });
      expect(briefings.all()).toHaveLength(1);
      expect(briefings.all()[0]?.details.diff).toContain("subtotal + 2");
      expect(sink.ofType("briefing_sent")).toHaveLength(1);

      // a different actor editing the same symbol is a separate briefing
      await watcher.onEdit({ path: "src/checkout.ts", rev: 4, actor: M, before: v2, after: v3 });
      expect(briefings.all()).toHaveLength(2);

      // after the window a new briefing is added
      vi.advanceTimersByTime(3001);
      await watcher.onEdit({ path: "src/checkout.ts", rev: 5, actor: A, before: v3, after: v3.replace("subtotal + 3", "subtotal + 4") });
      expect(briefings.all()).toHaveLength(3);

      // once delivered, the next edit creates a fresh briefing even inside the window
      briefings.takeUndelivered(B);
      await watcher.onEdit({ path: "src/checkout.ts", rev: 6, actor: A, before: v3, after: v3.replace("subtotal + 3", "subtotal + 5") });
      expect(briefings.all()).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no-op in naive and isolated modes", async () => {
    for (const mode of ["naive", "isolated"] as const) {
      const { watcher, reads, briefings, llm } = setup(mode);
      reads.record(B, "src/checkout.ts", 1, ["calculateTotal"]);
      await watcher.onEdit({ path: "src/checkout.ts", rev: 2, actor: A, before: CHECKOUT_TS, after: RENAMED });
      expect(briefings.all()).toEqual([]);
      expect(llm.calls).toEqual([]);
    }
  });
});
