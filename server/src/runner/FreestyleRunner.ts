import { Freestyle, type Vm } from "freestyle";
import type { CmdResult, Runner, TestResult } from "@hive/shared";
import { brokenRun, parseVitestJson, runId, Semaphore, truncate } from "./util.js";

/** Where the prepared project lives inside the base snapshot (see prepare.ts). */
export const DEFAULT_PROJECT_DIR = "/home/ubuntu/hive-app";
/** Freestyle caps a single exec at 5 minutes. */
const MAX_EXEC_MS = 300_000;

export interface FreestyleRunnerOptions {
  apiKey: string;
  baseSnapshotId: string;
  maxParallel?: number;
  projectDir?: string;
  testTimeoutSec?: number;
  /** Idle timeout for test VMs (seconds); short, they live for one run. */
  idleTimeoutSeconds?: number;
  log?: (msg: string) => void;
}

export interface VmTimings {
  vmId: string;
  createMs: number;
  writeMs: number;
  execMs: number;
  deleteMs: number;
  totalMs: number;
  files: number;
}

/**
 * Runs tests/commands in a fresh Freestyle VM created from the prepared base snapshot
 * (node_modules already installed). One VM per call, always deleted in `finally`.
 */
export class FreestyleRunner implements Runner {
  readonly timings: VmTimings[] = [];
  private readonly client: Freestyle;
  private readonly sem: Semaphore;
  private readonly projectDir: string;
  private readonly baseSnapshotId: string;
  private readonly testTimeoutSec: number;
  private readonly idleTimeoutSeconds: number;
  private readonly log: (msg: string) => void;

  constructor(opts: FreestyleRunnerOptions) {
    if (!opts.apiKey) throw new Error("FreestyleRunner needs an apiKey");
    if (!opts.baseSnapshotId) throw new Error("FreestyleRunner needs a baseSnapshotId (run `npm run runner:prepare -w @hive/server`)");
    this.client = new Freestyle({ apiKey: opts.apiKey });
    this.sem = new Semaphore(opts.maxParallel ?? 8);
    this.projectDir = opts.projectDir ?? DEFAULT_PROJECT_DIR;
    this.baseSnapshotId = opts.baseSnapshotId;
    this.testTimeoutSec = opts.testTimeoutSec ?? 180;
    this.idleTimeoutSeconds = opts.idleTimeoutSeconds ?? 300;
    this.log = opts.log ?? (() => undefined);
  }

  async runTests(files: Record<string, string>, opts: { filter?: string; timeoutSec?: number } = {}): Promise<TestResult> {
    const timeoutMs = Math.min((opts.timeoutSec ?? this.testTimeoutSec) * 1000, MAX_EXEC_MS);
    return this.sem.run(() =>
      this.withVm(files, async (vm, t) => {
        const started = Date.now();
        const reportPath = `${this.projectDir}/r.json`;
        const filter = opts.filter ? ` -t ${shellQuote(opts.filter)}` : "";
        const command = `cd ${this.projectDir} && rm -f r.json && npx vitest run --reporter=json --outputFile=${reportPath} --passWithNoTests${filter}`;
        const res = await vm.exec({ command, timeoutMs });
        const durationMs = Date.now() - started;
        t.execMs = durationMs;
        if (res.statusCode === null || res.statusCode === undefined) {
          return { ...brokenRun(`vitest timed out after ${timeoutMs / 1000}s`, durationMs, res.stderr ?? ""), vmId: vm.id };
        }
        let json: string;
        try {
          json = await vm.fs.readTextFile(reportPath);
        } catch {
          return { ...brokenRun(`vitest produced no report (exit ${res.statusCode})`, durationMs, `${res.stderr ?? ""}\n${res.stdout ?? ""}`), vmId: vm.id };
        }
        return { ...parseVitestJson(json, durationMs, this.projectDir), vmId: vm.id };
      }),
    );
  }

