import { describe, expect, it } from "vitest";
import { formatPrice } from "../src/format.js";
import { orderSummary, receiptTotalLine } from "../src/order.js";
import type { Item } from "../src/types.js";

const items: Item[] = [
  { sku: "mug", priceCents: 1000, qty: 1 },
  { sku: "pen", priceCents: 250, qty: 2 },
];

describe("s05 acceptance: currency is explicit everywhere", () => {
  it("formatPrice needs a currency", () => {
    expect(formatPrice(1234, "USD")).toBe("$12.34");
    expect(formatPrice(1234, "EUR")).toBe("€12.34");
    expect(() => (formatPrice as unknown as (c: number, cur: string) => string)(1234, "GBP")).toThrow();
  });

  it("receipt helpers format in dollars", () => {
    expect(receiptTotalLine(items)).toBe("TOTAL $15.00");
    expect(orderSummary(items).lines.at(-1)).toBe("Total $15.00");
  });
});
