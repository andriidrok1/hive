import { useEffect, useRef, useState } from "react";
import type { Intent, IntentId, IntentStatus } from "@hive/shared";
import { agentColor } from "../state";
import { Badge } from "../components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

export const VERIFIED_LINGER_MS = 4000;
const ACTIVE: readonly IntentStatus[] = ["approved", "in_progress", "conflict"];

// Who is in this file right now: active intents, plus ones that just turned verified for a few seconds.
export function presenceFor(intents: Intent[], openPath: string | null, verifiedAt: Record<IntentId, number>, now: number): Intent[] {
  if (!openPath) return [];
  return intents
    .filter((i) => i.target.file === openPath)
    .filter((i) => ACTIVE.includes(i.status) || (i.status === "verified" && now - (verifiedAt[i.id] ?? -Infinity) < VERIFIED_LINGER_MS))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function truncate(s: string, n = 90): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function badgeFor(status: IntentStatus): { variant: "warning" | "destructive" | "success" | "muted"; text: string } {
  switch (status) {
    case "conflict":
      return { variant: "destructive", text: "conflict" };
    case "verified":
      return { variant: "success", text: "verified" };
    case "in_progress":
      return { variant: "warning", text: "in progress" };
    default:
      return { variant: "muted", text: status };
  }
}

export function PresenceStrip({ intents, openPath, now }: { intents: Intent[]; openPath: string | null; now?: number }) {
  // Remember when each intent flipped to verified so it lingers briefly, then force one re-render to drop it.
  const [verifiedAt, setVerifiedAt] = useState<Record<IntentId, number>>({});
  const [, setTick] = useState(0);
  const seen = useRef<Record<IntentId, IntentStatus>>({});
  useEffect(() => {
    const flipped: IntentId[] = [];
    for (const i of intents) {
      if (i.status === "verified" && seen.current[i.id] !== undefined && seen.current[i.id] !== "verified") flipped.push(i.id);
      seen.current[i.id] = i.status;
    }
    if (flipped.length === 0) return;
    const t = Date.now();
    setVerifiedAt((v) => ({ ...v, ...Object.fromEntries(flipped.map((id) => [id, t])) }));
    const timer = setTimeout(() => setTick((n) => n + 1), VERIFIED_LINGER_MS + 50);
    return () => clearTimeout(timer);
  }, [intents]);

  const rows = presenceFor(intents, openPath, verifiedAt, now ?? Date.now());

  return (
    <div className="flex min-h-7 max-h-14 flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden border-b border-border px-3 py-1 text-xs" aria-label="presence">
      {rows.length === 0 ? (
        <span className="text-muted-foreground">No one else is working in this file.</span>
      ) : (
        rows.map((i) => {
          const b = badgeFor(i.status);
          return (
            <span key={i.id} className="flex min-w-0 items-center gap-2" data-testid={`presence-${i.id}`}>
              <span className="size-2 shrink-0 rounded-full" style={{ background: agentColor(i.agentId) }} aria-hidden />
              <span className="font-mono text-foreground">{i.id}</span>
              <span className="whitespace-nowrap text-foreground/90">
                {i.agentId} ({i.humanId}) is working on <span className="font-mono">{i.target.symbol}</span>
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 truncate text-muted-foreground">promised: {truncate(i.output)}</span>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start">
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {i.id} · {i.action} {i.target.symbol}
                  </div>
                  <div className="mt-1 text-foreground">{i.output}</div>
                  {i.check && <div className="mt-1 font-mono text-[11px] text-muted-foreground">check: {i.check}</div>}
                </TooltipContent>
              </Tooltip>
              <Badge variant={b.variant} className="font-mono">
                {b.text}
              </Badge>
            </span>
          );
        })
      )}
    </div>
  );
}
