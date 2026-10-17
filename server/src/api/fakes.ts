// In-memory implementations of the module interfaces in deps.ts.
// Runner stand-ins (brief 04 is not merged yet): a scripted Runner and a minimal TestOrchestrator
// that runs the suite once per finished intent. Core and coord are the real modules.
import type { CmdResult, FeedEventBody, HiveMode, IntentId, Runner, TestResult } from "@hive/shared";
import type { HistoryLike, IntentRegistryLike, ProjectStoreLike, TestOrchestratorLike } from "./deps.js";

// ---------- runner ----------

export class FakeRunner implements Runner {
  readonly testCalls: { files: Record<string, string>; opts?: { filter?: string; timeoutSec?: number } }[] = [];
  readonly commandCalls: { files: Record<string, string>; cmd: string; timeoutSec?: number }[] = [];
  result: TestResult = { ok: true, passed: 1, failed: 0, failures: [], durationMs: 1 };

  async runTests(files: Record<string, string>, opts?: { filter?: string; timeoutSec?: number }): Promise<TestResult> {
    this.testCalls.push(opts ? { files, opts } : { files });
    return { ...this.result, failures: [...this.result.failures] };
  }

  async runCommand(files: Record<string, string>, cmd: string, timeoutSec?: number): Promise<CmdResult> {
    this.commandCalls.push(timeoutSec !== undefined ? { files, cmd, timeoutSec } : { files, cmd });
    return { exitCode: 0, stdout: `fake: ${cmd}`, stderr: "", durationMs: 1 };
  }
}

/** Runs the suite once per finished intent, marks it verified/failed, keeps a green snapshot. No culprit search. */
export class FakeTestOrchestrator implements TestOrchestratorLike {
  readonly finished: IntentId[] = [];
  private seq = 0;

  constructor(
    private readonly deps: {
      store: Pick<ProjectStoreLike, "allFiles" | "rev">;
      history: HistoryLike;
      intents: IntentRegistryLike;
      runner: Runner;
      onEvent: (e: FeedEventBody) => void;
      mode: HiveMode;
    },
  ) {}

  async onIntentFinished(intentId: IntentId): Promise<void> {
    this.finished.push(intentId);
    const runId = `run_${++this.seq}`;
    const rev = this.deps.store.rev;
    this.deps.onEvent({ type: "test_run_started", runId, rev, reason: `intent ${intentId} finished` });
    const result = await this.deps.runner.runTests(this.deps.store.allFiles());
    this.deps.onEvent({ type: "test_run_finished", runId, rev, result });
    if (result.ok) {
      this.deps.history.saveSnapshot(true);
      this.deps.intents.setStatus(intentId, "verified");
    } else {
      this.deps.intents.setStatus(intentId, "failed");
    }
  }
}

// ---------- module set for hive.ts ----------

export function fakeModules() {
  return { TestOrchestrator: FakeTestOrchestrator };
}

