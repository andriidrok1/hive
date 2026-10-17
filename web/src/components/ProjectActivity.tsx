import { ChevronLeft, FlaskConical } from "lucide-react";
import { describeReport } from "../format";
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
  const owner = (intentId: string) => state.intents.find((i) => i.id === intentId)?.agentId;
  const rows: ActivityRow[] = [];
  for (const e of state.events) {
    if (rows.length >= limit) break;
    const r = describe(e, human, owner);
    if (r) rows.push({ id: e.id, ts: e.ts, ...r });
  }
  return rows;
}

function describe(e: FeedEvent, human: (id: string) => string, owner: (intentId: string) => string | undefined): Omit<ActivityRow, "id" | "ts"> | null {
  switch (e.type) {
    case "llm_call":
    case "file_read":
    case "culprit_variant_result": // the notice under the tiles covers these
      return null;
    case "intent_status": {
      const a = owner(e.intentId);
      const tone = e.status === "verified" ? "#22c55e" : e.status === "failed" || e.status === "conflict" ? "#ef4444" : a ? agentColor(a) : "#8b90a3";
      return { actor: a ? human(a) : "hive", color: tone, text: `${e.intentId} ${e.status.replace("_", " ")}` };
    }
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
      return { actor: human(e.agentId), color: agentColor(e.agentId), text: e.task && e.step === 1 ? `started: ${e.task}` : e.status };
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

// One line under the tiles while a culprit search runs, then who it found.
export function culpritNotice(state: UiState): { text: string; tone: "running" | "found" | "unknown" } | null {
  const g = state.culprit;
  if (!g) return null;
  if (!g.report) {
    const expected = Math.max(g.order.length, g.suspects.length * 2);
    return { text: `Culprit search running: ${g.order.length}/${expected} variants…`, tone: "running" };
  }
  const human = (intentId: string) => {
    const i = state.intents.find((x) => x.id === intentId);
    return i ? (state.agents.find((a) => a.agentId === i.agentId)?.humanId ?? i.humanId) : null;
  };
  const owned = g.report.culprits.map((c) => {
    const h = human(c);
    return h ? `${h}'s ${c}` : c;
  });
  if (g.report.kind === "unknown" || owned.length === 0) return { text: `Culprit: none found (${describeReport(g.report)})`, tone: "unknown" };
  return { text: `Culprit: ${owned.join(" + ")}${g.report.kind === "pair" ? " together" : ""}`, tone: "found" };
}

export function ProjectActivity({ state, now, onShowAll, onOpenCulprit }: { state: UiState; now: number; onShowAll: () => void; onOpenCulprit?: () => void }) {
  const notice = culpritNotice(state);
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
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium">
          <span className={cn("size-1.5 rounded-full", state.connection === "open" || state.connection === "mock" ? "bg-emerald-400" : state.connection === "reconnecting" ? "bg-amber-400" : "bg-zinc-500", state.connection !== "connecting" && "animate-pulse")} />
          <span className="text-emerald-400">Live</span>
          <span className="font-mono text-muted-foreground">{state.connection}</span>
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
      {notice && (
        <button
          type="button"
          onClick={onOpenCulprit}
          className={cn(
            "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent/60",
            notice.tone === "running" ? "border-amber-500/50 text-amber-300" : notice.tone === "found" ? "border-red-500/60 text-red-300" : "border-border text-muted-foreground",
          )}
          data-testid="culprit-notice"
        >
          <FlaskConical className={cn("size-3.5 shrink-0", notice.tone === "running" && "animate-pulse")} />
          <span className="truncate">{notice.text}</span>
        </button>
      )}
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
      <span className="text-[22px] font-semibold leading-none tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
