import { useEffect, useRef, useState } from "react";
import { connectLive, createStore, resyncAfterReset, startMock, useHive } from "./store";
import { hub } from "./editor/yjs";
import { currentIntentOf, pendingBriefings, unresolvedConflicts } from "./state";
import { isMock, lanUrl, loadHumanId, saveHumanId } from "./env";
import { setMockSink } from "./api";
import { MOCK_LAN_URL } from "./mock";
import { TopBar } from "./components/TopBar";
import { AgentCard } from "./components/AgentCard";
import { Feed } from "./components/Feed";
import { HistoryTab } from "./components/HistoryTab";
import { CulpritTab } from "./components/CulpritTab";
import { ContractsTab } from "./components/ContractsTab";
import { StartAgentDialog } from "./components/StartAgentDialog";
import { EditorPane } from "./editor/EditorPane";

type Tab = "feed" | "history" | "culprit" | "contracts";

export function App({ mockStepMs }: { mockStepMs?: number } = {}) {
  const mock = isMock();
  const [store] = useState(() => createStore());
  const state = useHive(store);
  const [humanId, setHumanId] = useState(loadHumanId);
  const [tab, setTab] = useState<Tab>("feed");
  const [dialog, setDialog] = useState(false);
  const [showLlm, setShowLlm] = useState(false);

  useEffect(() => {
    if (mock) {
      setMockSink((b) => store.emit(b));
      const stop = startMock(store, mockStepMs);
      return () => {
        stop();
        setMockSink(null);
      };
    }
    const disconnect = connectLive(store);
    // Server reset: the Yjs hub replaces its doc (close code 4000); the feed state starts over too.
    const offReset = hub.onReset(() => void resyncAfterReset(store));
    return () => {
      disconnect();
      offReset();
    };
  }, [store, mock, mockStepMs]);

  // Judges should not miss the culprit search: jump to the tab when one starts.
  const lastSearch = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = state.culprit?.searchId;
    if (id && id !== lastSearch.current) {
      lastSearch.current = id;
      setTab("culprit");
    }
  }, [state.culprit?.searchId]);

  const onHumanId = (id: string) => {
    setHumanId(id);
    saveHumanId(id);
  };

  const conflicts = unresolvedConflicts(state).length;
  const pending = pendingBriefings(state).length;

  return (
    <div className="app">
      <TopBar state={state} humanId={humanId} onHumanId={onHumanId} onStartAgent={() => setDialog(true)} qrUrl={mock ? MOCK_LAN_URL : lanUrl("/m")} />
      <div className="main">
        <EditorPane state={state} mock={mock} humanId={humanId} />
        <section className="right">
          <div className="agents" aria-label="agents">
            {state.agents.length === 0 && <div className="empty">No agents yet. Start one from the top bar, or open ?mock=1 for the scripted demo.</div>}
            {state.agents.map((a) => (
              <AgentCard
                key={a.agentId}
                agentId={a.agentId}
                humanId={a.humanId}
                status={a.status}
                control={a.control}
                task={a.task}
                intent={currentIntentOf(state, a.agentId)}
                actions={state.actions[a.agentId] ?? []}
                viewer={humanId}
              />
            ))}
          </div>
          <div className="tabs">
            <div className="tabbar" role="tablist">
              <button role="tab" aria-selected={tab === "feed"} className={tab === "feed" ? "active" : ""} onClick={() => setTab("feed")}>
                Feed
                {pending > 0 && <span className="count alert">{pending} unacked</span>}
              </button>
              <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
                History<span className="count">{state.history.length}</span>
              </button>
              <button role="tab" aria-selected={tab === "culprit"} className={tab === "culprit" ? "active" : ""} onClick={() => setTab("culprit")}>
                Culprit
                {state.tests.running && <span className="count">running</span>}
              </button>
              <button role="tab" aria-selected={tab === "contracts"} className={tab === "contracts" ? "active" : ""} onClick={() => setTab("contracts")}>
                Contracts
                {conflicts > 0 ? <span className="count alert">{conflicts} conflict</span> : <span className="count">{state.intents.length}</span>}
              </button>
            </div>
            <div className="tabbody">
              {tab === "feed" && (
                <>
                  <div style={{ padding: "6px 12px 0", textAlign: "right" }}>
                    <label className="dim" style={{ fontSize: 12 }}>
                      <input type="checkbox" checked={showLlm} onChange={(e) => setShowLlm(e.target.checked)} /> show llm calls
                    </label>
                  </div>
                  <Feed state={state} showLlm={showLlm} />
                </>
              )}
              {tab === "history" && <HistoryTab history={state.history} />}
              {tab === "culprit" && <CulpritTab grid={state.culprit} tests={state.tests} />}
              {tab === "contracts" && <ContractsTab intents={state.intents} conflictsOf={state.conflictsOf} humanId={humanId} />}
            </div>
          </div>
        </section>
      </div>
      {dialog && <StartAgentDialog humanId={humanId} onClose={() => setDialog(false)} />}
    </div>
  );
}
