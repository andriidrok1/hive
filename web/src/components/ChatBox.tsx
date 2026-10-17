import { useState } from "react";
import { SendHorizontal, Zap } from "lucide-react";
import type { HiveState } from "@hive/shared";
import { sendNote } from "../api";
import { agentColor } from "../state";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

interface Props {
  agents: HiveState["agents"];
  target: string | null; // agentId
  onTarget: (agentId: string) => void;
  humanId: string;
}

// Bottom of the Agents column: "Tell <agent> what to do…" posts a Note (or an Urgent note) to the selected agent.
export function ChatBox({ agents, target, onTarget, humanId }: Props) {
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const agent = agents.find((a) => a.agentId === target);
  const name = agent?.humanId ?? target ?? "an agent";

  const send = async () => {
    if (!target || !text.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await sendNote(target, humanId, text.trim(), urgent);
      setText("");
      setMsg(`${urgent ? "Urgent note" : "Note"} sent to ${name}`);
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
      <div className={cn("rounded-lg border bg-background p-2 transition-colors", urgent ? "border-amber-500/60" : "border-border focus-within:border-violet/70")}>
        <textarea
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
          placeholder={target ? `Tell ${name} what to do…` : "Start an agent first"}
          disabled={!target}
          className="w-full resize-none bg-transparent px-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        <div className="mt-1 flex items-center gap-2">
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
          {msg && <span className="truncate text-[11px] text-muted-foreground">{msg}</span>}
          <Button type="submit" size="icon" className="ml-auto size-8" aria-label="Send" disabled={!target || !text.trim() || busy}>
            <SendHorizontal />
          </Button>
        </div>
      </div>
    </form>
  );
}
