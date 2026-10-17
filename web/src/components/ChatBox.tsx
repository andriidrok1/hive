import { useRef, useState } from "react";
import { SendHorizontal, Sparkles, Zap } from "lucide-react";
import { ANDRII_SAMPLE_TASK } from "../demoPresets";
import type { HiveState } from "@hive/shared";
import { TERMINAL_AGENT_STATUSES } from "@hive/shared";
import { sendNote, startAgent } from "../api";
import { agentColor } from "../state";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

interface Props {
  agents: HiveState["agents"];
  target: string | null; // agentId the note goes to
  onTarget: (agentId: string) => void;
  humanId: string; // the "you" field
}

export const myAgentId = (humanId: string) => `agent-${humanId || "me"}`;

// Bottom of the Agents column. If your own agent (agent-<you>) is not running, the text starts it
// as a task (POST /api/agents); otherwise it is a Note (or an Urgent note) to the selected agent.
export function ChatBox({ agents, target, onTarget, humanId }: Props) {
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const mine = myAgentId(humanId);
  const mineRunning = agents.some((a) => a.agentId === mine && !TERMINAL_AGENT_STATUSES.includes(a.status));
  const agent = agents.find((a) => a.agentId === target);
  const name = agent?.humanId ?? target ?? "an agent";
  const mode: "task" | "note" = mineRunning ? "note" : "task";
  const canSend = text.trim().length > 0 && !busy && (mode === "task" || target !== null);

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "task") {
        await startAgent({ agentId: mine, humanId, task: text.trim() });
        setMsg(`Started ${mine}`);
      } else if (target) {
        await sendNote(target, humanId, text.trim(), urgent);
        setMsg(`${urgent ? "Urgent note" : "Note"} sent to ${name}`);
      }
      setText("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="border-t border-border bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      aria-label="tell agent"
    >
      <div className={cn("rounded-lg border bg-background p-2 transition-colors", urgent && mode === "note" ? "border-amber-500/60" : "border-border focus-within:border-violet/70")}>
        <textarea
          ref={box}
          aria-label="instruction"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={mode === "task" ? "Give your agent a task…" : `Tell ${name} what to do…`}
          className="w-full resize-none bg-transparent px-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="mt-1 flex items-center gap-2">
          {mode === "task" ? (
            <>
              <span className="font-mono text-[11px] text-muted-foreground">starts {mine}</span>
              {/* Fills the task for the recording take; nothing is sent until the human presses Enter. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => {
                  setText(ANDRII_SAMPLE_TASK);
                  setMsg(null);
                  box.current?.focus();
                }}
              >
                <Sparkles />
                Sample task
              </Button>
            </>
          ) : (
            <>
              {agents.length > 1 && (
                <select
                  aria-label="agent"
                  value={target ?? ""}
                  onChange={(e) => onTarget(e.target.value)}
                  className="h-7 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground outline-none"
                  style={{ color: target ? agentColor(target) : undefined }}
                >
                  {agents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.humanId} · {a.agentId}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                aria-pressed={urgent}
                onClick={() => setUrgent((u) => !u)}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
                  urgent ? "border-amber-500/60 bg-amber-500/10 text-amber-300" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                <Zap className="size-3" />
                Urgent
              </button>
            </>
          )}
          {msg && <span className="truncate text-[11px] text-muted-foreground">{msg}</span>}
          <Button type="submit" size="icon" className="ml-auto size-8" aria-label="Send" disabled={!canSend}>
            <SendHorizontal />
          </Button>
        </div>
      </div>
    </form>
  );
}
