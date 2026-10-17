import { describe, it, expect } from "vitest";
import { ReadLog } from "../../src/core/index.js";

describe("ReadLog", () => {
  it("9. readersOf(path, symbol) returns only agents whose read included that symbol, at their latest rev", () => {
    const log = new ReadLog();
    log.record("agent-a", "src/checkout.ts", 1, ["calculateTotal", "applyDiscount"]);
    log.record("agent-a", "src/checkout.ts", 4, ["calculateTotal", "applyDiscount"]); // re-read later
    log.record("agent-b", "src/checkout.ts", 2, ["applyTax"]);
    log.record("agent-c", "src/checkout.ts", 3, ["calculateTotal"]);
    log.record("agent-c", "src/format.ts", 5, ["formatPrice"]);
    log.record("agent-d", "src/format.ts", 6, ["formatPrice"]);

    const readers = log.readersOf("src/checkout.ts", "calculateTotal").sort((x, y) => x.agentId.localeCompare(y.agentId));
    expect(readers).toEqual([
      { agentId: "agent-a", rev: 4 },
      { agentId: "agent-c", rev: 3 },
    ]);
    expect(log.readersOf("src/checkout.ts", "applyTax")).toEqual([{ agentId: "agent-b", rev: 2 }]);
    expect(log.readersOf("src/checkout.ts", "nothing")).toEqual([]);
    expect(log.readersOf("src/nope.ts")).toEqual([]);
  });

  it("readersOf(path) without a symbol gives every reader's latest rev of the file", () => {
    const log = new ReadLog();
    log.record("agent-a", "src/checkout.ts", 1, ["calculateTotal"]);
    log.record("agent-a", "src/checkout.ts", 3, ["applyTax"]);
    log.record("agent-b", "src/checkout.ts", 2, []);
    expect(log.readersOf("src/checkout.ts").sort((x, y) => x.agentId.localeCompare(y.agentId))).toEqual([
      { agentId: "agent-a", rev: 3 },
      { agentId: "agent-b", rev: 2 },
    ]);
  });

  it("readsOf keeps the latest read per (path, symbol set)", () => {
    const log = new ReadLog();
    log.record("agent-a", "src/checkout.ts", 1, ["applyDiscount", "calculateTotal"]);
    log.record("agent-a", "src/checkout.ts", 2, ["applyTax"]);
    log.record("agent-a", "src/checkout.ts", 5, ["calculateTotal", "applyDiscount"]); // same set, different order
    log.record("agent-a", "src/format.ts", 3, ["formatPrice"]);
    // ordered by when each (path, symbol set) was last read
    expect(log.readsOf("agent-a")).toEqual([
      { path: "src/checkout.ts", rev: 2, symbols: ["applyTax"] },
      { path: "src/checkout.ts", rev: 5, symbols: ["applyDiscount", "calculateTotal"] },
      { path: "src/format.ts", rev: 3, symbols: ["formatPrice"] },
    ]);
    expect(log.readsOf("agent-z")).toEqual([]);
    log.clear();
    expect(log.readsOf("agent-a")).toEqual([]);
  });
});
