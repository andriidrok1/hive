import type { Intent, IntentId, IntentStatus } from "@hive/shared";
import { agentColor } from "../state";
import { VERIFIED_LINGER_MS, useLingeringVerified, visibleIntents, type VisibleIntent } from "../intentsView";
import { Badge } from "../components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

export { VERIFIED_LINGER_MS };

// Who is in this file right now: one row per agent and symbol (latest active intent, verified ones linger).
export function presenceRows(intents: Intent[], openPath: string | null, verifiedAt: Record<IntentId, number>, now: number): VisibleIntent[] {
  const lingering = new Set(Object.entries(verifiedAt).filter(([, at]) => now - at < VERIFIED_LINGER_MS).map(([id]) => id));
  return visibleIntents(intents, openPath, lingering);
}

export function presenceFor(intents: Intent[], openPath: string | null, verifiedAt: Record<IntentId, number>, now: number): Intent[] {
  return presenceRows(intents, openPath, verifiedAt, now).map((v) => v.intent);
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

export function PresenceStrip({ intents, openPath }: { intents: Intent[]; openPath: string | null; now?: number }) {
  const lingering = useLingeringVerified(intents);
  const rows = visibleIntents(intents, openPath, lingering);

  return (
    <div className="flex min-h-7 max-h-14 flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden border-b border-border px-3 py-1 text-xs" aria-label="presence">
      {rows.length === 0 ? (
        <span className="text-muted-foreground">No one else is working in this file.</span>
      ) : (
        rows.map(({ intent: i, earlier }) => {
          const b = badgeFor(i.status);
          return (
            <span key={i.id} className="flex min-w-0 items-center gap-2" data-testid={`presence-${i.id}`}>
              <span className="size-2 shrink-0 rounded-full" style={{ background: agentColor(i.agentId) }} aria-hidden />
              <span className="font-mono text-foreground">{i.id}</span>
              <span className="whitespace-nowrap text-foreground/90">
                {i.agentId} ({i.humanId}) is working on <span className="font-mono">{i.target.symbol}</span>
                <span className="text-muted-foreground">: {i.what}</span>
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
              {earlier.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground" data-testid={`earlier-${i.id}`}>
                      +{earlier.length} earlier
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <div className="font-mono text-[11px]">earlier intents on {i.target.symbol}: {earlier.join(", ")}</div>
                  </TooltipContent>
                </Tooltip>
              )}
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
