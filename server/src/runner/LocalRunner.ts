import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CmdResult, Runner, TestResult } from "@hive/shared";
import { brokenRun, findRepoRoot, parseVitestJson, runId, truncate, vitestArgs } from "./util.js";

export interface LocalRunnerOptions {
  /** demo-app folder: package.json / tsconfig.json are taken from here when the given files lack them. */
  templateDir: string;
  /** Default timeout for test runs, seconds. */
  testTimeoutSec?: number;
  /** Max concurrent vitest processes (vitest itself is parallel; keep this low). */
  maxParallel?: number;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Runs tests and commands in a temp dir under `<repoRoot>/.hive/runs/<id>/`.
 * The dir lives inside the repo so Node resolves `vitest` from the hoisted root node_modules.
 */
export class LocalRunner implements Runner {
  readonly repoRoot: string;
  readonly runsDir: string;
  private readonly templateDir: string;
  private readonly testTimeoutSec: number;
  private readonly vitestBin: string;

  constructor(opts: LocalRunnerOptions) {
    this.repoRoot = findRepoRoot();
    this.runsDir = join(this.repoRoot, ".hive", "runs");
    this.templateDir = isAbsolute(opts.templateDir) ? opts.templateDir : resolve(this.repoRoot, opts.templateDir);
    this.testTimeoutSec = opts.testTimeoutSec ?? 120;
    this.vitestBin = join(this.repoRoot, "node_modules", ".bin", "vitest");
  }

  async runTests(files: Record<string, string>, opts: { filter?: string; timeoutSec?: number } = {}): Promise<TestResult> {
    const dir = await this.materialize(files);
    const started = Date.now();
    try {
      const outputFile = join(dir, "r.json");
      const res = await this.spawn(this.vitestBin, vitestArgs(dir, outputFile, opts.filter), dir, (opts.timeoutSec ?? this.testTimeoutSec) * 1000);
      if (res.timedOut) return brokenRun(`vitest timed out after ${opts.timeoutSec ?? this.testTimeoutSec}s`, res.durationMs, res.stderr);
      if (!existsSync(outputFile)) {
        return brokenRun(`vitest produced no report (exit ${res.exitCode})`, res.durationMs, `${res.stderr}\n${res.stdout}`);
      }
      const json = await readFile(outputFile, "utf8");
      return parseVitestJson(json, res.durationMs, dir);
    } catch (err) {
      return brokenRun(err instanceof Error ? err.message : String(err), Date.now() - started);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async runCommand(files: Record<string, string>, cmd: string, timeoutSec = 60): Promise<CmdResult> {
    const dir = await this.materialize(files);
    try {
      const res = await this.spawn("sh", ["-c", cmd], dir, timeoutSec * 1000);
      return {
        exitCode: res.timedOut ? 124 : res.exitCode,
        stdout: truncate(res.stdout),
        stderr: truncate(res.timedOut ? `${res.stderr}\n[killed: timeout after ${timeoutSec}s]` : res.stderr),
        durationMs: res.durationMs,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Write files into a fresh run dir, filling package.json / tsconfig.json from the template if absent. */
  private async materialize(files: Record<string, string>): Promise<string> {
    const dir = join(this.runsDir, runId());
    await mkdir(dir, { recursive: true });
    const all: Record<string, string> = { ...files };
    for (const name of ["package.json", "tsconfig.json"]) {
      if (all[name] === undefined) {
        const candidate = join(this.templateDir, name);
        if (existsSync(candidate)) all[name] = await readFile(candidate, "utf8");
      }
    }
    await Promise.all(
      Object.entries(all).map(async ([path, content]) => {
        if (path.includes("..") || isAbsolute(path)) throw new Error(`refusing to write outside run dir: ${path}`);
        const target = join(dir, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }),
    );
    return dir;
  }

  private spawn(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<SpawnResult> {
    return new Promise((resolvePromise) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      // detached so the timeout can kill the whole process group (vitest spawns workers)
      const child = spawn(bin, args, { cwd, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < 200_000) stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < 200_000) stderr += d.toString();
      });
      child.on("error", (err) => {
        stderr += `\n${err.message}`;
        finish(127);
      });
      child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
    });
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
