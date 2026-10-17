import { ChevronLeft } from "lucide-react";
import type { FeedEvent } from "@hive/shared";
import { formatEvent } from "../format";
import { agentColor, type UiState } from "../state";
import { cn } from "../lib/utils";

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export interface ActivityRow {
  id: number;
  ts: number;
  actor: string; // "masha" or "alex → andrii"
  color: string;
  text: string;
}

// Short rows for the "Recent activity" list: actor (human name) + what, no routine reads or llm calls.
export function activityRows(state: UiState, limit = 6): ActivityRow[] {
  const human = (agentId: string) => state.agents.find((a) => a.agentId === agentId)?.humanId ?? agentId;
  const rows: ActivityRow[] = [];
  for (const e of state.events) {
    if (rows.length >= limit) break;
    const r = describe(e, human);
    if (r) rows.push({ id: e.id, ts: e.ts, ...r });
  }
  return rows;
}

function describe(e: FeedEvent, human: (id: string) => string): Omit<ActivityRow, "id" | "ts"> | null {
  switch (e.type) {
    case "llm_call":
    case "file_read":
      return null;
    case "message_sent":
      return { actor: `${human(e.message.from)} → ${human(e.message.to)}`, color: agentColor(e.message.from), text: e.message.text };
    case "briefing_sent": {
      const from = e.briefing.fromAgent ? human(e.briefing.fromAgent) : (e.briefing.fromHuman ?? "hive");
      return { actor: `${from} → ${human(e.briefing.toAgent)}`, color: agentColor(e.briefing.fromAgent ?? e.briefing.toAgent), text: `${e.briefing.kind.replace("_", " ")}: ${e.briefing.summary}` };
    }
    case "briefing_acked":
      return { actor: human(e.agentId), color: agentColor(e.agentId), text: `acked ${e.briefingId}: ${e.ack.response}${e.ack.note ? ` — ${e.ack.note}` : ""}` };
    case "intent_declared":
      return {
        actor: human(e.intent.agentId),
        color: e.conflicts.length ? "#ef4444" : agentColor(e.intent.agentId),
        text: e.conflicts.length ? `${e.intent.id} conflicts with ${e.conflicts.map((c) => c.intentId).join(", ")}: ${e.intent.what}` : `${e.intent.id}: ${e.intent.what}`,
      };
    case "edit_applied":
      return { actor: human(e.agentId), color: agentColor(e.agentId), text: `edited ${e.path} (+${e.added} −${e.removed})` };
    case "agent_status":
      return { actor: human(e.agentId), color: agentColor(e.agentId), text: `${e.status}${e.task ? `: ${e.task}` : ""}` };
    case "test_run_finished":
      return { actor: "tests", color: e.result.ok ? "#22c55e" : "#ef4444", text: e.result.ok ? `all ${e.result.passed} passed @${e.rev}` : `${e.result.failed} failed @${e.rev}` };
    case "culprit_found":
      return { actor: "culprit", color: "#ef4444", text: formatEvent(e).text.replace(/^culprit: /, "") };
    case "human_action":
      return { actor: e.humanId, color: agentColor(e.humanId), text: `${e.action}${e.target ? ` ${e.target}` : ""}` };
    default:
      return { actor: "hive", color: "#8b90a3", text: formatEvent(e).text };
  }
}

export function ProjectActivity({ state, now, onShowAll }: { state: UiState; now: number; onShowAll: () => void }) {
  const working = state.agents.filter((a) => a.status === "thinking" || a.status === "tool").length;
  const idle = state.agents.filter((a) => a.status === "idle" || a.status === "paused").length + state.intents.filter((i) => i.status === "conflict").length;
  const last = state.tests.last?.result;
  const total = last ? last.passed + last.failed : 0;
  const rows = activityRows(state);
  return (
    <div className="flex flex-col gap-3 pt-2" aria-label="project activity">
      <div className="flex items-center gap-1 px-1 text-[14px] font-semibold">
        <ChevronLeft className="size-3.5 text-muted-foreground" />
        Project activity
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-emerald-400">
          <span className={cn("size-1.5 rounded-full bg-emerald-400", state.connection !== "connecting" && "animate-pulse")} />
          Live
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Tile value={working} label="Working" />
        <Tile value={idle} label="Idle" />
        <Tile
          value={
            last ? (
              <>
                <span className={last.ok ? "text-emerald-400" : "text-red-400"}>{last.passed}</span>
                <span className="text-sm text-muted-foreground">/{total}</span>
              </>
            ) : (
              "–"
            )
          }
          label="Tests passed"
          testId="tests-tile"
        />
      </div>
      <div className="flex items-center px-1 text-[13px] font-medium">
        <ChevronLeft className="size-3.5 text-muted-foreground" />
        Recent activity
        <button className="ml-auto text-xs font-normal text-muted-foreground hover:text-foreground" onClick={onShowAll}>
          Show all
        </button>
      </div>
      <ul className="flex flex-col gap-1.5 px-1" aria-label="recent activity">
        {rows.length === 0 && <li className="text-xs text-muted-foreground">Nothing yet.</li>}
        {rows.map((r) => (
          <li key={r.id} className="grid grid-cols-[10px_auto_minmax(0,1fr)_auto] items-baseline gap-2 text-[13px]">
            <span className="size-2.5 translate-y-px rounded-full" style={{ background: r.color }} />
            <span className="whitespace-nowrap font-medium">{r.actor}</span>
            <span className="truncate text-muted-foreground">{r.text}</span>
            <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">{ago(now - r.ts)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tile({ value, label, testId }: { value: React.ReactNode; label: string; testId?: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-lg border border-border bg-background py-3" data-testid={testId}>
      <span className="font-mono text-[22px] font-semibold leading-none">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
