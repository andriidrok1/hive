import { useEffect, useState } from "react";
import { connectLive, createStore, startMock, useHive } from "./store";
import { isMock, loadHumanId, saveHumanId } from "./env";
import { sendNote, setMockSink } from "./api";
import { ContractsTab } from "./components/ContractsTab";

// /m: contracts with big edit buttons plus a note box. No editor.
export function Phone() {
  const mock = isMock();
  const [store] = useState(() => createStore());
  const state = useHive(store);
  const [humanId, setHumanId] = useState(loadHumanId);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (mock) {
      setMockSink((b) => store.emit(b));
      const stop = startMock(store);
      return () => {
        stop();
        setMockSink(null);
      };
    }
    return connectLive(store);
  }, [store, mock]);

  const target = to || state.agents[0]?.agentId || "";

  const send = async (urgent: boolean) => {
    if (!target || !text.trim()) return;
    setMsg(null);
    try {
      await sendNote(target, humanId, text.trim(), urgent);
      setText("");
      setMsg(`${urgent ? "Urgent note" : "Note"} sent to ${target}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="phone">
      <h1>
        Hive<span>.</span> <span className={`badge ${state.mode}`}>{state.mode}</span>{" "}
        <span className="muted" style={{ fontSize: 14 }}>
          rev {state.rev} · {state.connection}
        </span>
      </h1>
      <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        you
        <input
          value={humanId}
          onChange={(e) => {
            setHumanId(e.target.value);
            saveHumanId(e.target.value);
          }}
          style={{ flex: 1 }}
        />
      </label>

      <div className="notebox">
        <b>Note to an agent</b>
        <select value={target} onChange={(e) => setTo(e.target.value)} aria-label="agent">
          {state.agents.length === 0 && <option value="">no agents running</option>}
          {state.agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.agentId} ({a.humanId}, {a.status})
            </option>
          ))}
        </select>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Put tax in applyTax, not in calculateTotal" />
        <div className="buttons">
          <button className="primary" disabled={!target || !text.trim()} onClick={() => void send(false)}>
            Send note
          </button>
          <button className="danger" disabled={!target || !text.trim()} onClick={() => void send(true)}>
            Urgent
          </button>
        </div>
        {msg && <div className="muted">{msg}</div>}
      </div>

      <h2 style={{ margin: 0, fontSize: 20 }}>Contracts</h2>
      <ContractsTab intents={state.intents} conflictsOf={state.conflictsOf} humanId={humanId} big />
    </div>
  );
}
