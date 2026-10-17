import { describe, expect, it } from "vitest";
import { applyDiscount } from "../src/discount.js";

describe("applyDiscount", () => {
  it("returns the subtotal unchanged without a promo", () => {
    expect(applyDiscount(1000)).toBe(1000);
  });

  it("takes a percentage off", () => {
    expect(applyDiscount(1000, { code: "TEN", kind: "percent", value: 10 })).toBe(900);
  });

  it("takes a fixed amount of cents off", () => {
    expect(applyDiscount(1000, { code: "OFF250", kind: "fixed", value: 250 })).toBe(750);
  });

  it("never goes below zero", () => {
    expect(applyDiscount(200, { code: "BIG", kind: "fixed", value: 500 })).toBe(0);
  });
});
