import { useState } from "react";
import type { Briefing, FeedEvent } from "@hive/shared";
import { formatEvent, shortTime, type Tone } from "../format";
import { agentColor, type UiState } from "../state";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/utils";

// Border colour per tone: neutral for routine lines, accents only for outcomes.
const TONE_BORDER: Record<Tone, string> = {
  agent: "border-l-zinc-600",
  read: "border-l-zinc-800",
  intent: "border-l-zinc-500",
  conflict: "border-l-amber-500",
  edit: "border-l-zinc-600",
  briefing: "border-l-zinc-400",
  ack: "border-l-emerald-500",
  message: "border-l-zinc-500",
  test: "border-l-zinc-500",
  green: "border-l-emerald-500",
  red: "border-l-red-500",
  culprit: "border-l-red-500",
  human: "border-l-zinc-300",
  llm: "border-l-transparent",
};

const TONE_TEXT: Partial<Record<Tone, string>> = {
  conflict: "text-amber-300",
  green: "text-emerald-300",
  red: "text-red-300",
  culprit: "text-red-300 font-medium",
  ack: "text-emerald-300",
  llm: "text-zinc-600 text-xs",
  read: "text-muted-foreground",
};

export function Feed({ state, showLlm = false }: { state: UiState; showLlm?: boolean }) {
  const events = showLlm ? state.events : state.events.filter((e) => e.type !== "llm_call");
  if (events.length === 0) return <div className="px-4 py-6 text-xs text-muted-foreground">Waiting for events.</div>;
  return (
    <ScrollArea className="h-full">
      <ul className="py-1" aria-label="feed">
        {events.map((e) => (
          <FeedRow key={e.id} e={e} briefings={state.briefings} />
        ))}
      </ul>
    </ScrollArea>
  );
}

function FeedRow({ e, briefings }: { e: FeedEvent; briefings: Record<string, Briefing> }) {
  const [open, setOpen] = useState(false);
  const line = formatEvent(e);
  const briefing = e.type === "briefing_sent" ? (briefings[e.briefing.id] ?? e.briefing) : null;
  const agentLine = line.who && (line.tone === "agent" || line.tone === "edit");
  const style = agentLine && line.who ? { borderLeftColor: agentColor(line.who) } : undefined;
  const row = (
    <li
      className={cn("grid grid-cols-[56px_1fr] gap-3 border-l-2 px-3 py-1.5 text-sm leading-snug", TONE_BORDER[line.tone], TONE_TEXT[line.tone], briefing && "cursor-pointer hover:bg-muted/50")}
      style={style}
      onClick={briefing ? () => setOpen((o) => !o) : undefined}
      data-testid={`ev-${e.id}`}
    >
      <span className="pt-px font-mono text-[11px] text-zinc-500">{shortTime(e.ts)}</span>
      <div className="min-w-0">
        <span>{line.text}</span>
        {briefing && (open || briefing.kind === "culprit" || briefing.kind === "intent_conflict") && <BriefingBox b={briefing} />}
      </div>
    </li>
  );
  if (!briefing) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="left" align="start">
        <div className="font-mono text-[11px] text-muted-foreground">
          {briefing.id} · {briefing.kind} → {briefing.toAgent}
        </div>
        <div className="mt-1 text-xs text-foreground">{briefing.summary}</div>
        {briefing.ack && (
          <div className="mt-1 font-mono text-[11px] text-emerald-400">
            ack: {briefing.ack.response}
            {briefing.ack.note ? ` — ${briefing.ack.note}` : ""}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function BriefingBox({ b }: { b: Briefing }) {
  return (
    <div className="mt-1.5 rounded-md border border-border bg-card px-3 py-2 text-[13px] font-normal text-foreground/90">
      <div>{b.summary}</div>
      {b.details.diff && <pre className="mt-1.5 whitespace-pre-wrap font-mono text-xs text-muted-foreground">{b.details.diff}</pre>}
      {b.details.failingTests && b.details.failingTests.length > 0 && (
        <pre className="mt-1.5 whitespace-pre-wrap font-mono text-xs text-muted-foreground">{b.details.failingTests.map((t) => `${t.name}: ${t.message}`).join("\n")}</pre>
      )}
      {b.details.yourUsages && b.details.yourUsages.length > 0 && (
        <div className="mt-1.5 font-mono text-xs text-muted-foreground">your usages: {b.details.yourUsages.map((u) => `${u.file}:${u.line}`).join(", ")}</div>
      )}
      {b.ack ? (
        <div className={cn("mt-1.5 font-mono text-xs", b.ack.response === "adapted" ? "text-emerald-400" : "text-muted-foreground")}>
          ack: {b.ack.response}
          {b.ack.note ? ` — ${b.ack.note}` : ""}
        </div>
      ) : b.requiresAck ? (
        <div className="mt-1.5 font-mono text-xs text-amber-400">waiting for ack</div>
      ) : null}
    </div>
  );
}
