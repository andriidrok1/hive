// Runs agent loops in-process. The loop itself comes from @hive/agent (runAgent); the manager owns
// the two cancellation controllers per agent (stop = signal, interrupt = urgent human note),
// the control value the tool envelope reports, and emits agent_status / llm_call feed events.
import type { AgentControl, AgentId, AgentStatus, HiveMode, HumanId, ToolArgs, ToolName, ToolResponse, ToolResults } from "@hive/shared";
import { TERMINAL_AGENT_STATUSES } from "@hive/shared";
import type { Emitter } from "../emit.js";
import type { AgentManagerLike, AgentRecord, BriefingQueueLike, ToolCaller } from "../api/deps.js";

// Mirrors HiveClient / RunOptions / RunResult from @hive/agent (brief 05) structurally,
// so this file compiles before that package lands and accepts the real runAgent afterwards.
export interface AgentClientLike {
  call<T extends ToolName>(tool: T, args: ToolArgs[T]): Promise<ToolResponse<ToolResults[T]>>;
}
export interface AgentRunOptions {
  agentId: AgentId;
  humanId: HumanId;
  task: string;
  client: AgentClientLike;
  model?: string;
  signal?: AbortSignal;
  interrupt?: { current(): AbortSignal };
  onEvent?: (e: { type: "llm_call" | "tool_call" | "status"; [k: string]: unknown }) => void;
  mode?: HiveMode;
}
export interface AgentRunResult {
  status: "done" | "stopped" | "budget" | "error";
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  finalMessage?: string;
  error?: string;
}
export type RunAgentFn = (opts: AgentRunOptions) => Promise<AgentRunResult>;

interface Running {
  stop: AbortController;
  interrupt: AbortController;
  promise: Promise<void>;
  step: number;
}

export interface AgentManagerOptions {
  runAgent: RunAgentFn;
  tools: ToolCaller;
  emitter: Emitter;
  briefings: () => BriefingQueueLike;
  mode: () => HiveMode;
  model?: string;
  /** Runs when a run reaches a terminal status, before agent_status is emitted (closes open intents). */
  onTerminal?: (agentId: AgentId, status: AgentStatus) => void;
}

export class AgentManager implements AgentManagerLike {
  private readonly agents = new Map<AgentId, AgentRecord>();
  private readonly running = new Map<AgentId, Running>();

  constructor(private readonly opts: AgentManagerOptions) {}

  register(agentId: AgentId, humanId: HumanId): AgentRecord {
    let rec = this.agents.get(agentId);
    if (!rec) {
      rec = { agentId, humanId, status: "idle", control: "run" };
      this.agents.set(agentId, rec);
    } else if (rec.humanId !== humanId) {
      rec.humanId = humanId;
    }
    return rec;
  }

  get(agentId: AgentId): AgentRecord | undefined {
    const rec = this.agents.get(agentId);
    return rec ? { ...rec } : undefined;
  }

  list(): AgentRecord[] {
    return [...this.agents.values()].map((r) => ({ ...r }));
  }

  controlOf(agentId: AgentId): AgentControl {
    return this.agents.get(agentId)?.control ?? "run";
  }

  isRunning(agentId: AgentId): boolean {
    return this.running.has(agentId);
  }

