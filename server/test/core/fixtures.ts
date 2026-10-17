export const CHECKOUT = `export interface Item { price: number; qty: number }
export interface Promo { code: string; percent: number }

export function calculateTotal(items: Item[], promo?: Promo): number {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  return applyDiscount(subtotal, promo);
}

export function applyDiscount(subtotal: number, promo?: Promo): number {
  if (!promo) return subtotal;
  return subtotal - Math.round((subtotal * promo.percent) / 100);
}

export function applyTax(total: number, state: string): number {
  const rate = state === "CA" ? 0.0725 : 0;
  return Math.round(total * (1 + rate));
}
`;

export const FORMAT = `export function formatPrice(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
`;

export const TEST_FILE = `import { it, expect } from "vitest";
import { calculateTotal } from "../src/checkout.js";
it("adds", () => { expect(calculateTotal([{ price: 100, qty: 2 }])).toBe(200); });
`;

export const FILES: Record<string, string> = {
  "src/checkout.ts": CHECKOUT,
  "src/format.ts": FORMAT,
  "test/checkout.test.ts": TEST_FILE,
};
