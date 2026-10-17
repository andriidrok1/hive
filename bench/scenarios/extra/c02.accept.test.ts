import { describe, expect, it } from "vitest";
import { itemCount } from "../src/checkout.js";
import { formatPrice } from "../src/format.js";

describe("c02 acceptance: both helpers work together", () => {
  it("formats negative amounts", () => {
    expect(formatPrice(-1234)).toBe("-$12.34");
    expect(formatPrice(1234)).toBe("$12.34");
  });

  it("counts items", () => {
    expect(itemCount([{ sku: "mug", priceCents: 1000, qty: 1 }, { sku: "pen", priceCents: 250, qty: 2 }])).toBe(3);
    expect(itemCount([])).toBe(0);
  });
});
