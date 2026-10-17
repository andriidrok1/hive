import { describe, expect, it } from "vitest";
import { calculateTotal, subtotal } from "../src/checkout.js";
import type { Item } from "../src/types.js";

const items: Item[] = [
  { sku: "mug", priceCents: 1000, qty: 1 },
  { sku: "pen", priceCents: 250, qty: 2 },
];

describe("subtotal", () => {
  it("sums price times quantity", () => {
    expect(subtotal(items)).toBe(1500);
  });

  it("is zero for an empty cart", () => {
    expect(subtotal([])).toBe(0);
  });
});

describe("calculateTotal", () => {
  it("equals the subtotal without a promo", () => {
    expect(calculateTotal(items)).toBe(1500);
  });

  it("applies a percent promo", () => {
    expect(calculateTotal(items, { code: "TEN", kind: "percent", value: 10 })).toBe(1350);
  });

  it("applies a fixed promo", () => {
    expect(calculateTotal(items, { code: "OFF500", kind: "fixed", value: 500 })).toBe(1000);
  });

  it("does not include tax", () => {
    expect(calculateTotal([{ sku: "tv", priceCents: 100000, qty: 1 }])).toBe(100000);
  });
});
