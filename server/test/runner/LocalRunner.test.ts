import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalRunner } from "../../src/runner/LocalRunner.js";
import { failureMessage } from "../../src/runner/util.js";
import { DEMO_APP_FILES, demoAppFiles } from "./fixtures/demoApp.js";

const runner = new LocalRunner({ templateDir: "demo-app" });

describe("LocalRunner", () => {
  it("1. green demo files -> ok true, failed 0", async () => {
    const r = await runner.runTests(DEMO_APP_FILES);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.failed).toBe(0);
    expect(r.passed).toBeGreaterThanOrEqual(16);
    expect(r.durationMs).toBeGreaterThan(0);
    expect(existsSync(join(runner.runsDir))).toBe(true);
  }, 60_000);

  it("2. broken calculateTotal -> ok false with failure names", async () => {
    const broken = DEMO_APP_FILES["src/checkout.ts"]!.replace("return applyDiscount(subtotal(items), promo);", "return applyDiscount(subtotal(items), promo) + 1;");
    const r = await runner.runTests(demoAppFiles({ "src/checkout.ts": broken }));
    expect(r.ok).toBe(false);
    expect(r.failed).toBeGreaterThan(0);
    expect(r.passed).toBeGreaterThan(0);
    const names = r.failures.map((f) => f.name);
    expect(names.some((n) => n.includes("calculateTotal"))).toBe(true);
    expect(names.every((n) => n.startsWith("test/checkout.test.ts: "))).toBe(true);
    for (const f of r.failures) {
      // one meaningful line, no stack frames, bounded
      expect(f.message).toMatch(/^AssertionError: expected \d+ to be \d+/);
      expect(f.message).not.toContain("\n");
      expect(f.message).not.toMatch(/\bat /);
      expect(f.message.length).toBeLessThanOrEqual(300);
    }
  }, 60_000);

  it("failureMessage keeps the first meaningful line only", () => {
    expect(failureMessage("AssertionError: expected 9000 to be 9653 // Object.is equality\n\n- Expected\n+ Received\n\n- 9653\n+ 9000\n\n ❯ test/checkout.test.ts:22:70\n    at foo (x.ts:1:1)")).toBe("AssertionError: expected 9000 to be 9653 // Object.is equality");
    expect(failureMessage("\n   at a (b.ts:1:1)\n  ReferenceError:   items is   not defined\n    at c")).toBe("ReferenceError: items is not defined");
    expect(failureMessage("", "test file failed to run")).toBe("test file failed to run");
    expect(failureMessage("x".repeat(500)).length).toBe(300);
  });

  it("2b. filter runs only matching tests", async () => {
    const r = await runner.runTests(DEMO_APP_FILES, { filter: "formatPrice" });
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(2);
  }, 60_000);

  it("2c. a file that fails to import is reported as a failure", async () => {
    const r = await runner.runTests(demoAppFiles({ "src/format.ts": "export const nope = 1;\n" }));
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  }, 60_000);

  it("3. runCommand prints 1", async () => {
    const r = await runner.runCommand(DEMO_APP_FILES, "node -e 'console.log(1)'");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("1");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("3b. runCommand truncates output to 8000 chars and reports exit codes", async () => {
    const r = await runner.runCommand({}, "node -e 'process.stdout.write(\"x\".repeat(20000)); process.exit(3)'");
    expect(r.exitCode).toBe(3);
    expect(r.stdout.length).toBe(8000);
  }, 30_000);

  it("4. timeout kills a hanging command", async () => {
    const started = Date.now();
    const r = await runner.runCommand({}, "sleep 30; echo late", 1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("late");
    expect(r.stderr).toContain("timeout");
  }, 30_000);
});
