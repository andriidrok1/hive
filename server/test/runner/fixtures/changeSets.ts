import { createPatch } from "diff";
import type { ChangeSet, IntentId, Snapshot } from "@hive/shared";
import { applyEdits } from "../../../src/runner/applyEdits.js";
import { DEMO_APP_FILES } from "./demoApp.js";

export interface EditSpec {
  path: string;
  /** Text to replace (must occur once) */
  oldText: string;
  newText: string;
}

/** Build a ChangeSet by applying `edits` sequentially to `base`, recording one real createPatch per edit. */
export function makeChangeSet(
  base: Record<string, string>,
  spec: { id: IntentId; agentId: string; humanId: string; what: string; baseRev?: number; endRev?: number },
  edits: EditSpec[],
): { changeSet: ChangeSet; files: Record<string, string> } {
  const files = { ...base };
  const patches: { path: string; patch: string }[] = [];
  const firstBefore: Record<string, string> = {};
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    const before = files[e.path] ?? "";
    const count = before.split(e.oldText).length - 1;
    if (count !== 1) throw new Error(`oldText occurs ${count} times in ${e.path}`);
    const after = before.replace(e.oldText, e.newText);
    firstBefore[e.path] ??= before;
    patches.push({ path: e.path, patch: createPatch(e.path, before, after, "", "", { context: 3 }) });
    files[e.path] = after;
    added += e.newText.split("\n").length;
    removed += e.oldText.split("\n").length;
  }
  const touched = [...new Set(edits.map((e) => e.path))];
  const display = touched.map((p) => createPatch(p, firstBefore[p] ?? "", files[p] ?? "", "", "", { context: 3 })).join("\n");
  return {
    changeSet: {
      id: spec.id,
      agentId: spec.agentId,
      humanId: spec.humanId,
      what: spec.what,
      files: touched,
      edits: patches,
      patch: display,
      baseRev: spec.baseRev ?? 0,
      endRev: spec.endRev ?? 1,
      added,
      removed,
    },
    files,
  };
}

export function greenSnapshot(files: Record<string, string> = DEMO_APP_FILES, rev = 0): Snapshot {
  return { rev, files: { ...files }, green: true, at: Date.now() };
}

/** Apply several change sets in order on top of a base; throws if one does not apply. */
export function applyAll(base: Record<string, string>, sets: ChangeSet[]): Record<string, string> {
  let files = base;
  for (const s of sets) {
    const r = applyEdits(files, s.edits);
    if (!r.ok) throw new Error(`${s.id} edit ${r.index} on ${r.path} did not apply`);
    files = r.files;
  }
  return files;
}

// ---------- Ready-made change sets on the demo app ----------

const agentA = { agentId: "agent-andrii", humanId: "andrii" };
const agentB = { agentId: "agent-masha", humanId: "masha" };

/** S1: harmless formatting change in format.ts. */
export function harmlessFormatChange(base = DEMO_APP_FILES): ChangeSet {
  return makeChangeSet(base, { id: "A1", ...agentA, what: "tidy formatPrice", endRev: 1 }, [
    {
      path: "src/format.ts",
      oldText: `  return "$" + (cents / 100).toFixed(2);`,
      newText: `  const dollars = (cents / 100).toFixed(2);\n  return "$" + dollars;`,
    },
  ]).changeSet;
}

/** S2: breaks percent discounts (rounds down instead of to nearest). */
export function breakDiscount(base = DEMO_APP_FILES): ChangeSet {
  return makeChangeSet(base, { id: "B1", ...agentB, what: "floor percent discounts", endRev: 2 }, [
    {
      path: "src/discount.ts",
      oldText: `promo.kind === "percent" ? Math.round((subtotalCents * promo.value) / 100) : promo.value;`,
      newText: `promo.kind === "percent" ? Math.floor((subtotalCents * promo.value) / 100) + 1 : promo.value;`,
    },
  ]).changeSet;
}

