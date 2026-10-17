import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { TestResult } from "@hive/shared";
import { demoAppDir, vitestBin } from "./paths.js";

/** Reads the demo app the way the server loads it: package.json, tsconfig.json, src/**, test/**. */
export function readProjectFiles(dir = demoAppDir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const top of ["package.json", "tsconfig.json"]) out[top] = readFileSync(join(dir, top), "utf8");
  const walk = (sub: string) => {
    const abs = join(dir, sub);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      const p = join(abs, e);
      if (statSync(p).isDirectory()) walk(join(sub, e));
      else out[relative(dir, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  walk("src");
  walk("test");
  return out;
}

export function writeProjectFiles(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function resetDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

interface VitestJson {
  success: boolean;
  numPassedTests: number;
  numFailedTests: number;
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { fullName: string; status: string; failureMessages: string[] }[];
  }[];
}

/** Runs the demo-app suite in `dir` with the root vitest and parses the JSON reporter into a TestResult. */
export async function runVitest(dir: string, filter?: string): Promise<TestResult> {
  const started = Date.now();
  const outFile = join(dir, ".vitest-result.json");
  rmSync(outFile, { force: true });
  const args = ["run", "--root", dir, "--reporter=json", `--outputFile=${outFile}`];
  if (filter) args.push("-t", filter);
  const res = await exec(vitestBin, args, dir);
  let json: VitestJson | undefined;
  try {
    json = JSON.parse(readFileSync(outFile, "utf8")) as VitestJson;
  } catch {
    json = undefined;
  }
  const durationMs = Date.now() - started;
  if (!json) {
    return {
      ok: false,
      passed: 0,
      failed: 1,
      failures: [{ name: "vitest", message: (res.stderr || res.stdout).slice(0, 2000) || `exit ${res.code}` }],
      durationMs,
    };
  }
  const failures: { name: string; message: string }[] = [];
  for (const file of json.testResults) {
    const rel = relative(dir, file.name).split("\\").join("/");
    let any = false;
    for (const a of file.assertionResults) {
      if (a.status === "failed") {
        any = true;
        failures.push({ name: `${rel} > ${a.fullName}`, message: a.failureMessages.join("\n").slice(0, 2000) });
      }
    }
    if (!any && file.status === "failed") failures.push({ name: rel, message: (file.message ?? "file failed").slice(0, 2000) });
  }
  const failed = Math.max(json.numFailedTests, failures.length);
  return { ok: json.success && failed === 0, passed: json.numPassedTests, failed, failures, durationMs };
}
