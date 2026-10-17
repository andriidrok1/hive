// Experiment runner. Example:
//   npm run bench -w @hive/bench -- --scenarios s01,s02 --variants hive,naive,isolated --repeats 2 --parallel 3 --server http://localhost:4317
// One server handles one run at a time. With --parallel N the bench expects N servers already running on
// consecutive ports starting at --server's port (start them with PORT=4317, 4318, ... npm run dev -w @hive/server)
// and distributes the (scenario, variant, repeat) jobs across them.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { HiveMode } from "@hive/shared";
import { HiveClient } from "./client.js";
import type { ResultRow } from "./feed.js";
import { resultsDir } from "./paths.js";
import { runScenario } from "./runner.js";
import { loadScenarios, selectScenarios, type Scenario } from "./scenarios.js";
import { summaryMarkdown, toCsv } from "./summary.js";

const MODES: HiveMode[] = ["hive", "naive", "isolated"];

export interface BenchArgs {
  scenarios: Scenario[];
  variants: HiveMode[];
  repeats: number;
  parallel: number;
  server: string;
  timeoutMs: number;
  pollMs: number;
  out: string;
}

export function parseBenchArgs(argv: string[]): BenchArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenarios: { type: "string", default: "all" },
      variants: { type: "string", default: "hive,naive,isolated" },
      repeats: { type: "string", default: "1" },
      parallel: { type: "string", default: "1" },
      server: { type: "string", default: "http://localhost:4317" },
      "timeout-min": { type: "string", default: "5" },
      "poll-sec": { type: "string", default: "3" },
      out: { type: "string", default: resultsDir },
    },
  });
  const variants = values.variants!.split(",").map((v) => v.trim()) as HiveMode[];
  for (const v of variants) if (!MODES.includes(v)) throw new Error(`unknown variant "${v}"; use ${MODES.join(", ")}`);
  const repeats = Number(values.repeats);
  const parallel = Number(values.parallel);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error("--parallel must be a positive integer");
  return {
    scenarios: selectScenarios(loadScenarios(), values.scenarios),
    variants,
    repeats,
    parallel,
    server: values.server!.replace(/\/$/, ""),
    timeoutMs: Number(values["timeout-min"]) * 60_000,
    pollMs: Number(values["poll-sec"]) * 1000,
    out: values.out!,
  };
}

/** Server URLs for --parallel N: the base port and the N-1 ports after it. */
export function serverUrls(base: string, parallel: number): string[] {
  const u = new URL(base);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return Array.from({ length: parallel }, (_, k) => {
    const copy = new URL(u.toString());
    copy.port = String(port + k);
    return copy.toString().replace(/\/$/, "");
  });
}

export interface Job {
  scenario: Scenario;
  variant: HiveMode;
  repeat: number;
}

/** Repeats are the outer loop so a partial run still covers every scenario and variant once. */
export function buildJobs(args: Pick<BenchArgs, "scenarios" | "variants" | "repeats">): Job[] {
  const jobs: Job[] = [];
  for (let repeat = 1; repeat <= args.repeats; repeat++) {
    for (const scenario of args.scenarios) for (const variant of args.variants) jobs.push({ scenario, variant, repeat });
  }
  return jobs;
}

async function main(): Promise<void> {
  const args = parseBenchArgs(process.argv.slice(2));
  const startedAt = new Date();
  const urls = serverUrls(args.server, args.parallel);
  const jobs = buildJobs(args);
  console.log(`bench: ${jobs.length} runs over ${urls.length} server(s): ${urls.join(", ")}`);
  mkdirSync(args.out, { recursive: true });
  const csvPath = join(args.out, "results.csv");
  const mdPath = join(args.out, "summary.md");
  const jsonPath = join(args.out, "results.json");
  const rows: ResultRow[] = [];
  const flush = () => {
    writeFileSync(csvPath, toCsv(rows));
    writeFileSync(jsonPath, JSON.stringify(rows, null, 2));
    writeFileSync(mdPath, summaryMarkdown(rows, { startedAt, args: process.argv.slice(2).join(" ") }));
  };

  let next = 0;
  const workers = urls.map(async (url) => {
    const client = new HiveClient(url);
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      const row = await runScenario(client, job.scenario, job.variant, job.repeat, {
        timeoutMs: args.timeoutMs,
        pollMs: args.pollMs,
        log: (line) => console.log(`[${url}] ${line}`),
      });
      rows.push(row);
      flush();
    }
  });
  await Promise.all(workers);
  flush();
  console.log(`\nwrote ${csvPath}\n`);
  console.log(summaryMarkdown(rows, { startedAt, args: process.argv.slice(2).join(" ") }));
}

const isMain = process.argv[1] && /run\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
