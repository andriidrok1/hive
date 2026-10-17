import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestResult } from "@hive/shared";

export const OUTPUT_LIMIT = 8000;

export function truncate(s: string | null | undefined, limit = OUTPUT_LIMIT): string {
  const text = s ?? "";
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Walk up from this file to the folder whose package.json has `workspaces`. */
export function findRepoRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (;;) {
    const pkg = resolve(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown };
        if (json.workspaces) return dir;
      } catch {
        // not the one we want
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("hive repo root (package.json with workspaces) not found");
    dir = parent;
  }
}

let counter = 0;
export function runId(prefix = "run"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${process.pid.toString(36)}-${counter.toString(36)}`;
}

/** Simple counting semaphore for bounded parallelism. */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) throw new Error("Semaphore max must be >= 1");
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((res) => this.queue.push(res));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/** Build the vitest CLI args for a run rooted at `dir` writing JSON to `outputFile` (absolute). */
export function vitestArgs(dir: string, outputFile: string, filter?: string): string[] {
  const args = ["run", "--root", dir, "--reporter=json", `--outputFile=${outputFile}`, "--passWithNoTests"];
  if (filter) args.push("-t", filter);
  return args;
}

interface VitestAssertion {
  fullName?: string;
  title?: string;
  status?: string;
  failureMessages?: string[];
}
interface VitestFileResult {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: VitestAssertion[];
}
interface VitestJson {
  success?: boolean;
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: VitestFileResult[];
}

/** Parse the vitest JSON reporter output into a TestResult. */
export function parseVitestJson(json: string, durationMs: number, root?: string): TestResult {
  const data = JSON.parse(json) as VitestJson;
  const failures: { name: string; message: string }[] = [];
  let passed = 0;
  let failed = 0;
  for (const file of data.testResults ?? []) {
    const fileName = root && file.name?.startsWith(root) ? file.name.slice(root.length).replace(/^\/+/, "") : (file.name ?? "");
    const assertions = file.assertionResults ?? [];
    for (const a of assertions) {
      if (a.status === "passed") passed += 1;
      else if (a.status === "failed") {
        failed += 1;
        failures.push({
          name: a.fullName ?? a.title ?? fileName,
          message: truncate((a.failureMessages ?? []).join("\n"), 2000),
        });
      }
    }
    if (file.status === "failed" && !assertions.some((a) => a.status === "failed")) {
      // collection or import error: the whole file failed without individual assertions
      failed += 1;
      failures.push({ name: fileName, message: truncate(file.message ?? "test file failed to run", 2000) });
    }
  }
  const ok = (data.success ?? failed === 0) && failed === 0;
  return { ok, passed, failed, failures, durationMs };
}

/** Result when vitest produced no JSON at all (crash, timeout, missing binary). */
export function brokenRun(reason: string, durationMs: number, details?: string): TestResult {
  return {
    ok: false,
    passed: 0,
    failed: 1,
    failures: [{ name: "vitest", message: truncate(`${reason}${details ? `\n${details}` : ""}`, 2000) }],
    durationMs,
  };
}
