import type { CulpritVariant, Runner, TestResult } from "@hive/shared";
import { describe, expect, it } from "vitest";
import { CulpritFinder, groupByAgent, shortName } from "../../src/runner/CulpritFinder.js";
import { LocalRunner } from "../../src/runner/LocalRunner.js";
import { applyAll, breakDiscount, dependentPair, greenSnapshot, harmlessFormatChange, splitCodeAndTests, taxInCalculateTotal, taxLineInOrderSummary } from "./fixtures/changeSets.js";
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
    expect(labels).toEqual(["all-andrii", "all-masha", "green+andrii", "green+masha"]);
    expect(seen.map((v) => v.label).sort()).toEqual(labels);
    const byLabel = Object.fromEntries(report.variants.map((v) => [v.label, v.ok]));
    expect(byLabel).toEqual({ "green+andrii": true, "green+masha": false, "all-andrii": false, "all-masha": true });
    expect(report.variants.find((v) => v.label === "green+masha")?.applied).toEqual(["B1"]);
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
    expect(labels).toContain("green+andrii+masha");
    expect(report.variants.find((v) => v.label === "green+andrii+masha")?.ok).toBe(false);
    expect(report.variants.find((v) => v.label === "green+andrii+masha")?.applied).toEqual(["A2", "B2"]);
  }, 180_000);

  it("7. dependent: a patch that only applies after another -> dependent", async () => {
    const { d1, d2 } = dependentPair();
    const seen: CulpritVariant[] = [];
    const { runner } = fakeRunner((files) => !files["src/format.ts"]?.includes("Math.round(cents / 100)"));
    const report = await new CulpritFinder(runner).find(greenSnapshot(), [d1, d2], (v) => seen.push(v));
    expect(report.kind).toBe("dependent");
    expect(report.culprits).toEqual(["A3", "B3"]);
    const aloneB3 = report.variants.find((v) => v.label === "green+masha");
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
    expect(report.variants.map((v) => v.label).sort()).toEqual(["all-masha", "green+masha"]); // a 1-intent group is not narrowed further
  });

  it("respects maxParallel and caps suspects at the last 6", async () => {
    // edit-less change sets always apply, so every variant actually runs; alternating agents -> one group per set
    const sets = Array.from({ length: 8 }, (_, i) => ({ ...harmlessFormatChange(), id: `X${i}`, edits: [], agentId: i % 2 ? "agent-masha" : "agent-andrii", humanId: i % 2 ? "masha" : "andrii" }));
    const { runner, calls, maxActive } = fakeRunner(() => true, 20);
    const report = await new CulpritFinder(runner, 3).find(greenSnapshot(), sets);
    expect(maxActive()).toBeLessThanOrEqual(3);
    // 6 suspects -> 6 groups -> 12 group variants; all green and groups > 4 -> no pairs -> unknown
    expect(calls.length).toBe(12);
    expect(report.variants.map((v) => v.label).filter((l) => l.startsWith("green+")).sort()).toEqual(["green+andrii", "green+andrii-2", "green+andrii-3", "green+masha", "green+masha-2", "green+masha-3"]);
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
    // P1 and P2 belong to andrii -> one group; the pair is between the two agents' groups
    expect(report.kind).toBe("pair");
    expect(report.culprits).toEqual(["P1", "P2", "P3"]);
    expect(calls.length).toBe(4 + 1);
    expect(report.variants.map((v) => v.label)).toContain("green+andrii+masha");
  });

  describe("groups", () => {
    it("groupByAgent joins consecutive intents of one agent and keeps labels unique", () => {
      const a1 = { ...harmlessFormatChange(), id: "A1" };
      const a2 = { ...harmlessFormatChange(), id: "A2" };
      const b1 = { ...breakDiscount(), id: "B1" };
      const a3 = { ...harmlessFormatChange(), id: "A3" };
      const groups = groupByAgent([a1, a2, b1, a3]);
      expect(groups.map((g) => [g.label, g.ids])).toEqual([
        ["andrii", ["A1", "A2"]],
        ["masha", ["B1"]],
        ["andrii-2", ["A3"]],
      ]);
      expect(shortName({ agentId: "agent-Zoë Q", humanId: "" })).toBe("zo-q");
      expect(shortName({ agentId: "agent-x", humanId: "Ivan Petrov" })).toBe("ivan-petrov");
    });

    it("one agent, code in A1 and its tests in A2: each alone red, together still red -> single [A1, A2] (fake runner)", async () => {
      const { code, tests } = splitCodeAndTests(taxInCalculateTotal());
      // drop the last test update so the group together is still red (one expectation left stale)
      const partialTests = { ...tests, edits: tests.edits.slice(0, -1) };
      const { runner, calls } = fakeRunner((files) => files["src/checkout.ts"] === DEMO_APP_FILES["src/checkout.ts"] && files["test/checkout.test.ts"] === DEMO_APP_FILES["test/checkout.test.ts"]);
      const seen: CulpritVariant[] = [];
      const report = await new CulpritFinder(runner).find(greenSnapshot(), [code, partialTests], (v) => seen.push(v));
      expect(report.kind).toBe("single");
      expect(report.culprits).toEqual(["A1", "A2"]);
      // group variants first, then per-intent variants inside the single group
      expect(seen.slice(0, 2).map((v) => v.label).sort()).toEqual(["all-andrii", "green+andrii"]);
      expect(seen.slice(2).map((v) => v.label).sort()).toEqual(["all-A1", "all-A2", "green+A1", "green+A2"]);
      expect(calls.length).toBe(6);
    });

    it("one agent, A1 code + A2 tests on the real LocalRunner: group is the culprit, not unknown", async () => {
      const { code, tests } = splitCodeAndTests(taxInCalculateTotal());
      const partialTests = { ...tests, edits: tests.edits.slice(0, -1) };
      // sanity: each alone red, together red
      expect((await local.runTests(applyAll(DEMO_APP_FILES, [code]))).ok).toBe(false);
      expect((await local.runTests(applyAll(DEMO_APP_FILES, [partialTests]))).ok).toBe(false);
      expect((await local.runTests(applyAll(DEMO_APP_FILES, [code, partialTests]))).ok).toBe(false);
      const report = await new CulpritFinder(local, 6).find(greenSnapshot(), [code, partialTests]);
      expect(report.kind).toBe("single");
      expect(report.culprits).toEqual(["A1", "A2"]);
    }, 180_000);

    it("one agent whose A2 alone explains the failure is narrowed to [A2]", async () => {
      const a1 = { ...harmlessFormatChange(), id: "A1" };
      const a2 = { ...breakDiscount(), id: "A2", agentId: "agent-andrii", humanId: "andrii" };
      const { runner } = fakeRunner((files) => !files["src/discount.ts"]!.includes("Math.floor"));
      const report = await new CulpritFinder(runner).find(greenSnapshot(), [a1, a2]);
      expect(report.kind).toBe("single");
      expect(report.culprits).toEqual(["A2"]);
    });

    it("pair between two agents' groups: andrii A1 code + A2 tests (green together) and masha B1 -> pair [A1, A2, B1]", async () => {
      const { code, tests } = splitCodeAndTests(taxInCalculateTotal());
      const b1 = taxLineInOrderSummary();
      const { runner, calls } = fakeRunner((files) => !(files["src/checkout.ts"]!.includes("applyTax") && files["src/order.ts"]!.includes("applyTax")));
      const report = await new CulpritFinder(runner).find(greenSnapshot(), [code, tests, b1]);
      expect(report.kind).toBe("pair");
      expect(report.culprits).toEqual(["A1", "A2", "B2"]);
      expect(report.variants.map((v) => v.label).sort()).toEqual(["all-andrii", "all-masha", "green+andrii", "green+andrii+masha", "green+masha"]);
      expect(calls.length).toBe(5);
    });

    it("pair between groups on the real LocalRunner", async () => {
      const { code, tests } = splitCodeAndTests(taxInCalculateTotal());
      const b1 = taxLineInOrderSummary();
      expect((await local.runTests(applyAll(DEMO_APP_FILES, [code, tests]))).failures).toEqual([]);
      const report = await new CulpritFinder(local, 6).find(greenSnapshot(), [code, tests, b1]);
      expect(report.kind).toBe("pair");
      expect(report.culprits).toEqual(["A1", "A2", "B2"]);
    }, 180_000);
  });
});
