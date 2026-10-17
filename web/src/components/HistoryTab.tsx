import { useState } from "react";
import { GitBranch } from "lucide-react";
import type { ChangeSet } from "@hive/shared";
import { agentColor } from "../state";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "../lib/utils";

export function HistoryTab({ history }: { history: ChangeSet[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (history.length === 0) return <div className="px-4 py-6 text-xs text-muted-foreground">No finished change sets yet. Each finished intent becomes a version here.</div>;
  const items = [...history].reverse();
  return (
    <ScrollArea className="h-full">
      <ul className="divide-y divide-border">
        {items.map((cs, idx) => (
          <li key={cs.id} className={cn("cursor-pointer px-4 py-2.5 hover:bg-muted/50", open === cs.id && "bg-muted/40")} onClick={() => setOpen(open === cs.id ? null : cs.id)}>
            <div className="flex items-baseline gap-2">
              <GitBranch className="size-3.5 self-center text-muted-foreground" />
              <span className="font-mono text-xs text-muted-foreground">v{items.length - idx}</span>
              <span className="font-mono text-[13px] font-medium">{cs.id}</span>
              <span className="inline-flex items-center gap-1.5 text-[13px]">
                <span className="size-1.5 rounded-full" style={{ background: agentColor(cs.agentId) }} />
                {cs.humanId}
              </span>
              <span className="font-mono text-xs text-emerald-400">+{cs.added}</span>
              <span className="font-mono text-xs text-red-400">−{cs.removed}</span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                rev {cs.baseRev}→{cs.endRev}
              </span>
            </div>
            <div className="mt-1 text-[13px]">{cs.what}</div>
            <div className="mt-0.5 font-mono text-xs text-muted-foreground">{cs.files.join(", ")}</div>
            {open === cs.id && (
              <div className="mt-2 rounded-md border border-border bg-background py-1">
                <Patch text={cs.patch} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

export function Patch({ text }: { text: string }) {
  return (
    <pre className="patch">
      {text.split("\n").map((l, i) => (
        <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "ctx"}>
          {l || " "}
        </span>
      ))}
    </pre>
  );
}
