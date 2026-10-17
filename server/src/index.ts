// Entry point: loads .env from the repo root, picks runner and LLM, boots the hive and listens.
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HiveMode, LLM, Runner } from "@hive/shared";
import { createHive, loadProjectDir } from "./hive.js";
import { fakeModules, FakeRunner, NoConflictLLM } from "./api/fakes.js";
import { SAMPLE_PROJECT } from "./api/sampleProject.js";
import type { RunAgentFn } from "./agents/AgentManager.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");
loadEnv({ path: resolve(repoRoot, ".env"), quiet: true });

const env = process.env;
const mode = (["hive", "naive", "isolated"].includes(env.HIVE_MODE ?? "") ? env.HIVE_MODE : "hive") as HiveMode;
const port = Number(env.PORT ?? 4317);
const projectDir = resolve(serverDir, env.HIVE_PROJECT_DIR ?? "../demo-app");

let initialFiles = existsSync(projectDir) ? loadProjectDir(projectDir) : {};
if (Object.keys(initialFiles).length === 0) {
  console.warn(`[hive] no project files in ${projectDir}; serving the built-in sample project`);
  initialFiles = SAMPLE_PROJECT;
}

// TODO(integration): replace with real modules once merged into main:
//   core  -> ProjectStore, ReadLog, History            (server/src/core)
//   coord -> CallGraph, BriefingQueue, IntentRegistry, ChangeWatcher, Mailbox, OpenAILLM/FakeLLM, analyzeFile (server/src/coord)
//   runner-> makeRunner(env), TestOrchestrator           (server/src/runner)
//   agent -> runAgent from @hive/agent
const modules = fakeModules();
const runner: Runner = new FakeRunner();
console.warn("[hive] runner: in-memory fake (real runner not merged yet)");

let llm: LLM;
if (env.OPENAI_API_KEY) {
  console.warn("[hive] OPENAI_API_KEY is set but coord.OpenAILLM is not merged yet; using the no-conflict fake LLM");
  llm = new NoConflictLLM();
} else {
  console.warn("[hive] OPENAI_API_KEY not set: conflict checks use a fake LLM that never sees a conflict");
  llm = new NoConflictLLM();
}

const runAgent: RunAgentFn = async (opts) => {
  console.error(`[hive] @hive/agent not merged yet; cannot run ${opts.agentId}`);
  return { status: "error", toolCalls: 0, tokensIn: 0, tokensOut: 0, ms: 0, error: "agent loop not available in this build" };
};

const hive = createHive({ mode, initialFiles, runner, llm, modules, runAgent, ...(env.HIVE_MODEL_AGENT ? { model: env.HIVE_MODEL_AGENT } : {}) });
await hive.built.ready;
await hive.built.app.listen({ port, host: "0.0.0.0" });
console.log(`[hive] mode=${mode} files=${Object.keys(initialFiles).length} listening on http://0.0.0.0:${port} (feed /ws/feed, yjs /yjs/project)`);

const shutdown = async () => {
  await hive.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
