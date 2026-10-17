import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import type { Intent, IntentConflict, IntentStatus } from "@hive/shared";
import { agentColor } from "../state";
import { resolveConflict, setIntentOutput } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { cn } from "../lib/utils";

interface Props {
  intents: Intent[];
  conflictsOf: Record<string, IntentConflict[]>;
  humanId: string;
  big?: boolean; // phone layout
}

export function statusBadge(s: IntentStatus): "success" | "warning" | "destructive" | "muted" | "secondary" | "outline" {
  switch (s) {
    case "verified":
      return "success";
    case "conflict":
      return "warning";
    case "failed":
      return "destructive";
    case "in_progress":
    case "done":
      return "secondary";
    case "cancelled":
      return "muted";
    default:
      return "outline";
  }
}

export function ContractsTab({ intents, conflictsOf, humanId, big = false }: Props) {
  if (intents.length === 0) return <div className="px-4 py-6 text-xs text-muted-foreground">No intents yet. Agents declare what they will change and what it will return before touching code.</div>;
  const items = [...intents].sort((a, b) => b.createdAt - a.createdAt);
  const list = (
    <div className={cn("flex flex-col gap-2", big ? "" : "p-3")}>
      {items.map((i) => (
        <ContractCard key={i.id} intent={i} conflicts={conflictsOf[i.id] ?? []} humanId={humanId} big={big} />
      ))}
    </div>
  );
  return big ? list : <ScrollArea className="h-full">{list}</ScrollArea>;
}

function ContractCard({ intent, conflicts, humanId, big }: { intent: Intent; conflicts: IntentConflict[]; humanId: string; big: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(intent.output);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const size = big ? "lg" : "sm"; // phone: 40px touch targets

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await setIntentOutput(intent.id, humanId, draft.trim());
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (keep: string, cancel: string) => {
    setBusy(true);
    setErr(null);
    try {
      await resolveConflict(humanId, keep, cancel);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={cn("gap-2 px-3 py-2.5", intent.status === "conflict" && "border-amber-500/50")} data-testid={`contract-${intent.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-medium">{intent.id}</span>
        <span className="inline-flex items-center gap-1.5 text-[13px]">
          <span className="size-1.5 rounded-full" style={{ background: agentColor(intent.agentId) }} />
          {intent.humanId}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {intent.action} {intent.target.file} · {intent.target.symbol}
        </span>
        <Badge variant={statusBadge(intent.status)} className="ml-auto font-mono">
          {intent.status}
        </Badge>
      </div>
      <div className={big ? "text-[15px]" : "text-[13px]"}>{intent.what}</div>
      {intent.input && <div className="font-mono text-xs text-muted-foreground">in: {intent.input}</div>}
      {editing ? (
        <>
          <Textarea aria-label={`output of ${intent.id}`} rows={big ? 5 : 3} value={draft} onChange={(e) => setDraft(e.target.value)} className={big ? "text-[15px]" : "font-mono text-xs"} />
          <div className="flex gap-1.5">
            <Button size={size} disabled={busy || draft.trim().length < 10} onClick={() => void save()}>
              <Check />
              Save contract
            </Button>
            <Button
              size={size}
              variant="outline"
              onClick={() => {
                setEditing(false);
                setDraft(intent.output);
              }}
            >
              <X />
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className={cn("rounded-md border border-border bg-muted/40 px-2.5 py-1.5 whitespace-pre-wrap", big ? "text-[15px]" : "text-[13px]")}>
            <span className="mr-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">returns</span>
            {intent.output}
          </div>
          {intent.check && <div className="truncate font-mono text-xs text-muted-foreground">check: {intent.check}</div>}
          <div className="flex flex-wrap gap-1.5">
            <Button size={size} variant="outline" onClick={() => setEditing(true)} disabled={busy}>
              <Pencil />
              Edit output
            </Button>
            {intent.status === "conflict" &&
              conflicts.map((c) => (
                <span key={c.intentId} className="contents">
                  <Button size={size} disabled={busy} onClick={() => void resolve(intent.id, c.intentId)}>
                    Keep {intent.id}, cancel {c.intentId}
                  </Button>
                  <Button size={size} variant="outline" disabled={busy} onClick={() => void resolve(c.intentId, intent.id)}>
                    Keep {c.intentId}, cancel {intent.id}
                  </Button>
                </span>
              ))}
          </div>
          {intent.status === "conflict" &&
            conflicts.map((c) => (
              <div key={c.intentId} className="text-xs text-amber-300">
                {c.kind} with {c.intentId}: {c.reason}
              </div>
            ))}
        </>
      )}
      {err && <div className="text-xs text-red-400">{err}</div>}
    </Card>
  );
}
