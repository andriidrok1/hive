import { describe, expect, it } from "vitest";
import * as format from "../src/format.js";
import { receiptLine } from "../src/receipt.js";

describe("s02 acceptance: rename landed and the new caller uses the new name", () => {
  it("exports formatCents and no formatPrice", () => {
    expect(format.formatCents(1234)).toBe("$12.34");
    expect("formatPrice" in format).toBe(false);
  });

  it("receiptLine formats unit price and line total", () => {
    expect(receiptLine({ sku: "pen", priceCents: 250, qty: 2 })).toBe("pen x2 @ $2.50 = $5.00");
  });
});
