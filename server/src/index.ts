// Entry point: loads .env from the repo root, picks runner and LLM, boots the hive and listens.
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeedEventBody, HiveMode, LLM, Runner } from "@hive/shared";
import { createHive, loadProjectDir } from "./hive.js";
import { FakeRunner } from "./api/fakes.js";
import { noopLLM, OpenAILLM } from "./coord/index.js";
import { makeRunner } from "./runner/index.js";
import { SAMPLE_PROJECT } from "./api/sampleProject.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");
loadEnv({ path: resolve(repoRoot, ".env"), quiet: true });

const env = process.env;
const mode = (["hive", "naive", "isolated"].includes(env.HIVE_MODE ?? "") ? env.HIVE_MODE : "hive") as HiveMode;
const port = Number(env.PORT ?? 4317);
const projectDir = resolve(serverDir, env.HIVE_PROJECT_DIR ?? "../demo-app");

let initialFiles = existsSync(projectDir) ? loadProjectDir(projectDir) : {};
if (!Object.keys(initialFiles).some((p) => p.startsWith("src/"))) {
  console.warn(`[hive] no src/ files in ${projectDir}; serving the built-in sample project`);
  initialFiles = SAMPLE_PROJECT;
}

let runner: Runner;
try {
  runner = makeRunner(env, (msg) => console.log(`[runner] ${msg}`));
  console.log(`[hive] runner: ${env.HIVE_RUNNER === "freestyle" ? "freestyle" : "local"}`);
} catch (err) {
  console.warn(`[hive] runner unavailable (${err instanceof Error ? err.message : String(err)}); tests will be faked as green`);
  runner = new FakeRunner();
}

let llm: LLM | ((emit: (e: FeedEventBody) => void) => LLM);
if (env.OPENAI_API_KEY) {
  const apiKey = env.OPENAI_API_KEY;
  llm = (onEvent) => new OpenAILLM({ apiKey, model: env.HIVE_MODEL_CHECK ?? "gpt-5.4-nano", onEvent });
} else {
  console.warn("[hive] OPENAI_API_KEY not set: conflict checks use a no-op LLM that never sees a conflict, and POST /api/agents will fail at the first model call");
  llm = noopLLM();
}

const hive = createHive({ mode, initialFiles, runner, llm, ...(env.HIVE_MODEL_AGENT ? { model: env.HIVE_MODEL_AGENT } : {}) });
await hive.built.ready;
await hive.built.app.listen({ port, host: "0.0.0.0" });
console.log(`[hive] mode=${mode} files=${Object.keys(initialFiles).length} listening on http://0.0.0.0:${port} (feed /ws/feed, yjs /yjs/project)`);

const shutdown = async () => {
  await hive.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
