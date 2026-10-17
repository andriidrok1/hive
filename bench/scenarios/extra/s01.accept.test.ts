import { describe, expect, it } from "vitest";
import { calculateTotal } from "../src/checkout.js";
import { orderSummary } from "../src/order.js";
import type { Item } from "../src/types.js";

// Intended combined behavior: calculateTotal includes tax (default CA),
// orderSummary shows the tax once and its total equals calculateTotal for the same state.
const items: Item[] = [{ sku: "mug", priceCents: 1000, qty: 1 }];

describe("s01 acceptance: tax is applied exactly once", () => {
  it("calculateTotal includes tax for the given state", () => {
    expect(calculateTotal(items, undefined, "NY")).toBe(1040);
    expect(calculateTotal(items)).toBe(1073);
  });

  it("orderSummary shows a single tax line and a once-taxed total", () => {
    const summary = orderSummary(items, undefined, "NY");
    expect(summary.total).toBe(1040);
    expect(summary.lines).toContain("Tax $0.40");
    expect(summary.lines.at(-1)).toBe("Total $10.40");
  });

  it("orderSummary total agrees with calculateTotal for the same state", () => {
    expect(orderSummary(items, undefined, "TX").total).toBe(calculateTotal(items, undefined, "TX"));
    expect(orderSummary(items, undefined, "CA").total).toBe(1073);
  });
});
