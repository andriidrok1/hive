import { useState } from "react";
import { MessageSquare, Pause, Play, Square, Zap } from "lucide-react";
import type { AgentControl, AgentStatus, Intent } from "@hive/shared";
import { TERMINAL_AGENT_STATUSES } from "@hive/shared";
import { agentColor } from "../state";
import { controlAgent, sendNote } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";

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

function statusVariant(s: AgentStatus): "success" | "warning" | "destructive" | "muted" | "secondary" {
  switch (s) {
    case "thinking":
    case "tool":
      return "success";
    case "paused":
      return "warning";
    case "error":
    case "stopped":
    case "budget":
      return "destructive";
    case "done":
      return "secondary";
    default:
      return "muted";
  }
}

export function intentTone(status: Intent["status"]): string {
  switch (status) {
    case "verified":
      return "text-emerald-400";
    case "conflict":
    case "failed":
      return "text-red-400";
    case "in_progress":
    case "done":
      return "text-foreground";
    case "cancelled":
      return "text-zinc-500";
    default:
      return "text-muted-foreground";
  }
}

export function AgentCard({ agentId, humanId, status, control, task, intent, actions, viewer }: AgentCardProps) {
  const [noteOpen, setNoteOpen] = useState<null | { urgent: boolean }>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const color = agentColor(agentId);
  const terminal = TERMINAL_AGENT_STATUSES.includes(status);
  const paused = status === "paused" || control === "pause";
  const live = status === "thinking" || status === "tool";

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
    <Card className="gap-2 px-3 py-2.5" data-testid={`card-${agentId}`}>
      <div className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", live && "animate-pulse")} style={{ background: color }} aria-hidden />
        <span className="text-[15px] font-semibold leading-none">{humanId}</span>
        <span className="font-mono text-xs text-muted-foreground">{agentId}</span>
        <Badge variant={statusVariant(status)} className="ml-auto font-mono">
          {status}
        </Badge>
      </div>
      {task && <div className="text-[13px] text-foreground/90">{task}</div>}
      {intent && (
        <div className="flex items-baseline gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
          <span className={cn("font-mono font-medium", intentTone(intent.status))}>{intent.id}</span>
          <span className="min-w-0 flex-1 truncate text-foreground/90">
            {intent.action} <span className="font-mono">{intent.target.symbol}</span>: {intent.what}
          </span>
          <span className={cn("font-mono text-[11px]", intentTone(intent.status))}>{intent.status}</span>
        </div>
      )}
      {actions.length > 0 && (
        <ul className="font-mono text-[11px] leading-[18px] text-muted-foreground">
          {actions.map((a, i) => (
            <li key={i} className="truncate">
              {a}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="outline" size="sm" onClick={() => setNoteOpen({ urgent: false })}>
          <MessageSquare />
          Note
        </Button>
        <Button variant="outline" size="sm" onClick={() => setNoteOpen({ urgent: true })}>
          <Zap />
          Urgent
        </Button>
        <Button variant="outline" size="sm" disabled={terminal} onClick={() => run(controlAgent(agentId, viewer, paused ? "run" : "pause"))}>
          {paused ? <Play /> : <Pause />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button variant="outline" size="sm" disabled={terminal} className="text-red-400 hover:text-red-300" onClick={() => run(controlAgent(agentId, viewer, "stop"))}>
          <Square />
          Stop
        </Button>
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}

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
              <DialogTitle>{noteOpen?.urgent ? "Urgent note" : "Note"} to {agentId}</DialogTitle>
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
