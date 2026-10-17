// Builds the Freestyle base snapshot: a VM with the demo app and its node_modules installed.
// Script: `npm run runner:prepare -w @hive/server` (reads FREESTYLE_API_KEY from <repoRoot>/.env).
import { config as loadDotenv } from "dotenv";
import { Freestyle } from "freestyle";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT_DIR } from "./FreestyleRunner.js";
import { findRepoRoot, runId } from "./util.js";

export const BASE_SNAPSHOT_FILE = ".hive/base-snapshot.json";
/** Ubuntu base image: Node LTS and npm preinstalled (docs: /docs/vms/base-snapshots). */
const BASE_IMAGE = "freestyle/ubuntu";

export interface BaseSnapshotRecord {
  snapshotId: string;
  createdAt: string;
  projectDir: string;
  sourceVmId?: string;
  timings?: PrepareTimings;
}

export interface PrepareTimings {
  createMs: number;
  writeMs: number;
  installMs: number;
  testMs: number;
  snapshotMs: number;
  deleteMs: number;
  totalMs: number;
}

export interface PrepareOptions {
  apiKey: string;
  /** Project files (package.json, tsconfig.json, src/**, test/**). */
  files: Record<string, string>;
  projectDir?: string;
  /** Write `<repoRoot>/.hive/base-snapshot.json`. Default true. */
  writeRecord?: boolean;
  log?: (msg: string) => void;
  onTimings?: (t: PrepareTimings) => void;
}

/** Create the base snapshot and return its id. The VM is deleted in `finally`. */
export async function prepareBaseSnapshot(opts: PrepareOptions): Promise<string> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const projectDir = opts.projectDir ?? DEFAULT_PROJECT_DIR;
  const client = new Freestyle({ apiKey: opts.apiKey });
  const t: PrepareTimings = { createMs: 0, writeMs: 0, installMs: 0, testMs: 0, snapshotMs: 0, deleteMs: 0, totalMs: 0 };
  const total = Date.now();

  let c = Date.now();
  const { vm, vmId } = await client.vms.create({
    snapshotId: BASE_IMAGE,
    // npm install needs the public internet; test VMs created from the snapshot get `rules: []`.
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    idleTimeoutSeconds: 600,
    ttlSeconds: 3600,
    autoDeleteSeconds: 0,
    displayName: runId("hive-prepare"),
    metadata: { hive: "prepare" },
  });
  t.createMs = Date.now() - c;
  log(`prepare: vm ${vmId} created in ${t.createMs}ms`);
  let sourceVmId = vmId;
  let snapshotId = "";
  try {
    c = Date.now();
    const paths = Object.keys(opts.files);
    const dirs = [...new Set(paths.filter((p) => p.includes("/")).map((p) => p.slice(0, p.lastIndexOf("/"))))];
    const mk = [`mkdir -p ${projectDir}`, ...dirs.map((d) => `mkdir -p ${projectDir}/${d}`)].join(" && ");
    await exec(vm, mk, 30_000, "mkdir");
    await Promise.all(paths.map((p) => vm.fs.writeFile(`${projectDir}/${p}`, opts.files[p]!)));
    t.writeMs = Date.now() - c;
    log(`prepare: wrote ${paths.length} files in ${t.writeMs}ms`);

    c = Date.now();
    // npm install, not ci: demo-app has no lockfile of its own inside the workspace.
    const install = await exec(vm, `cd ${projectDir} && node --version && npm --version && npm install --no-audit --no-fund 2>&1 | tail -5`, 300_000, "npm install");
    t.installMs = Date.now() - c;
    log(`prepare: npm install done in ${t.installMs}ms\n${(install.stdout ?? "").trim()}`);

    c = Date.now();
    const test = await exec(vm, `cd ${projectDir} && npx vitest run --passWithNoTests 2>&1 | tail -8`, 300_000, "vitest");
    t.testMs = Date.now() - c;
    log(`prepare: vitest green in ${t.testMs}ms\n${(test.stdout ?? "").trim()}`);

    c = Date.now();
    const snap = await vm.snapshot({ displayName: `hive-base-${new Date().toISOString().slice(0, 19)}` });
    t.snapshotMs = Date.now() - c;
    sourceVmId = snap.sourceVmId ?? vmId;
    log(`prepare: snapshot ${snap.snapshotId} in ${t.snapshotMs}ms`);

    snapshotId = snap.snapshotId;
  } finally {
    c = Date.now();
    try {
      await vm.delete();
      t.deleteMs = Date.now() - c;
      log(`prepare: vm ${vmId} deleted in ${t.deleteMs}ms`);
    } catch (err) {
      log(`prepare: vm ${vmId} delete FAILED: ${err instanceof Error ? err.message : String(err)} (delete it with: npx -y freestyle@latest vm delete ${vmId})`);
    }
    t.totalMs = Date.now() - total;
    log(`prepare: total ${t.totalMs}ms`);
    opts.onTimings?.(t);
  }
  if (opts.writeRecord !== false) {
    const record: BaseSnapshotRecord = { snapshotId, createdAt: new Date().toISOString(), projectDir, sourceVmId, timings: t };
    await writeBaseSnapshotRecord(record);
  }
  return snapshotId;
}

