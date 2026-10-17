import type { AckResponse, AgentControl, Briefing, Intent, ToolArgs, ToolName, ToolResponse, ToolResults } from "@hive/shared";
import type { HiveClient } from "../src/index.js";

// A small in-memory Hive that enforces the real editing protocol (approved intent, acked briefings,
// exactly-one-occurrence replace) so the loop can be exercised end to end without a server.
// Used by the live test; also handy for the bench's offline dry runs.

export interface InMemoryHiveOptions {
  agentId: string;
  humanId: string;
  files: Record<string, string>;
  // Called after each tool call; return briefings to attach to this response.
  onCall?: (tool: ToolName, args: unknown, n: number) => Briefing[] | void;
  // Fake test runner: decides from the current files.
  runTests?: (files: Record<string, string>) => ToolResults["run_tests"];
}

export class InMemoryHive implements HiveClient {
  files: Record<string, string>;
  rev = 0;
  control: AgentControl = "run";
  intents = new Map<string, Intent>();
  briefings: Briefing[] = [];
  log: { tool: ToolName; args: unknown; ok: boolean; code?: string }[] = [];
  private counter = 0;

  constructor(private opts: InMemoryHiveOptions) {
    this.files = { ...opts.files };
  }

  async call<T extends ToolName>(tool: T, args: ToolArgs[T]): Promise<ToolResponse<ToolResults[T]>> {
    const n = this.log.length + 1;
    const result = this.exec(tool, args);
    const fresh = this.opts.onCall?.(tool, args, n) ?? [];
    for (const b of fresh) this.briefings.push(b);
    const undelivered = this.briefings.filter((b) => !(b as Briefing & { delivered?: boolean }).delivered);
    for (const b of undelivered) (b as Briefing & { delivered?: boolean }).delivered = true;
    this.log.push({ tool, args, ok: result.ok, code: result.ok ? undefined : result.error.code });
    const envelope: ToolResponse<ToolResults[T]> = result.ok
      ? { ok: true, data: result.data as ToolResults[T], briefings: undelivered, control: this.control, rev: this.rev }
      : { ok: false, error: result.error, briefings: undelivered, control: this.control, rev: this.rev };
    return envelope;
  }

  private unacked(): Briefing[] {
    return this.briefings.filter((b) => b.requiresAck && !b.ack);
  }

  private exec(tool: ToolName, rawArgs: unknown): { ok: true; data: unknown } | { ok: false; error: NonNullable<ToolResponse["error"]> } {
    const a = rawArgs as Record<string, unknown>;
    const err = (code: NonNullable<ToolResponse["error"]>["code"], message: string, current?: string) => ({ ok: false as const, error: { code, message, ...(current !== undefined ? { current } : {}) } });
    switch (tool) {
      case "list_files":
        return { ok: true, data: { files: Object.keys(this.files).map((path) => ({ path, rev: this.rev })) } };
      case "read_file": {
        const content = this.files[String(a.path)];
        if (content === undefined) return err("NOT_FOUND", `no file ${String(a.path)}`);
        const lines = content.split("\n");
        const s = typeof a.startLine === "number" ? a.startLine : 1;
        const e = typeof a.endLine === "number" ? a.endLine : lines.length;
        return { ok: true, data: { path: a.path, rev: this.rev, content: lines.slice(s - 1, e).join("\n"), symbols: [] } };
      }
      case "declare_intent": {
        const input = a as unknown as ToolArgs["declare_intent"];
        if (!input.target?.file || !input.target.symbol || !input.what || !input.output) return err("BAD_ARGS", "target, what and output are required");
        const id = `A${++this.counter}`;
        const now = Date.now();
        const intent: Intent = { ...input, id, agentId: this.opts.agentId, humanId: this.opts.humanId, status: "approved", createdAt: now, updatedAt: now, baseRev: this.rev };
        this.intents.set(id, intent);
        return { ok: true, data: { intent, status: "approved", conflicts: [], dependents: [] } };
      }
      case "edit_region":
      case "create_file": {
        const intent = this.intents.get(String(a.intentId));
        if (!intent) return err("NO_INTENT", "declare_intent first and pass its intentId");
        if (intent.status !== "approved" && intent.status !== "in_progress") return err("INTENT_NOT_APPROVED", `intent ${intent.id} is ${intent.status}`);
        const pending = this.unacked();
        if (pending.length) return err("UNACKED_BRIEFINGS", `ack these briefings first: ${pending.map((b) => b.id).join(", ")}`);
        if (tool === "create_file") {
          if (typeof a.path !== "string" || typeof a.content !== "string") return err("BAD_ARGS", "path and content required");
          this.files[a.path] = a.content;
        } else {
          const path = String(a.path);
          const content = this.files[path];
          if (content === undefined) return err("NOT_FOUND", `no file ${path}`);
          const oldText = String(a.oldText);
          const first = content.indexOf(oldText);
          if (first < 0) return err("OLD_TEXT_NOT_FOUND", "oldText not found in the latest content; see current", content);
          if (content.indexOf(oldText, first + 1) >= 0) return err("OLD_TEXT_AMBIGUOUS", "oldText occurs more than once");
          this.files[path] = content.slice(0, first) + String(a.newText) + content.slice(first + oldText.length);
        }
        this.rev += 1;
        intent.status = "in_progress";
        intent.updatedAt = Date.now();
        return { ok: true, data: { path: a.path, rev: this.rev } };
      }
      case "finish_intent": {
        const intent = this.intents.get(String(a.intentId));
        if (!intent) return err("NOT_FOUND", `no intent ${String(a.intentId)}`);
        intent.status = "done";
        intent.endRev = this.rev;
        return { ok: true, data: { intent } };
      }
      case "run_tests": {
        const r = this.opts.runTests?.(this.files) ?? { ok: true, passed: 1, failed: 0, failures: [], durationMs: 1 };
        return { ok: true, data: r };
      }
      case "run_command":
        return { ok: true, data: { exitCode: 0, stdout: "(no runner in the in-memory hive)", stderr: "", durationMs: 1 } };
      case "ack_briefing": {
        const b = this.briefings.find((x) => x.id === a.briefingId);
        if (!b) return err("NOT_FOUND", `no briefing ${String(a.briefingId)}`);
        b.ack = { response: a.response as AckResponse, note: typeof a.note === "string" ? a.note : undefined, at: Date.now() };
        return { ok: true, data: { briefingId: b.id } };
      }
      case "ask_agent":
      case "reply":
        return { ok: true, data: { messageId: `msg_${++this.counter}` } };
    }
  }
}
