import { describe, expect, it } from "vitest";
import { subtotal } from "../src/checkout.js";
import { orderSummary } from "../src/order.js";
import type { Item } from "../src/types.js";

const cart: Item[] = [
  { sku: "mug", priceCents: 1000, qty: 1 },
  { sku: "ghost", priceCents: 500, qty: 0 },
  { sku: "pen", priceCents: 300, qty: -1 },
];

describe("s06 acceptance: zero lines are ignored, negative lines are refunds", () => {
  it("subtotal ignores qty 0 and subtracts refunds", () => {
    expect(subtotal(cart)).toBe(700);
  });

  it("orderSummary shows the refund and the reduced total", () => {
    const summary = orderSummary(cart);
    expect(summary.total).toBe(700);
    expect(summary.lines).toContain("Refund pen x1 -$3.00");
    expect(summary.lines.at(-1)).toBe("Total $7.00");
  });
});
