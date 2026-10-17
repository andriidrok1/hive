// E2E against Freestyle. Runs only with HIVE_E2E=1 and FREESTYLE_API_KEY (loaded from <repoRoot>/.env).
// Every VM is created with metadata hive=test-vm|prepare and deleted in finally; afterAll sweeps leftovers.
import { config as loadDotenv } from "dotenv";
import { Freestyle } from "freestyle";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CulpritFinder } from "../../src/runner/CulpritFinder.js";
import { FreestyleRunner } from "../../src/runner/FreestyleRunner.js";
import { baseSnapshotPath, prepareBaseSnapshot, type BaseSnapshotRecord, type PrepareTimings } from "../../src/runner/prepare.js";
import { findRepoRoot } from "../../src/runner/util.js";
import { applyAll, breakDiscount, greenSnapshot, harmlessFormatChange, taxInCalculateTotal } from "./fixtures/changeSets.js";
import { DEMO_APP_FILES } from "./fixtures/demoApp.js";

const repoRoot = findRepoRoot();
loadDotenv({ path: join(repoRoot, ".env"), quiet: true });
const apiKey = process.env.FREESTYLE_API_KEY ?? "";
const E2E = process.env.HIVE_E2E === "1" && apiKey.length > 0;

const log = (msg: string) => console.log(`[e2e] ${msg}`);

describe.skipIf(!E2E)("Freestyle E2E", () => {
  let snapshotId = "";
  let prepareTimings: PrepareTimings | undefined;

  afterAll(async () => {
    if (!E2E) return;
    const client = new Freestyle({ apiKey });
    const { vms } = await client.vms.list({ limit: 100 });
    const mine = vms.filter((v) => v.metadata?.hive === "test-vm" || v.metadata?.hive === "prepare");
    for (const v of mine) {
      log(`sweeping leftover VM ${v.id} (${v.metadata.hive})`);
      await client.vms.delete(v.id).catch((err: unknown) => log(`delete ${v.id} failed: ${String(err)}`));
    }
    expect(mine.length).toBe(0);
  }, 120_000);

  it("10. prepare creates a snapshot and FreestyleRunner runs the green suite from it", async () => {
    // reuse an existing base snapshot when HIVE_REUSE_SNAPSHOT=1 (saves ~1 min)
    if (process.env.HIVE_REUSE_SNAPSHOT === "1" && existsSync(baseSnapshotPath(repoRoot))) {
      const record = JSON.parse(await readFile(baseSnapshotPath(repoRoot), "utf8")) as BaseSnapshotRecord;
      snapshotId = record.snapshotId;
      log(`reusing base snapshot ${snapshotId}`);
    } else {
      snapshotId = await prepareBaseSnapshot({ apiKey, files: DEMO_APP_FILES, log, onTimings: (t) => (prepareTimings = t) });
      expect(snapshotId).toMatch(/^sh-|^[a-z0-9-]+$/i);
      expect(prepareTimings).toBeDefined();
      log(`prepare timings: ${JSON.stringify(prepareTimings)}`);
    }
    const record = JSON.parse(await readFile(baseSnapshotPath(repoRoot), "utf8")) as BaseSnapshotRecord;
    expect(record.snapshotId).toBe(snapshotId);

    const runner = new FreestyleRunner({ apiKey, baseSnapshotId: snapshotId, log });
    const started = Date.now();
    const r = await runner.runTests(DEMO_APP_FILES);
    log(`green suite on Freestyle: ${Date.now() - started}ms wall, result ${JSON.stringify({ ok: r.ok, passed: r.passed, failed: r.failed, durationMs: r.durationMs, vmId: r.vmId })}`);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.passed).toBeGreaterThanOrEqual(16);
    expect(r.vmId).toBeTruthy();
    const t = runner.timings[0]!;
    log(`VM create ${t.createMs}ms, file write ${t.writeMs}ms (${t.files} files), vitest ${t.execMs}ms, delete ${t.deleteMs}ms`);

    // the VM is gone
    const client = new Freestyle({ apiKey });
    await expect(client.vms.get(r.vmId!)).rejects.toThrow();

    // a red run is reported as red
    const red = await runner.runTests(applyAll(DEMO_APP_FILES, [breakDiscount()]));
    expect(red.ok).toBe(false);
    expect(red.failures.some((f) => f.name.includes("Discount") || f.name.includes("calculateTotal"))).toBe(true);

    const cmd = await runner.runCommand(DEMO_APP_FILES, "node -e 'console.log(1+1)'", 30);
    expect(cmd.exitCode).toBe(0);
    expect(cmd.stdout.trim()).toBe("2");
  }, 600_000);

  it("11. six variants in parallel on Freestyle finish; wall time logged", async () => {
    expect(snapshotId).toBeTruthy();
    const runner = new FreestyleRunner({ apiKey, baseSnapshotId: snapshotId, maxParallel: 8, log });
    const sets = [harmlessFormatChange(), breakDiscount(), taxInCalculateTotal()]; // n=3 -> 6 single variants
    const started = Date.now();
    const seen: string[] = [];
    const report = await new CulpritFinder(runner, 8).find(greenSnapshot(), sets, (v) => seen.push(`${v.label}=${v.ok}`));
    const wall = Date.now() - started;
    log(`6 variants wall time: ${wall}ms; variants: ${seen.join(", ")}`);
    const per = runner.timings.map((t) => `${t.vmId}: create ${t.createMs} write ${t.writeMs} exec ${t.execMs} delete ${t.deleteMs} total ${t.totalMs}`);
    log(`per-VM timings:\n${per.join("\n")}`);
    expect(report.variants.length).toBe(6);
    expect(report.kind).toBe("single");
    expect(report.culprits).toEqual(["B1"]);
    const maxTotal = Math.max(...runner.timings.map((t) => t.totalMs));
    // parallel: the wall time is close to the slowest VM, not the sum
    expect(wall).toBeLessThan(runner.timings.reduce((a, t) => a + t.totalMs, 0));
    log(`slowest VM ${maxTotal}ms vs wall ${wall}ms`);
  }, 600_000);
});
