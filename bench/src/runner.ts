import { TERMINAL_AGENT_STATUSES, type HiveMode } from "@hive/shared";
import { subscribeFeed, type FeedSocketFactory, type HiveClient } from "./client.js";
import type { ResultRow } from "./feed.js";
import { acceptanceFilter, readExtraTests, type Scenario } from "./scenarios.js";

export interface RunOptions {
  socketFactory?: FeedSocketFactory; // default: global WebSocket
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number; // default 3000
  timeoutMs?: number; // default 5 minutes
  extraTests?: string; // override the file content (tests); default read from bench/scenarios/extra
  acceptanceFilter?: string; // override the -t pattern for the acceptance-only run
  log?: (line: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One (scenario, variant, repeat) on one server:
 * reset -> feed subscription -> start agents after their delays -> wait for terminal statuses
 * -> merge (isolated) -> full suite + extraTests -> row.
 * Never throws for a failed run: errors land in `row.error`.
 */
export async function runScenario(
  client: HiveClient,
  scenario: Scenario,
  variant: HiveMode,
  repeat: number,
  opts: RunOptions = {},
): Promise<ResultRow> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const log = opts.log ?? (() => {});
  const factory: FeedSocketFactory = opts.socketFactory ?? ((url) => new WebSocket(url) as unknown as ReturnType<FeedSocketFactory>);

  const row: ResultRow = {
    scenario: scenario.id,
    variant,
    repeat,
    conflict: scenario.conflict,
    success: false,
    passed: 0,
    failed: 0,
    acceptancePassed: 0,
    acceptanceFailed: 0,
    acceptanceOk: false,
    toolCalls: 0,
    llmCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    wallMs: 0,
    briefingsSent: 0,
    acksAdapted: 0,
    conflictsCaught: 0,
    culpritSearches: 0,
    culpritCorrect: null,
    mergeOk: null,
    agentsFinished: false,
    error: "",
  };

  let feed: Awaited<ReturnType<typeof subscribeFeed>> | undefined;
  try {
    await client.reset(variant);
    feed = await subscribeFeed(client.feedUrl(), factory);
    const started = now();

    // Start each agent after its delay; the second starts while the first is mid-task.
    const starts = scenario.agents.map(async (a) => {
      const delay = scenario.startDelaysMs[a.agentId] ?? 0;
      if (delay > 0) await sleep(delay);
      log(`${scenario.id}/${variant}#${repeat}: start ${a.agentId} (+${delay}ms)`);
      await client.startAgent(a.agentId, a.humanId, a.task, a.owns);
    });
    await Promise.all(starts);

    // Poll until every scenario agent is in a terminal status.
    const wanted = new Set(scenario.agents.map((a) => a.agentId));
    for (;;) {
      const state = await client.state();
      const terminal = state.agents.filter((a) => wanted.has(a.agentId) && TERMINAL_AGENT_STATUSES.includes(a.status));
      if (terminal.length === wanted.size) {
        row.agentsFinished = true;
        break;
      }
      if (now() - started > timeoutMs) {
        row.error = `timeout after ${timeoutMs}ms: ${state.agents
          .filter((a) => wanted.has(a.agentId))
          .map((a) => `${a.agentId}=${a.status}`)
          .join(",")}`;
        break;
      }
      await sleep(pollMs);
    }
    row.wallMs = now() - started;

    if (variant === "isolated") {
      const merge = await client.merge();
      row.mergeOk = merge.ok;
    }

    const extra = opts.extraTests ?? readExtraTests(scenario);
    const extraFiles = { [scenario.extraTests]: extra };
    const result = await client.test({ extraFiles });
    row.success = result.ok;
    row.passed = result.passed;
    row.failed = result.failed;
    // Second view: only the acceptance tests, on the same files.
    const acceptance = await client.test({ extraFiles, filter: opts.acceptanceFilter ?? acceptanceFilter(scenario) });
    row.acceptanceOk = acceptance.ok;
    row.acceptancePassed = acceptance.passed;
    row.acceptanceFailed = acceptance.failed;
  } catch (err) {
    row.error = row.error ? `${row.error}; ${String(err)}` : String(err);
  } finally {
    if (feed) {
      // Let the last events (test_run_finished, culprit_found) arrive before closing.
      await sleep(Math.min(pollMs, 1000));
      const c = feed.counters;
      row.toolCalls = c.toolCalls;
      row.llmCalls = c.llmCalls;
      row.tokensIn = c.tokensIn;
      row.tokensOut = c.tokensOut;
      row.briefingsSent = c.briefingsSent;
      row.acksAdapted = c.acksAdapted;
      row.conflictsCaught = c.conflictsCaught;
      row.culpritSearches = c.culpritSearches;
      row.culpritCorrect = c.culpritCorrect(scenario.expectedCulprits);
      feed.close();
    }
  }
  log(
    `${scenario.id}/${variant}#${repeat}: success=${row.success} tests=${row.passed}/${row.passed + row.failed} ` +
      `acceptance=${row.acceptanceOk} (${row.acceptancePassed}/${row.acceptancePassed + row.acceptanceFailed}) ` +
      `tools=${row.toolCalls} tokens=${row.tokensIn}+${row.tokensOut} wall=${row.wallMs}ms` +
      (row.error ? ` error=${row.error}` : ""),
  );
  return row;
}
