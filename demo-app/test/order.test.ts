import { describe, expect, it } from "vitest";
import { orderSummary } from "../src/order.js";
import type { Item } from "../src/types.js";

const items: Item[] = [
  { sku: "mug", priceCents: 1000, qty: 1 },
  { sku: "pen", priceCents: 250, qty: 2 },
];

describe("orderSummary", () => {
  it("lists items, subtotal and total without a promo", () => {
    const summary = orderSummary(items);
    expect(summary.subtotal).toBe(1500);
    expect(summary.discount).toBe(0);
    expect(summary.total).toBe(1500);
    expect(summary.lines).toEqual(["mug x1 $10.00", "pen x2 $5.00", "Subtotal $15.00", "Total $15.00"]);
  });

  it("shows the discount line with a promo", () => {
    const summary = orderSummary(items, { code: "TEN", kind: "percent", value: 10 });
    expect(summary.discount).toBe(150);
    expect(summary.total).toBe(1350);
    expect(summary.lines).toEqual([
      "mug x1 $10.00",
      "pen x2 $5.00",
      "Subtotal $15.00",
      "Discount -$1.50",
      "Total $13.50",
    ]);
  });

  it("handles an empty cart", () => {
    const summary = orderSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.lines).toEqual(["Subtotal $0.00", "Total $0.00"]);
  });
});
