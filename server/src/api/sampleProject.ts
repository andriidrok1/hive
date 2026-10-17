// Tiny checkout project modeled on demo-app (brief 07). Used by tests and as the dev fallback
// when HIVE_PROJECT_DIR has no files yet.
export const SAMPLE_PROJECT: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo-app", private: true, type: "module", scripts: { test: "vitest run" } }, null, 2) + "\n",
  "src/types.ts": `export interface Item {
  sku: string;
  priceCents: number;
  qty: number;
}

export interface Promo {
  code: string;
  kind: "percent" | "fixed";
  value: number;
}
`,
  "src/discount.ts": `import type { Promo } from "./types.js";

export function applyDiscount(subtotalCents: number, promo?: Promo): number {
  if (!promo) return subtotalCents;
  const discount = promo.kind === "percent" ? Math.round((subtotalCents * promo.value) / 100) : promo.value;
  return Math.max(0, subtotalCents - discount);
}
`,
  "src/checkout.ts": `import type { Item, Promo } from "./types.js";
import { applyDiscount } from "./discount.js";

export function subtotal(items: Item[]): number {
  return items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);
}

export function calculateTotal(items: Item[], promo?: Promo): number {
  return applyDiscount(subtotal(items), promo);
}
`,
  "src/tax.ts": `import { calculateTotal } from "./checkout.js";
import type { Item, Promo } from "./types.js";

export const TAX_RATES: Record<string, number> = { CA: 0.0725, NY: 0.04, TX: 0.0625, OR: 0 };

export function applyTax(totalCents: number, state: string): number {
  const rate = TAX_RATES[state] ?? 0;
  return Math.round(totalCents * (1 + rate));
}

export function totalWithTax(items: Item[], state: string, promo?: Promo): number {
  return applyTax(calculateTotal(items, promo), state);
}
`,
  "src/format.ts": `export function formatPrice(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
`,
  "test/checkout.test.ts": `import { describe, it, expect } from "vitest";
import { calculateTotal } from "../src/checkout.js";

describe("calculateTotal", () => {
  it("sums items without tax", () => {
    expect(calculateTotal([{ sku: "a", priceCents: 1000, qty: 2 }])).toBe(2000);
  });
});
`,
};