async function exec(vm: { exec: (o: { command: string; timeoutMs: number }) => Promise<{ stdout?: string | null; stderr?: string | null; statusCode?: number | null }> }, command: string, timeoutMs: number, what: string) {
  const res = await vm.exec({ command, timeoutMs });
  if (res.statusCode !== 0) {
    throw new Error(`prepare: ${what} failed (exit ${res.statusCode ?? "timeout"}):\n${res.stdout ?? ""}\n${res.stderr ?? ""}`);
  }
  return res;
}

export function baseSnapshotPath(repoRoot = findRepoRoot()): string {
  return join(repoRoot, BASE_SNAPSHOT_FILE);
}

export async function writeBaseSnapshotRecord(record: BaseSnapshotRecord, repoRoot = findRepoRoot()): Promise<void> {
  const file = baseSnapshotPath(repoRoot);
  await mkdir(join(repoRoot, ".hive"), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function readBaseSnapshotRecord(repoRoot = findRepoRoot()): Promise<BaseSnapshotRecord | undefined> {
  const file = baseSnapshotPath(repoRoot);
  if (!existsSync(file)) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as BaseSnapshotRecord;
}

/** Load a project dir the way HIVE_PROJECT_DIR is loaded: package.json, tsconfig.json, src/**, test/**; never node_modules. */
export async function readProjectFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ["package.json", "tsconfig.json"]) {
    const p = join(dir, name);
    if (existsSync(p)) out[name] = await readFile(p, "utf8");
  }
  for (const sub of ["src", "test"]) {
    const root = join(dir, sub);
    if (!existsSync(root)) continue;
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = join(e.parentPath, e.name);
      const rel = relative(dir, full).split("\\").join("/");
      if (rel.includes("node_modules/")) continue;
      out[rel] = await readFile(full, "utf8");
    }
  }
  return out;
}

async function main(): Promise<void> {
  const repoRoot = findRepoRoot();
  loadDotenv({ path: join(repoRoot, ".env"), quiet: true });
  const apiKey = process.env.FREESTYLE_API_KEY;
  if (!apiKey) {
    console.error("FREESTYLE_API_KEY is not set (put it in <repoRoot>/.env)");
    process.exit(1);
  }
  const projectEnv = process.env.HIVE_PROJECT_DIR ?? "../demo-app";
  const projectDir = isAbsolute(projectEnv) ? projectEnv : resolve(repoRoot, "server", projectEnv);
  const files = await readProjectFiles(projectDir);
  if (!Object.keys(files).some((p) => p.startsWith("src/"))) {
    console.error(`no src/ files found in ${projectDir}; set HIVE_PROJECT_DIR to a project with src/ and test/`);
    process.exit(1);
  }
  console.log(`prepare: ${Object.keys(files).length} files from ${projectDir}`);
  const snapshotId = await prepareBaseSnapshot({ apiKey, files });
  console.log(`prepare: base snapshot ${snapshotId} written to ${baseSnapshotPath(repoRoot)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