  start(input: { agentId: AgentId; humanId: HumanId; task: string }): { ok: true } | { ok: false; code: "ALREADY_RUNNING" } {
    if (this.running.has(input.agentId)) return { ok: false, code: "ALREADY_RUNNING" };
    const rec = this.register(input.agentId, input.humanId);
    rec.task = input.task;
    rec.control = "run";
    const run: Running = { stop: new AbortController(), interrupt: new AbortController(), promise: Promise.resolve(), step: 0 };
    this.running.set(input.agentId, run);
    this.setStatus(rec, "idle");

    const client: AgentClientLike = {
      call: async (tool, args) => {
        run.step += 1;
        this.setStatus(rec, "tool", run.step);
        return this.opts.tools.call(input.agentId, tool, args);
      },
    };

    const runOpts: AgentRunOptions = {
      agentId: input.agentId,
      humanId: input.humanId,
      task: input.task,
      client,
      signal: run.stop.signal,
      interrupt: { current: () => this.running.get(input.agentId)?.interrupt.signal ?? new AbortController().signal },
      mode: this.opts.mode(),
      onEvent: (e) => this.onLoopEvent(rec, e),
    };
    if (this.opts.model) runOpts.model = this.opts.model;

    run.promise = (async () => {
      let status: AgentStatus;
      try {
        const result = await this.opts.runAgent(runOpts);
        status = result.status;
        if (result.error) console.error(`[agent ${input.agentId}] ${result.status}: ${result.error}`);
      } catch (err) {
        status = run.stop.signal.aborted ? "stopped" : "error";
        console.error(`[agent ${input.agentId}] crashed:`, err instanceof Error ? err.message : err);
      }
      if (this.running.get(input.agentId) === run) this.running.delete(input.agentId);
      try {
        this.opts.onTerminal?.(input.agentId, status);
      } catch (err) {
        console.error(`[agent ${input.agentId}] cleanup failed:`, err instanceof Error ? err.message : err);
      }
      this.setStatus(rec, status, run.step);
    })();
    return { ok: true };
  }

  control(agentId: AgentId, control: AgentControl): boolean {
    const rec = this.agents.get(agentId);
    if (!rec) return false;
    rec.control = control;
    const run = this.running.get(agentId);
    if (control === "stop") {
      run?.stop.abort();
      if (!run && !TERMINAL_AGENT_STATUSES.includes(rec.status)) this.setStatus(rec, "stopped");
    } else if (control === "pause" && run && !TERMINAL_AGENT_STATUSES.includes(rec.status)) {
      this.setStatus(rec, "paused", run.step);
    } else if (control === "run" && run && rec.status === "paused") {
      this.setStatus(rec, "thinking", run.step);
    }
    return true;
  }

  note(agentId: AgentId, humanId: HumanId, text: string, urgent: boolean): boolean {
    const rec = this.agents.get(agentId);
    if (!rec) return false;
    this.opts.briefings().push({
      toAgent: agentId,
      kind: "human_note",
      fromHuman: humanId,
      summary: text.slice(0, 400),
      details: {},
      requiresAck: urgent,
    });
    if (urgent) {
      const run = this.running.get(agentId);
      if (run) {
        const old = run.interrupt;
        run.interrupt = new AbortController(); // replaced before aborting so current() never hands out a dead signal
        old.abort();
      }
    }
    return true;
  }

  async stopAll(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const [agentId, run] of this.running) {
      const rec = this.agents.get(agentId);
      if (rec) rec.control = "stop";
      run.stop.abort();
      waits.push(Promise.race([run.promise, new Promise<void>((r) => setTimeout(r, 2000))]));
    }
    await Promise.all(waits);
    this.running.clear();
    this.agents.clear();
  }

  private onLoopEvent(rec: AgentRecord, e: { type: string; [k: string]: unknown }): void {
    if (e.type === "llm_call") {
      this.opts.emitter.emit({
        type: "llm_call",
        purpose: `agent:${rec.agentId}`,
        model: typeof e.model === "string" ? e.model : (this.opts.model ?? "unknown"),
        ms: num(e.ms),
        tokensIn: num(e.tokensIn),
        tokensOut: num(e.tokensOut),
      });
      if (rec.status !== "paused") this.setStatus(rec, "thinking", this.running.get(rec.agentId)?.step);
    }
  }

  private setStatus(rec: AgentRecord, status: AgentStatus, step?: number): void {
    rec.status = status;
    const body: Parameters<Emitter["emit"]>[0] = { type: "agent_status", agentId: rec.agentId, humanId: rec.humanId, status };
    if (rec.task !== undefined) body.task = rec.task;
    if (step !== undefined) body.step = step;
    this.opts.emitter.emit(body);
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
