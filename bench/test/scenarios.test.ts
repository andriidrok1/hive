import { beforeAll, describe, expect, it } from "vitest";
import { checkScenario, describeCheck, patchFiles, type ScenarioCheck } from "../src/reference.js";
import { loadScenarios, referenceFolder } from "../src/scenarios.js";
import { join } from "node:path";

// For every scenario that has bench/reference/<id>/{a,b,combined}.patch:
//   base green; a alone green; b alone green (each suite as modified by that patch);
//   a+b applies cleanly with git apply; with extraTests it fails for conflicts and passes for controls;
//   combined.patch applies and passes with extraTests.
// Scenarios without a reference folder are listed as skipped.

const scenarios = loadScenarios();

for (const scenario of scenarios) {
  const ref = referenceFolder(scenario);
  describe(`${scenario.id} (${scenario.conflict ? "conflict" : "control"})`, () => {
    if (!ref) {
      it.skip("has no reference patches yet", () => {});
      return;
    }
    let check: ScenarioCheck;
    beforeAll(async () => {
      check = await checkScenario(scenario, ref);
    });

    it("a.patch and b.patch touch disjoint files, or at least disjoint hunks (both apply orders work)", () => {
      const a = new Set(patchFiles(join(ref, "a.patch")));
      const shared = patchFiles(join(ref, "b.patch")).filter((f) => a.has(f));
      if (shared.length > 0) {
        expect(check.ba.applied, `shared files ${shared.join(", ")}; ${describeCheck(check.ba)}`).toBe(true);
        expect(check.ba.result?.ok).toBe(check.ab.result?.ok);
      }
    });

    it("base suite is green", () => {
      expect(check.base.result?.ok, describeCheck(check.base)).toBe(true);
    });

    it("a.patch alone applies and keeps its suite green", () => {
      expect(check.a.applied, describeCheck(check.a)).toBe(true);
      expect(check.a.result?.ok, describeCheck(check.a)).toBe(true);
    });

    it("b.patch alone applies and keeps its suite green", () => {
      expect(check.b.applied, describeCheck(check.b)).toBe(true);
      expect(check.b.result?.ok, describeCheck(check.b)).toBe(true);
    });

    it("a.patch then b.patch applies cleanly as text", () => {
      expect(check.ab.applied, describeCheck(check.ab)).toBe(true);
    });

    it(scenario.conflict ? "a+b with extraTests fails" : "a+b with extraTests passes (control)", () => {
      expect(check.ab.result?.ok, describeCheck(check.ab)).toBe(!scenario.conflict);
    });

    it("combined.patch applies and passes with extraTests", () => {
      expect(check.combined.applied, describeCheck(check.combined)).toBe(true);
      expect(check.combined.result?.ok, describeCheck(check.combined)).toBe(true);
      expect(check.combined.result!.passed).toBeGreaterThan(check.base.result!.passed);
    });
  });
}
