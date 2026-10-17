import { useEffect, useRef, useState } from "react";
import { FileText, FlaskConical, GitBranch, Rss } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { TooltipProvider } from "./components/ui/tooltip";
import { Badge } from "./components/ui/badge";

type Tab = "feed" | "history" | "culprit" | "contracts";
const TABS: Tab[] = ["feed", "history", "culprit", "contracts"];

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
    <TooltipProvider>
      <div className="grid h-full grid-rows-[48px_1fr]">
        <TopBar state={state} humanId={humanId} onHumanId={onHumanId} onStartAgent={() => setDialog(true)} qrUrl={mock ? MOCK_LAN_URL : lanUrl("/m")} />
        <div className="grid min-h-0 grid-cols-[60%_40%]">
          <EditorPane state={state} mock={mock} humanId={humanId} />
          <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="grid max-h-[44vh] grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2 overflow-auto border-b border-border p-2" aria-label="agents">
              {state.agents.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No agents yet. Start one from the top bar, or open ?mock=1 for the scripted demo.</div>}
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
            {/* Controlled tabs; onClick on each trigger keeps plain click events (and fireEvent.click) working. */}
            <Tabs value={tab} onValueChange={(v) => setTab(TABS.includes(v as Tab) ? (v as Tab) : "feed")} className="min-h-0">
              <TabsList>
                <TabsTrigger value="feed" onClick={() => setTab("feed")}>
                  <Rss />
                  Feed
                  {pending > 0 && <Badge variant="warning">{pending} unacked</Badge>}
                </TabsTrigger>
                <TabsTrigger value="history" onClick={() => setTab("history")}>
                  <GitBranch />
                  History
                  <span className="font-mono text-[11px] text-zinc-500">{state.history.length}</span>
                </TabsTrigger>
                <TabsTrigger value="culprit" onClick={() => setTab("culprit")}>
                  <FlaskConical />
                  Culprit
                  {state.tests.running && <Badge variant="warning">running</Badge>}
                </TabsTrigger>
                <TabsTrigger value="contracts" onClick={() => setTab("contracts")}>
                  <FileText />
                  Contracts
                  {conflicts > 0 ? <Badge variant="warning">{conflicts} conflict</Badge> : <span className="font-mono text-[11px] text-zinc-500">{state.intents.length}</span>}
                </TabsTrigger>
                <label className="ml-auto flex items-center gap-1.5 whitespace-nowrap pr-1 text-[11px] text-zinc-500">
                  <input type="checkbox" className="size-3 accent-zinc-400" checked={showLlm} onChange={(e) => setShowLlm(e.target.checked)} /> llm calls
                </label>
              </TabsList>
              <TabsContent value="feed" className="min-h-0">
                <Feed state={state} showLlm={showLlm} />
              </TabsContent>
              <TabsContent value="history" className="min-h-0">
                <HistoryTab history={state.history} />
              </TabsContent>
              <TabsContent value="culprit" className="min-h-0">
                <CulpritTab grid={state.culprit} tests={state.tests} />
              </TabsContent>
              <TabsContent value="contracts" className="min-h-0">
                <ContractsTab intents={state.intents} conflictsOf={state.conflictsOf} humanId={humanId} />
              </TabsContent>
            </Tabs>
          </section>
        </div>
        {dialog && <StartAgentDialog humanId={humanId} onClose={() => setDialog(false)} />}
      </div>
    </TooltipProvider>
  );
}
