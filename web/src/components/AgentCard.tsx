import { useState } from "react";
import type { AgentControl, AgentStatus, Intent } from "@hive/shared";
import { TERMINAL_AGENT_STATUSES } from "@hive/shared";
import { agentColor, intentColor } from "../state";
import { controlAgent, sendNote } from "../api";

export interface AgentCardProps {
  agentId: string;
  humanId: string;
  status: AgentStatus;
  control: AgentControl;
  task?: string;
  intent?: Intent;
  actions: string[];
  viewer: string; // humanId of the person clicking
}

export function AgentCard({ agentId, humanId, status, control, task, intent, actions, viewer }: AgentCardProps) {
  const [noteOpen, setNoteOpen] = useState<null | { urgent: boolean }>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const color = agentColor(agentId);
  const terminal = TERMINAL_AGENT_STATUSES.includes(status);
  const paused = status === "paused" || control === "pause";

  const run = (p: Promise<void>) => {
    setErr(null);
    p.catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };

  const submitNote = () => {
    if (!noteOpen || !note.trim()) return;
    run(sendNote(agentId, viewer, note.trim(), noteOpen.urgent));
    setNote("");
    setNoteOpen(null);
  };

  return (
    <article className="card" style={{ ["--c" as string]: color }} data-testid={`card-${agentId}`}>
      <div className="head">
        <span className="human" style={{ color }}>
          {humanId}
        </span>
        <span className="id">{agentId}</span>
        <span className="status">
          <span className={`dot ${status}`} />
          {status}
        </span>
      </div>
      {task && <div className="task">{task}</div>}
      {intent && (
        <div className="intent" style={{ color: intentColor(intent.status, intent.agentId) }}>
          <span className="pill">{intent.id}</span>
          <span style={{ color: "var(--text)" }}>
            {intent.action} {intent.target.symbol}: {intent.what}
          </span>{" "}
          <span className="mono" style={{ fontSize: 12 }}>
            {intent.status}
          </span>
        </div>
      )}
      {actions.length > 0 && (
        <ul className="actions">
          {actions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      <div className="buttons">
        <button className="small" onClick={() => setNoteOpen({ urgent: false })}>
          Note
        </button>
        <button className="small danger" onClick={() => setNoteOpen({ urgent: true })}>
          Urgent
        </button>
        <button className="small" disabled={terminal} onClick={() => run(controlAgent(agentId, viewer, paused ? "run" : "pause"))}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button className="small danger" disabled={terminal} onClick={() => run(controlAgent(agentId, viewer, "stop"))}>
          Stop
        </button>
      </div>
      {noteOpen && (
        <form
          className="noteform"
          onSubmit={(e) => {
            e.preventDefault();
            submitNote();
          }}
        >
          <input
            autoFocus
            aria-label={noteOpen.urgent ? "urgent note" : "note"}
            placeholder={noteOpen.urgent ? "Urgent: interrupts the current step" : "Note for the agent"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="small primary" type="submit">
            Send
          </button>
          <button className="small" type="button" onClick={() => setNoteOpen(null)}>
            ×
          </button>
        </form>
      )}
      {err && <div className="error">{err}</div>}
    </article>
  );
}
