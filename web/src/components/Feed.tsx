import { useState } from "react";
import type { Briefing, FeedEvent } from "@hive/shared";
import { formatEvent, shortTime, type Tone } from "../format";
import { agentColor, type UiState } from "../state";

const TONE_COLOR: Record<Tone, string> = {
  agent: "var(--blue)",
  read: "var(--dim)",
  intent: "var(--purple)",
  conflict: "var(--red)",
  edit: "var(--teal)",
  briefing: "var(--accent)",
  ack: "var(--green)",
  message: "var(--pink)",
  test: "var(--amber)",
  green: "var(--green)",
  red: "var(--red)",
  culprit: "var(--accent)",
  human: "var(--text)",
  llm: "var(--line)",
};

export function Feed({ state, showLlm = false }: { state: UiState; showLlm?: boolean }) {
  const events = showLlm ? state.events : state.events.filter((e) => e.type !== "llm_call");
  if (events.length === 0) return <div className="editor-wait">Waiting for events…</div>;
  return (
    <ul className="feed" aria-label="feed">
      {events.map((e) => (
        <FeedRow key={e.id} e={e} briefings={state.briefings} />
      ))}
    </ul>
  );
}

function FeedRow({ e, briefings }: { e: FeedEvent; briefings: Record<string, Briefing> }) {
  const [open, setOpen] = useState(false);
  const line = formatEvent(e);
  const briefing = e.type === "briefing_sent" ? (briefings[e.briefing.id] ?? e.briefing) : null;
  const color = line.who && (line.tone === "agent" || line.tone === "edit" || line.tone === "read") ? agentColor(line.who) : TONE_COLOR[line.tone];
  return (
    <li className={line.tone} style={{ ["--c" as string]: color }} onClick={briefing ? () => setOpen((o) => !o) : undefined} data-testid={`ev-${e.id}`}>
      <span className="t">{shortTime(e.ts)}</span>
      <div>
        <span>{line.text}</span>
        {briefing && (open || briefing.kind === "culprit" || briefing.kind === "intent_conflict") && <BriefingBox b={briefing} />}
      </div>
    </li>
  );
}

export function BriefingBox({ b }: { b: Briefing }) {
  return (
    <div className="briefing-box">
      <div>{b.summary}</div>
      {b.details.diff && <pre>{b.details.diff}</pre>}
      {b.details.failingTests && b.details.failingTests.length > 0 && (
        <pre>{b.details.failingTests.map((t) => `${t.name}: ${t.message}`).join("\n")}</pre>
      )}
      {b.details.yourUsages && b.details.yourUsages.length > 0 && (
        <pre>your usages: {b.details.yourUsages.map((u) => `${u.file}:${u.line}`).join(", ")}</pre>
      )}
      {b.ack ? (
        <div className={`ackline ${b.ack.response}`}>
          ack: {b.ack.response}
          {b.ack.note ? ` — ${b.ack.note}` : ""}
        </div>
      ) : b.requiresAck ? (
        <div className="ackline pending">waiting for ack</div>
      ) : null}
    </div>
  );
}
