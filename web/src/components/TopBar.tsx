import type { UiState } from "../state";
import { Qr } from "./Qr";

interface Props {
  state: UiState;
  humanId: string;
  onHumanId: (id: string) => void;
  onStartAgent: () => void;
  qrUrl: string;
}

export function TopBar({ state, humanId, onHumanId, onStartAgent, qrUrl }: Props) {
  const c = state.counters;
  return (
    <header className="topbar">
      <div className="brand">
        Hive<span>.</span>
      </div>
      <span className={`badge ${state.mode}`}>{state.mode}</span>
      <div className="stat">
        <b>{state.rev}</b>
        <small>rev</small>
      </div>
      <div className="stat green">
        <b>{state.lastGreen ? state.lastGreen.rev : "–"}</b>
        <small>last green</small>
      </div>
      <div className="stat">
        <b>{c.briefingsSent}</b>
        <small>briefings</small>
      </div>
      <div className="stat hot">
        <b>{c.planChanges}</b>
        <small>plan changes</small>
      </div>
      <div className="stat hot">
        <b>{c.conflictsCaught}</b>
        <small>conflicts before code</small>
      </div>
      <div className="stat">
        <b>{c.culpritSearches}</b>
        <small>culprit searches</small>
      </div>
      <div className="spacer" />
      <span className={`conn ${state.connection}`}>{state.connection}</span>
      <label className="human">
        you
        <input aria-label="your human id" value={humanId} onChange={(e) => onHumanId(e.target.value)} />
      </label>
      <button className="primary" onClick={onStartAgent}>
        Start agent
      </button>
      <Qr url={qrUrl} />
    </header>
  );
}
