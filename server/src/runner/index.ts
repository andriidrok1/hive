import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Runner } from "@hive/shared";
import { FreestyleRunner } from "./FreestyleRunner.js";
import { LocalRunner } from "./LocalRunner.js";
import { BASE_SNAPSHOT_FILE, type BaseSnapshotRecord } from "./prepare.js";
import { findRepoRoot } from "./util.js";

export { LocalRunner } from "./LocalRunner.js";
export type { LocalRunnerOptions } from "./LocalRunner.js";
export { FreestyleRunner, DEFAULT_PROJECT_DIR } from "./FreestyleRunner.js";
export type { FreestyleRunnerOptions, VmTimings } from "./FreestyleRunner.js";
export { CulpritFinder, MAX_SUSPECTS, MAX_PAIR_SUSPECTS } from "./CulpritFinder.js";
export { TestOrchestrator, CHECK_TEST_PATH, checkTestSource, exportedValueNames, classifyCheck } from "./TestOrchestrator.js";
export type { CheckVerdict } from "./TestOrchestrator.js";
export type { TestOrchestratorDeps, StoreLike, HistoryLike, IntentsLike, BriefingsLike, ReadsLike, GraphLike } from "./TestOrchestrator.js";
export { prepareBaseSnapshot, readBaseSnapshotRecord, writeBaseSnapshotRecord, readProjectFiles, baseSnapshotPath, BASE_SNAPSHOT_FILE } from "./prepare.js";
export type { PrepareOptions, PrepareTimings, BaseSnapshotRecord } from "./prepare.js";
export { findRepoRoot, parseVitestJson, Semaphore } from "./util.js";

/**
 * Picks the runner from the environment: `HIVE_RUNNER=freestyle` needs `FREESTYLE_API_KEY` and a base
 * snapshot (`HIVE_BASE_SNAPSHOT` or `<repoRoot>/.hive/base-snapshot.json` from `runner:prepare`);
 * anything else is the LocalRunner on `HIVE_PROJECT_DIR` (default `../demo-app`, resolved from `server/`).
 */
export function makeRunner(env: NodeJS.ProcessEnv = process.env, log?: (msg: string) => void): Runner {
  const repoRoot = findRepoRoot();
  if (env.HIVE_RUNNER === "freestyle") {
    const apiKey = env.FREESTYLE_API_KEY;
    if (!apiKey) throw new Error("HIVE_RUNNER=freestyle but FREESTYLE_API_KEY is not set");
    let baseSnapshotId = env.HIVE_BASE_SNAPSHOT;
    let projectDir: string | undefined;
    const file = join(repoRoot, BASE_SNAPSHOT_FILE);
    if (existsSync(file)) {
      const record = JSON.parse(readFileSync(file, "utf8")) as BaseSnapshotRecord;
      baseSnapshotId ??= record.snapshotId;
      projectDir = record.projectDir;
    }
    if (!baseSnapshotId) throw new Error(`no base snapshot: run \`npm run runner:prepare -w @hive/server\` (writes ${BASE_SNAPSHOT_FILE}) or set HIVE_BASE_SNAPSHOT`);
    const maxParallel = env.HIVE_RUNNER_PARALLEL ? Number(env.HIVE_RUNNER_PARALLEL) : undefined;
    return new FreestyleRunner({ apiKey, baseSnapshotId, projectDir, maxParallel, log });
  }
  const projectEnv = env.HIVE_PROJECT_DIR ?? "../demo-app";
  const templateDir = isAbsolute(projectEnv) ? projectEnv : resolve(repoRoot, "server", projectEnv);
  return new LocalRunner({ templateDir });
}
