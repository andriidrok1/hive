import type { UiState } from "../state";
import { Qr } from "./Qr";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";

interface Props {
  state: UiState;
  humanId: string;
  onHumanId: (id: string) => void;
  qrUrl: string;
}

// Value element directly before the label element: App.mock.test reads it via previousElementSibling.
function Stat({ value, label, tone }: { value: number | string; label: string; tone?: "green" | "amber" | "red" }) {
  const color = tone === "green" ? "text-emerald-400" : tone === "amber" ? "text-amber-400" : tone === "red" ? "text-red-400" : "text-foreground";
  return (
    <div className="flex items-baseline gap-1.5 leading-none">
      <b className={`font-mono text-[13px] font-semibold tabular-nums ${color}`}>{value}</b>
      <small className="text-[11px] text-muted-foreground">{label}</small>
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

// Slim header over the three panels: title, mode, project counters, connection, who you are, phone QR.
export function TopBar({ state, humanId, onHumanId, qrUrl }: Props) {
  const c = state.counters;
  return (
    <header className="flex h-14 items-center gap-4 border-b border-border bg-background px-5">
      <span className="text-[19px] font-semibold tracking-tight">Hive</span>
      <Badge variant="outline" className="font-mono uppercase tracking-wide">
        {state.mode}
      </Badge>
      <div className="ml-4 flex items-center gap-4">
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
      <Qr url={qrUrl} />
    </header>
  );
}
