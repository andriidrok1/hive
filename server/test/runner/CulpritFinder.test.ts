import type { CulpritVariant, Runner, TestResult } from "@hive/shared";
import { describe, expect, it } from "vitest";
import { CulpritFinder } from "../../src/runner/CulpritFinder.js";
import { LocalRunner } from "../../src/runner/LocalRunner.js";
import { applyAll, breakDiscount, dependentPair, greenSnapshot, harmlessFormatChange, taxInCalculateTotal, taxLineInOrderSummary } from "./fixtures/changeSets.js";
import { DEMO_APP_FILES } from "./fixtures/demoApp.js";

const local = new LocalRunner({ templateDir: "demo-app" });

/** Runner that decides green/red from a predicate over the files; counts calls and concurrency. */
function fakeRunner(isGreen: (files: Record<string, string>) => boolean, delayMs = 5) {
  let active = 0;
  let maxActive = 0;
  const calls: Record<string, string>[] = [];
  const runner: Runner = {
    async runTests(files) {
      calls.push(files);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delayMs));
      active -= 1;
      const ok = isGreen(files);
      const res: TestResult = { ok, passed: ok ? 10 : 9, failed: ok ? 0 : 1, failures: ok ? [] : [{ name: "t", message: "boom" }], durationMs: delayMs };
      return res;
    },
    async runCommand() {
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    },
  };
  return { runner, calls, maxActive: () => maxActive };
}

describe("CulpritFinder", () => {
  it("5. single: harmless S1 + discount-breaking S2 -> single [S2] (real LocalRunner)", async () => {
    const s1 = harmlessFormatChange();
    const s2 = breakDiscount();
    const seen: CulpritVariant[] = [];
    const report = await new CulpritFinder(local, 4).find(greenSnapshot(), [s1, s2], (v) => seen.push(v));
    expect(report.kind).toBe("single");
    expect(report.culprits).toEqual(["B1"]);
    expect(report.greenRev).toBe(0);
    const labels = report.variants.map((v) => v.label).sort();
    expect(labels).toEqual(["all-A1", "all-B1", "green+A1", "green+B1"]);
    expect(seen.map((v) => v.label).sort()).toEqual(labels);
    const byLabel = Object.fromEntries(report.variants.map((v) => [v.label, v.ok]));
    expect(byLabel).toEqual({ "green+A1": true, "green+B1": false, "all-A1": false, "all-B1": true });
    expect(report.durationMs).toBeGreaterThan(0);
  }, 120_000);

  it("6. pair: tax in calculateTotal + tax line in orderSummary -> pair [S1, S2] (real LocalRunner)", async () => {
    const s1 = taxInCalculateTotal();
    const s2 = taxLineInOrderSummary();
    // preconditions: each alone is green, together red
    const alone1 = await local.runTests(applyAll(DEMO_APP_FILES, [s1]));
    const alone2 = await local.runTests(applyAll(DEMO_APP_FILES, [s2]));
    const both = await local.runTests(applyAll(DEMO_APP_FILES, [s1, s2]));
    expect(alone1.failures).toEqual([]);
    expect(alone2.failures).toEqual([]);
    expect(both.ok).toBe(false);

    const report = await new CulpritFinder(local, 4).find(greenSnapshot(), [s1, s2]);
    expect(report.kind).toBe("pair");
    expect(report.culprits).toEqual(["A2", "B2"]);
    const labels = report.variants.map((v) => v.label);
    expect(labels).toContain("green+A2+B2");
    expect(report.variants.find((v) => v.label === "green+A2+B2")?.ok).toBe(false);
  }, 180_000);

  it("7. dependent: a patch that only applies after another -> dependent", async () => {
    const { d1, d2 } = dependentPair();
    const seen: CulpritVariant[] = [];
    const { runner } = fakeRunner((files) => !files["src/format.ts"]?.includes("Math.round(cents / 100)"));
    const report = await new CulpritFinder(runner).find(greenSnapshot(), [d1, d2], (v) => seen.push(v));
    expect(report.kind).toBe("dependent");
    expect(report.culprits).toEqual(["A3", "B3"]);
    const aloneB3 = report.variants.find((v) => v.label === "green+B3");
    expect(aloneB3?.ok).toBe(false);
    expect(aloneB3?.applyError).toMatch(/B3/);
    expect(seen.length).toBe(4);
  });

  it("7b. dependent patch on a real runner: D2 applies after D1 and the result is red", async () => {
    const { d1, d2 } = dependentPair();
    const r = await local.runTests(applyAll(DEMO_APP_FILES, [d1, d2]));
    expect(r.ok).toBe(false);
    expect(() => applyAll(DEMO_APP_FILES, [d2])).toThrow(/B3/);
  }, 60_000);

  it("single with one suspect: all-<id> is the green snapshot itself", async () => {
    const s2 = breakDiscount();
    const { runner } = fakeRunner((files) => files["src/discount.ts"] === DEMO_APP_FILES["src/discount.ts"]);
    const report = await new CulpritFinder(runner).find(greenSnapshot(), [s2]);
    expect(report.kind).toBe("single");
    expect(report.culprits).toEqual(["B1"]);
  });

  it("respects maxParallel and caps suspects at the last 6", async () => {
    // edit-less change sets always apply, so every variant actually runs
    const sets = Array.from({ length: 8 }, (_, i) => ({ ...harmlessFormatChange(), id: `X${i}`, edits: [] }));
    const { runner, calls, maxActive } = fakeRunner(() => true, 20);
    const report = await new CulpritFinder(runner, 3).find(greenSnapshot(), sets);
    expect(maxActive()).toBeLessThanOrEqual(3);
    // 6 suspects -> 12 single variants; all green and n > 4 -> no pairs -> unknown
    expect(calls.length).toBe(12);
    expect(report.kind).toBe("unknown");
    expect(report.culprits).toEqual(["X2", "X3", "X4", "X5", "X6", "X7"]);
  });

  it("empty input -> unknown with no culprits and no runs", async () => {
    const { runner, calls } = fakeRunner(() => true);
    const report = await new CulpritFinder(runner).find(greenSnapshot(), []);
    expect(report).toMatchObject({ kind: "unknown", culprits: [], variants: [] });
    expect(calls.length).toBe(0);
  });

  it("three suspects where every single is green and one pair is red -> that pair", async () => {
    const a = { ...harmlessFormatChange(), id: "P1" };
    const b = { ...taxInCalculateTotal(), id: "P2" };
    const c = { ...taxLineInOrderSummary(), id: "P3" };
    const { runner, calls } = fakeRunner((files) => !(files["src/checkout.ts"]!.includes("applyTax") && files["src/order.ts"]!.includes("applyTax")));
    const report = await new CulpritFinder(runner).find(greenSnapshot(), [a, b, c]);
    expect(report.kind).toBe("pair");
    expect(report.culprits).toEqual(["P2", "P3"]);
    expect(calls.length).toBe(6 + 3);
  });
});
