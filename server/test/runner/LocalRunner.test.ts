import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalRunner } from "../../src/runner/LocalRunner.js";
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
    expect(r.failures[0]!.message.length).toBeGreaterThan(0);
  }, 60_000);

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
