import { useState } from "react";
import { FileText, MessageSquare, MoreHorizontal, Pause, Play, Square, Zap } from "lucide-react";
import type { AgentControl, AgentStatus, Intent } from "@hive/shared";
import { TERMINAL_AGENT_STATUSES } from "@hive/shared";
import { agentColor, type AgentMeta } from "../state";
import { controlAgent, sendNote } from "../api";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";

export const STEP_BUDGET = 40; // tool calls per agent run (CONTRACTS.md)

export interface AgentCardProps {
  agentId: string;
  humanId: string;
  status: AgentStatus;
  control: AgentControl;
  task?: string;
  intent?: Intent;
  actions: string[];
  viewer: string; // humanId of the person clicking
  meta?: AgentMeta;
  files?: string[];
  testsRunning?: boolean;
  now?: number;
  selected?: boolean; // target of the bottom chat box
  onSelect?: () => void;
}

export interface StatusView {
  label: string;
  dot: string; // tailwind bg class
  busy: boolean; // indeterminate progress
}

export function statusView(status: AgentStatus, intent: Intent | undefined, testsRunning: boolean): StatusView {
  if (status === "paused") return { label: "Paused", dot: "bg-amber-400", busy: false };
  if (intent?.status === "conflict" && !TERMINAL_AGENT_STATUSES.includes(status)) return { label: "Waiting on conflict", dot: "bg-red-400", busy: false };
  switch (status) {
    case "thinking":
    case "tool":
      return testsRunning && intent?.status === "done" ? { label: "Running tests", dot: "bg-emerald-400", busy: true } : { label: "Working", dot: "bg-emerald-400", busy: true };
    case "idle":
      return { label: "Idle", dot: "bg-zinc-500", busy: false };
    case "done":
      return { label: "Done", dot: "bg-violet", busy: false };
    case "stopped":
      return { label: "Stopped", dot: "bg-zinc-500", busy: false };
    case "budget":
      return { label: "Budget spent", dot: "bg-amber-400", busy: false };
    case "error":
      return { label: "Error", dot: "bg-red-400", busy: false };
    default: {
      const _x: never = status;
      return _x;
    }
  }
}

export function elapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function AgentCard({ agentId, humanId, status, control, task, intent, actions, viewer, meta, files = [], testsRunning = false, now, selected = false, onSelect }: AgentCardProps) {
  const [noteOpen, setNoteOpen] = useState<null | { urgent: boolean }>(null);
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const color = agentColor(agentId);
  const terminal = TERMINAL_AGENT_STATUSES.includes(status);
  const paused = status === "paused" || control === "pause";
  const view = statusView(status, intent, testsRunning);
  const progress = status === "done" ? 1 : meta?.step !== undefined ? Math.min(1, meta.step / STEP_BUDGET) : null;
  const line = intent?.what ?? task;

  const run = (p: Promise<void>) => {
    setErr(null);
    setMenu(false);
    p.catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };

  const submitNote = () => {
    if (!noteOpen || !note.trim()) return;
    run(sendNote(agentId, viewer, note.trim(), noteOpen.urgent));
    setNote("");
    setNoteOpen(null);
  };

  return (
    <Card
      className={cn("relative min-w-0 cursor-pointer gap-2 px-3 py-3", view.busy && "border-l-2 border-l-[var(--c)]", selected && "ring-1 ring-violet/60")}
      style={{ ["--c" as string]: color }}
      data-testid={`card-${agentId}`}
      onClick={onSelect}
      aria-selected={selected || undefined}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="hex flex size-11 shrink-0 items-center justify-center" style={{ background: `color-mix(in srgb, ${color} 22%, transparent)` }} aria-hidden>
          <div className="hex size-5" style={{ background: color }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold leading-none">{humanId}</span>
            <span className={cn("size-2 rounded-full", view.dot, view.busy && "animate-pulse")} />
            <span className="text-xs text-muted-foreground">{view.label}</span>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground" title={`agent ${agentId}`}>
              {meta ? elapsed((now ?? Date.now()) - meta.startedAt) : agentId}
            </span>
            <Button variant="ghost" size="icon" className="-mr-1 size-6" aria-label="Agent menu" onClick={() => setMenu((m) => !m)}>
              <MoreHorizontal />
            </Button>
          </div>
          {line && <div className="mt-1 truncate text-[13px] text-foreground/90">{line}</div>}
          {!terminal || progress !== null ? (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-secondary" aria-label="progress">
              {progress === null ? (
                <div className={cn("h-full w-1/3 rounded-full", view.busy && "animate-pulse")} style={{ background: color }} />
              ) : (
                <div className="h-full rounded-full transition-[width]" style={{ width: `${Math.round(progress * 100)}%`, background: color }} />
              )}
            </div>
          ) : null}
          {files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {files.map((f) => (
                <span key={f} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground/85">
                  <FileText className="size-3 text-muted-foreground" />
                  {f}
                </span>
              ))}
            </div>
          )}
          {intent && (
            <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
              {intent.id} · {intent.action} {intent.target.symbol} · {intent.status}
            </div>
          )}
          {actions.length > 0 && !intent && <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">{actions[0]}</div>}
        </div>
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}

      {menu && (
        <div className="absolute right-2 top-10 z-20 flex w-44 flex-col rounded-md border border-border bg-popover p-1 shadow-lg" role="menu" aria-label={`actions for ${agentId}`}>
          <Button variant="ghost" size="sm" className="justify-start" role="menuitem" onClick={() => { setMenu(false); setNoteOpen({ urgent: false }); }}>
            <MessageSquare />
            Note
          </Button>
          <Button variant="ghost" size="sm" className="justify-start" role="menuitem" onClick={() => { setMenu(false); setNoteOpen({ urgent: true }); }}>
            <Zap />
            Urgent
          </Button>
          <Button variant="ghost" size="sm" className="justify-start" role="menuitem" disabled={terminal} onClick={() => run(controlAgent(agentId, viewer, paused ? "run" : "pause"))}>
            {paused ? <Play /> : <Pause />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="ghost" size="sm" className="justify-start text-red-400 hover:text-red-300" role="menuitem" disabled={terminal} onClick={() => run(controlAgent(agentId, viewer, "stop"))}>
            <Square />
            Stop
          </Button>
        </div>
      )}

      <Dialog open={noteOpen !== null} onOpenChange={(o) => !o && setNoteOpen(null)}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitNote();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {noteOpen?.urgent ? "Urgent note" : "Note"} to {agentId}
              </DialogTitle>
              <DialogDescription>
                {noteOpen?.urgent ? "Interrupts the current model call; the agent must acknowledge it before its next edit." : "Delivered with the agent's next tool result."}
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              aria-label={noteOpen?.urgent ? "urgent note" : "note"}
              placeholder={noteOpen?.urgent ? "Stop touching calculateTotal" : "Put tax in applyTax, not in calculateTotal"}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setNoteOpen(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!note.trim()}>
                Send
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
