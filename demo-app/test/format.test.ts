import { describe, expect, it } from "vitest";
import { formatPrice } from "../src/format.js";

describe("formatPrice", () => {
  it("formats dollars and cents", () => {
    expect(formatPrice(1234)).toBe("$12.34");
  });

  it("pads cents to two digits", () => {
    expect(formatPrice(1005)).toBe("$10.05");
  });
});
