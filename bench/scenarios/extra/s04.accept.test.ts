import { describe, expect, it } from "vitest";
import { calculateTotal } from "../src/checkout.js";
import { totalWithTax } from "../src/tax.js";
import type { Item } from "../src/types.js";

const items: Item[] = [{ sku: "gum", priceCents: 25, qty: 1 }];
const half = { code: "HALF", kind: "percent" as const, value: 50 };

describe("s04 acceptance: whole cents, rounded once", () => {
  it("calculateTotal returns whole cents", () => {
    expect(calculateTotal(items, half)).toBe(13);
    expect(Number.isInteger(calculateTotal([{ sku: "x", priceCents: 999, qty: 1 }], { code: "P", kind: "percent", value: 15 }))).toBe(true);
  });

  it("totalWithTax rounds only once", () => {
    expect(totalWithTax(items, half, "NY")).toBe(13);
    expect(totalWithTax(items, half, "OR")).toBe(13);
  });
});
