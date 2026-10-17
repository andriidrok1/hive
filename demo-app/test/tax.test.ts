import { describe, expect, it } from "vitest";
import { TAX_RATES, applyTax } from "../src/tax.js";

describe("applyTax", () => {
  it("adds California tax", () => {
    expect(applyTax(10000, "CA")).toBe(10725);
  });

  it("adds New York tax", () => {
    expect(applyTax(1000, "NY")).toBe(1040);
  });

  it("rounds to whole cents", () => {
    expect(applyTax(1000, "TX")).toBe(1063);
  });

  it("charges nothing in Oregon", () => {
    expect(TAX_RATES.OR).toBe(0);
    expect(applyTax(1000, "OR")).toBe(1000);
  });

  it("rejects unknown states", () => {
    expect(() => applyTax(1000, "ZZ")).toThrow(/Unknown state/);
  });
});
