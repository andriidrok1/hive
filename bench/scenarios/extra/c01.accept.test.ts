import { describe, expect, it } from "vitest";
import { applyDiscount } from "../src/discount.js";
import { TAX_RATES, applyTax } from "../src/tax.js";

describe("c01 acceptance: both additions work together", () => {
  it("knows the Washington rate", () => {
    expect(TAX_RATES.WA).toBe(0.065);
    expect(applyTax(10000, "WA")).toBe(10650);
  });

  it("rejects out-of-range percent promos and keeps valid ones", () => {
    expect(() => applyDiscount(1000, { code: "BAD", kind: "percent", value: 150 })).toThrow(/percent/);
    expect(() => applyDiscount(1000, { code: "NEG", kind: "percent", value: -1 })).toThrow(/percent/);
    expect(applyDiscount(1000, { code: "HALF", kind: "percent", value: 50 })).toBe(500);
  });
});