/** S1 of the pair: calculateTotal includes CA tax by default, with its tests updated. Alone green. */
export function taxInCalculateTotal(base = DEMO_APP_FILES): ChangeSet {
  return makeChangeSet(base, { id: "A2", ...agentA, what: "calculateTotal includes state tax", endRev: 3 }, [
    {
      path: "src/checkout.ts",
      oldText: `import { applyDiscount } from "./discount.js";\n`,
      newText: `import { applyDiscount } from "./discount.js";\nimport { applyTax, type State } from "./tax.js";\n`,
    },
    {
      path: "src/checkout.ts",
      oldText: `export function calculateTotal(items: Item[], promo?: Promo): number {\n  return applyDiscount(subtotal(items), promo);\n}`,
      newText: `export function calculateTotal(items: Item[], promo?: Promo, state: State = "CA"): number {\n  return applyTax(applyDiscount(subtotal(items), promo), state);\n}`,
    },
    {
      path: "test/checkout.test.ts",
      oldText: `  it("equals subtotal without promo", () => {\n    expect(calculateTotal(items)).toBe(10000);\n  });`,
      newText: `  it("includes CA tax without promo", () => {\n    expect(calculateTotal(items)).toBe(10725);\n  });\n\n  it("takes a state for the tax", () => {\n    expect(calculateTotal(items, undefined, "OR")).toBe(10000);\n  });`,
    },
    {
      path: "test/checkout.test.ts",
      oldText: `expect(calculateTotal(items, { code: "TEN", kind: "percent", value: 10 })).toBe(9000);`,
      newText: `expect(calculateTotal(items, { code: "TEN", kind: "percent", value: 10 })).toBe(9653);`,
    },
    {
      path: "test/checkout.test.ts",
      oldText: `expect(calculateTotal(items, { code: "OFF5", kind: "fixed", value: 500 })).toBe(9500);`,
      newText: `expect(calculateTotal(items, { code: "OFF5", kind: "fixed", value: 500 })).toBe(10189);`,
    },
  ]).changeSet;
}

/** S2 of the pair: orderSummary gets a tax line computed on top of calculateTotal, assuming no tax inside it. Alone green. */
export function taxLineInOrderSummary(base = DEMO_APP_FILES): ChangeSet {
  return makeChangeSet(base, { id: "B2", ...agentB, what: "orderSummary shows tax separately", endRev: 4 }, [
    {
      path: "src/order.ts",
      oldText: `import { formatPrice } from "./format.js";\n`,
      newText: `import { formatPrice } from "./format.js";\nimport { applyTax, type State } from "./tax.js";\n`,
    },
    {
      path: "src/order.ts",
      oldText: `  total: number;\n  lines: string[];\n}`,
      newText: `  total: number;\n  tax: number;\n  lines: string[];\n}`,
    },
    {
      path: "src/order.ts",
      oldText: `export function orderSummary(items: Item[], promo?: Promo): OrderSummary {\n  const sub = subtotal(items);\n  const total = calculateTotal(items, promo);\n  const discount = sub - total;\n  const lines = [\n    "Subtotal: " + formatPrice(sub),\n    "Discount: " + formatPrice(discount),\n    "Total: " + formatPrice(total),\n  ];\n  return { subtotal: sub, discount, total, lines };\n}`,
      newText: `export function orderSummary(items: Item[], promo?: Promo, state: State = "CA"): OrderSummary {\n  const sub = subtotal(items);\n  const total = calculateTotal(items, promo);\n  const discount = sub - total;\n  const tax = applyTax(calculateTotal(items, promo), state) - calculateTotal(items, promo);\n  const lines = [\n    "Subtotal: " + formatPrice(sub),\n    "Discount: " + formatPrice(discount),\n    "Tax: " + formatPrice(tax),\n    "Total: " + formatPrice(total),\n  ];\n  return { subtotal: sub, discount, total, tax, lines };\n}`,
    },
    {
      path: "test/order.test.ts",
      oldText: `  it("renders three lines", () => {\n    const s = orderSummary(items, { code: "TEN", kind: "percent", value: 10 });\n    expect(s.lines).toHaveLength(3);`,
      newText: `  it("shows CA tax on the discounted total", () => {\n    const s = orderSummary(items, undefined, "CA");\n    expect(s.tax).toBe(725);\n    expect(s.lines[2]).toBe("Tax: $7.25");\n  });\n\n  it("renders four lines", () => {\n    const s = orderSummary(items, { code: "TEN", kind: "percent", value: 10 });\n    expect(s.lines).toHaveLength(4);`,
    },
  ]).changeSet;
}

/**
 * Dependent pair: D1 adds a helper line in format.ts (green alone); D2's patch was made on top of D1
 * and rewrites that helper to break formatting, so D2 only applies after D1.
 */
export function dependentPair(base = DEMO_APP_FILES): { d1: ChangeSet; d2: ChangeSet } {
  const first = makeChangeSet(base, { id: "A3", ...agentA, what: "extract dollars helper", endRev: 5 }, [
    {
      path: "src/format.ts",
      oldText: `export function formatPrice(cents: number): string {\n  return "$" + (cents / 100).toFixed(2);\n}`,
      newText: `function dollars(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n\nexport function formatPrice(cents: number): string {\n  return "$" + dollars(cents);\n}`,
    },
  ]);
  const second = makeChangeSet(first.files, { id: "B3", ...agentB, what: "round dollars helper", endRev: 6 }, [
    {
      path: "src/format.ts",
      oldText: `function dollars(cents: number): string {\n  return (cents / 100).toFixed(2);\n}`,
      newText: `function dollars(cents: number): string {\n  return Math.round(cents / 100).toFixed(2);\n}`,
    },
  ]);
  return { d1: first.changeSet, d2: second.changeSet };
}
