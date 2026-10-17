import { describe, expect, it } from "vitest";
import { calculateTotal } from "../src/checkout.js";
import { applyDiscount } from "../src/discount.js";
import { PROMOS, findPromo } from "../src/promos.js";

describe("s03 acceptance: fixed promos are dollars and WELCOME5 is $5 off", () => {
  it("fixed promo values are whole dollars", () => {
    expect(applyDiscount(1000, { code: "TWO", kind: "fixed", value: 2 })).toBe(800);
  });

  it("WELCOME5 takes five dollars off a $20 cart", () => {
    expect(calculateTotal([{ sku: "mug", priceCents: 2000, qty: 1 }], PROMOS.WELCOME5)).toBe(1500);
    expect(calculateTotal([{ sku: "mug", priceCents: 2000, qty: 1 }], findPromo("welcome5"))).toBe(1500);
  });
});
