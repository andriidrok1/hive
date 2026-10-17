import { Plus } from "lucide-react";
import type { UiState } from "../state";
import { Qr } from "./Qr";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Separator } from "./ui/separator";

interface Props {
  state: UiState;
  humanId: string;
  onHumanId: (id: string) => void;
  onStartAgent: () => void;
  qrUrl: string;
}

// Value element directly before the label element: App.mock.test reads it via previousElementSibling.
function Stat({ value, label, tone }: { value: number | string; label: string; tone?: "green" | "amber" | "red" }) {
  const color = tone === "green" ? "text-emerald-400" : tone === "amber" ? "text-amber-400" : tone === "red" ? "text-red-400" : "text-foreground";
  return (
    <div className="flex flex-col leading-none">
      <b className={`font-mono text-[15px] font-semibold tabular-nums ${color}`}>{value}</b>
      <small className="mt-1 text-[11px] text-muted-foreground">{label}</small>
    </div>
  );
}

function connectionVariant(c: UiState["connection"]): "success" | "warning" | "muted" | "secondary" {
  switch (c) {
    case "open":
      return "success";
    case "reconnecting":
      return "warning";
    case "mock":
      return "secondary";
    default:
      return "muted";
  }
}

export function TopBar({ state, humanId, onHumanId, onStartAgent, qrUrl }: Props) {
  const c = state.counters;
  return (
    <header className="flex h-12 items-center gap-4 border-b border-border bg-background px-4">
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-semibold tracking-tight">Hive</span>
        <Badge variant="outline" className="font-mono uppercase tracking-wide">
          {state.mode}
        </Badge>
      </div>
      <Separator orientation="vertical" className="h-5" />
      <div className="flex items-center gap-5">
        <Stat value={state.rev} label="rev" />
        <Stat value={state.lastGreen ? state.lastGreen.rev : "–"} label="last green" tone="green" />
        <Stat value={c.briefingsSent} label="briefings" />
        <Stat value={c.planChanges} label="plan changes" />
        <Stat value={c.conflictsCaught} label="conflicts before code" tone={c.conflictsCaught > 0 ? "amber" : undefined} />
        <Stat value={c.culpritSearches} label="culprit searches" tone={c.culpritSearches > 0 ? "red" : undefined} />
      </div>
      <div className="flex-1" />
      <Badge variant={connectionVariant(state.connection)}>{state.connection}</Badge>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        you
        <Input aria-label="your human id" value={humanId} onChange={(e) => onHumanId(e.target.value)} className="h-7 w-28 font-mono text-xs" />
      </label>
      <Button size="sm" onClick={onStartAgent}>
        <Plus />
        Start agent
      </Button>
      <Qr url={qrUrl} />
    </header>
  );
}
