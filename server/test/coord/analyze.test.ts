import { describe, expect, it } from "vitest";
import { analyzeFile, normalizeCode, symbolsInRange } from "../../src/coord/analyze.js";
import { CallGraph } from "../../src/coord/CallGraph.js";
import { CHECKOUT_TS, REPORT_TS } from "./fakes.js";

describe("analyzeFile", () => {
  const { symbols, calls } = analyzeFile("src/checkout.ts", CHECKOUT_TS);
  const byName = Object.fromEntries(symbols.map((s) => [s.name, s]));

  it("1. finds top-level symbols with kinds, line ranges and exported flags", () => {
    expect(symbols.map((s) => s.name)).toEqual(["calculateTotal", "applyDiscount", "applyTax", "formatPrice", "Money", "Receipt", "helper"]);
    expect(byName.calculateTotal).toEqual({ name: "calculateTotal", kind: "function", startLine: 4, endLine: 7, exported: true });
    expect(byName.applyTax).toMatchObject({ kind: "function", startLine: 14, endLine: 18, exported: true });
    expect(byName.formatPrice).toMatchObject({ kind: "const", startLine: 20, endLine: 23, exported: true });
    expect(byName.Money).toMatchObject({ kind: "type", startLine: 25, endLine: 25, exported: true });
    expect(byName.Receipt).toMatchObject({ kind: "interface", startLine: 27, endLine: 30, exported: true });
    expect(byName.helper).toMatchObject({ kind: "function", startLine: 32, endLine: 34, exported: false });
  });

  it("2. attributes calls to the enclosing top-level symbol, including inside nested arrows", () => {
    const toCalc = calls.filter((c) => c.callee === "calculateTotal");
    expect(toCalc).toContainEqual({ file: "src/checkout.ts", line: 15, caller: "applyTax", callee: "calculateTotal" });
    // inside items.map((it) => calculateTotal([it])) within helper
    expect(toCalc).toContainEqual({ file: "src/checkout.ts", line: 33, caller: "helper", callee: "calculateTotal" });
    expect(calls.find((c) => c.callee === "applyDiscount")?.caller).toBe("calculateTotal");
    // property-access calls (items.reduce, Math.round) are not identifier callees
    expect(calls.some((c) => c.callee === "round" || c.callee === "reduce")).toBe(false);
  });

  it("handles export lists and module-level calls", () => {
    const src = `const a = 1;\nfunction b() { return a; }\nb();\nexport { b };\n`;
    const r = analyzeFile("src/x.ts", src);
    expect(r.symbols).toEqual([
      { name: "a", kind: "const", startLine: 1, endLine: 1, exported: false },
      { name: "b", kind: "function", startLine: 2, endLine: 2, exported: true },
    ]);
    expect(r.calls).toEqual([{ file: "src/x.ts", line: 3, caller: null, callee: "b" }]);
  });

  it("normalizeCode ignores comments and whitespace", () => {
    const a = normalizeCode("x.ts", "function f(a: number) {\n  return a + 1; // one\n}\n");
    const b = normalizeCode("x.ts", "/** doc */\nfunction f(a: number) { return a + 1; }\n");
    expect(a).toBe(b);
    expect(a).not.toBe(normalizeCode("x.ts", "function f(a: number) { return a + 2; }"));
  });

  it("symbolsInRange picks overlapping symbols", () => {
    expect(symbolsInRange(symbols, 15, 21).map((s) => s.name)).toEqual(["applyTax", "formatPrice"]);
  });
});

describe("CallGraph", () => {
  it("3. callersOf across two files, cached by content, symbolAt", () => {
    const g = new CallGraph();
    g.update({ "src/checkout.ts": CHECKOUT_TS, "src/report.ts": REPORT_TS, "README.md": "# not code" });
    const callers = g.callersOf("calculateTotal");
    expect(callers.map((c) => `${c.file}:${c.line}:${c.caller}`).sort()).toEqual([
      "src/checkout.ts:15:applyTax",
      "src/checkout.ts:33:helper",
      "src/report.ts:5:report",
    ]);
    expect(g.calleesOf("applyTax")).toEqual(["calculateTotal"]);
    expect(g.calleesOf("report").sort()).toEqual(["calculateTotal", "formatPrice"]);
    expect(g.filesDeclaring("report")).toEqual(["src/report.ts"]);
    expect(g.symbolAt("src/checkout.ts", 16)?.name).toBe("applyTax");
    expect(g.symbolAt("src/checkout.ts", 2)).toBeNull();
    expect(g.files().sort()).toEqual(["src/checkout.ts", "src/report.ts"]);

    // partial update keeps other files; unchanged content is not re-analyzed (same object)
    const before = g.symbolsOf("src/checkout.ts");
    g.update({ "src/report.ts": REPORT_TS.replace("report(", "summary(") });
    expect(g.symbolsOf("src/checkout.ts")).toBe(before);
    expect(g.callersOf("calculateTotal").find((c) => c.file === "src/report.ts")?.caller).toBe("summary");
  });
});