  async runCommand(files: Record<string, string>, cmd: string, timeoutSec = 60): Promise<CmdResult> {
    const timeoutMs = Math.min(timeoutSec * 1000, MAX_EXEC_MS);
    return this.sem.run(() =>
      this.withVm(files, async (vm, t) => {
        const started = Date.now();
        const res = await vm.exec({ command: `cd ${this.projectDir} && ${cmd}`, timeoutMs });
        const durationMs = Date.now() - started;
        t.execMs = durationMs;
        const timedOut = res.statusCode === null || res.statusCode === undefined;
        return {
          exitCode: timedOut ? 124 : res.statusCode,
          stdout: truncate(res.stdout),
          stderr: truncate(timedOut ? `${res.stderr ?? ""}\n[killed: timeout after ${timeoutMs / 1000}s]` : res.stderr),
          durationMs,
          vmId: vm.id,
        };
      }),
    );
  }

  /** Create a VM from the base snapshot (one retry), write the files, run `fn`, always delete the VM. */
  private async withVm<T>(files: Record<string, string>, fn: (vm: Vm, t: VmTimings) => Promise<T>): Promise<T> {
    const total = Date.now();
    const t: VmTimings = { vmId: "", createMs: 0, writeMs: 0, execMs: 0, deleteMs: 0, totalMs: 0, files: Object.keys(files).length };
    const vm = await this.createVm(t);
    try {
      const w = Date.now();
      await this.writeFiles(vm, files);
      t.writeMs = Date.now() - w;
      return await fn(vm, t);
    } finally {
      const d = Date.now();
      try {
        await vm.delete();
      } catch (err) {
        this.log(`vm ${vm.id}: delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      t.deleteMs = Date.now() - d;
      t.totalMs = Date.now() - total;
      this.timings.push(t);
      this.log(`vm ${t.vmId}: create ${t.createMs}ms, write ${t.files} files ${t.writeMs}ms, exec ${t.execMs}ms, delete ${t.deleteMs}ms, total ${t.totalMs}ms`);
    }
  }

  private async createVm(t: VmTimings): Promise<Vm> {
    const started = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { vm, vmId } = await this.client.vms.create({
          snapshotId: this.baseSnapshotId,
          firewall: { rules: [] }, // no network: tests do not need it
          idleTimeoutSeconds: this.idleTimeoutSeconds,
          ttlSeconds: 1800, // safety net if delete never runs
          autoDeleteSeconds: 0,
          displayName: runId("hive-test"),
          metadata: { hive: "test-vm" },
        });
        t.vmId = vmId;
        t.createMs = Date.now() - started;
        return vm;
      } catch (err) {
        lastErr = err;
        this.log(`vm create attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Replace the project's top-level dirs named in `files` and write every file via the SDK file API. */
  private async writeFiles(vm: Vm, files: Record<string, string>): Promise<void> {
    const paths = Object.keys(files);
    if (paths.length === 0) return;
    for (const p of paths) {
      if (p.startsWith("/") || p.split("/").includes("..")) throw new Error(`refusing to write outside project dir: ${p}`);
    }
    const topDirs = [...new Set(paths.filter((p) => p.includes("/")).map((p) => p.split("/")[0]!))];
    const allDirs = [...new Set(paths.filter((p) => p.includes("/")).map((p) => p.slice(0, p.lastIndexOf("/"))))];
    const mk = [...topDirs.map((d) => `rm -rf ${shellQuote(`${this.projectDir}/${d}`)}`), ...allDirs.map((d) => `mkdir -p ${shellQuote(`${this.projectDir}/${d}`)}`)];
    if (mk.length > 0) {
      const res = await vm.exec({ command: mk.join(" && "), timeoutMs: 30_000 });
      if (res.statusCode !== 0) throw new Error(`preparing dirs failed: ${res.stderr ?? ""}`);
    }
    await Promise.all(paths.map((p) => vm.fs.writeFile(`${this.projectDir}/${p}`, files[p]!)));
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
