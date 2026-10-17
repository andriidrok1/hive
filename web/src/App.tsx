import { useEffect, useRef, useState } from "react";
import { FileText, FlaskConical, GitBranch, Plus, Rss } from "lucide-react";
import { connectLive, createStore, resyncAfterReset, startMock, useHive } from "./store";
import { hub } from "./editor/yjs";
import { currentIntentOf, filesOfAgent, pendingBriefings, unresolvedConflicts } from "./state";
import { ProjectActivity } from "./components/ProjectActivity";
import { ChatBox, myAgentId } from "./components/ChatBox";
import { spawnDemoAgents } from "./demoPresets";
import { TERMINAL_AGENT_STATUSES } from "@hive/shared";
import { Users } from "lucide-react";
import { isMock, lanUrl, loadHumanId, saveHumanId } from "./env";
import { setMockSink } from "./api";
import { MOCK_LAN_URL } from "./mock";
import { TopBar } from "./components/TopBar";
import { Rail } from "./components/Rail";
import { ProjectPanel } from "./components/ProjectPanel";
import { AgentCard } from "./components/AgentCard";
import { Feed } from "./components/Feed";
import { HistoryTab } from "./components/HistoryTab";
import { CulpritTab } from "./components/CulpritTab";
import { ContractsTab } from "./components/ContractsTab";
import { StartAgentDialog } from "./components/StartAgentDialog";
import { EditorPane, defaultPath } from "./editor/EditorPane";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { TooltipProvider } from "./components/ui/tooltip";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ScrollArea } from "./components/ui/scroll-area";

type Main = "agents" | "activity";
type Sub = "feed" | "history" | "culprit" | "contracts";
const SUBS: Sub[] = ["feed", "history", "culprit", "contracts"];

export function App({ mockStepMs }: { mockStepMs?: number } = {}) {
  const mock = isMock();
  const [store] = useState(() => createStore());
  const state = useHive(store);
  const [humanId, setHumanId] = useState(loadHumanId);
  const [main, setMain] = useState<Main>("agents");
  const [sub, setSub] = useState<Sub>("feed");
  const [dialog, setDialog] = useState(false);
  const [showLlm, setShowLlm] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const path = defaultPath(state.files, selected);
  // Agent the bottom chat box talks to: the one clicked in the list, else the first working one.
  const [chatAgent, setChatAgent] = useState<string | null>(null);
  const chatTarget =
    (chatAgent && state.agents.some((a) => a.agentId === chatAgent) ? chatAgent : null) ??
    state.agents.find((a) => a.agentId === myAgentId(humanId) && !TERMINAL_AGENT_STATUSES.includes(a.status))?.agentId ??
    state.agents.find((a) => a.status === "thinking" || a.status === "tool")?.agentId ??
    state.agents[0]?.agentId ??
    null;
  // Latest edit from the feed: colours the live-writing flash in the editor.
  const lastEditEvent = state.events.find((e) => e.type === "edit_applied");
  const lastEdit = lastEditEvent && lastEditEvent.type === "edit_applied" ? { rev: lastEditEvent.rev, agentId: lastEditEvent.agentId, path: lastEditEvent.path } : undefined;
  // Coarse clock for elapsed / "2m ago" labels.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

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

  // Judges should not miss the culprit search: jump to it when one starts.
  const lastSearch = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = state.culprit?.searchId;
    if (id && id !== lastSearch.current) {
      lastSearch.current = id;
      setMain("activity");
      setSub("culprit");
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
      <div className="grid h-full grid-cols-[56px_minmax(0,1fr)] bg-background">
        <Rail humanId={humanId} />
        <div className="grid min-h-0 min-w-0 grid-rows-[56px_1fr]">
          <TopBar state={state} humanId={humanId} onHumanId={onHumanId} qrUrl={mock ? MOCK_LAN_URL : lanUrl("/m")} />
          <div className="grid min-h-0 min-w-0 grid-cols-[240px_minmax(0,1fr)_400px]">
            <ProjectPanel files={state.files} intents={state.intents} selected={path} onSelect={setSelected} />
            <EditorPane state={state} mock={mock} humanId={humanId} path={path} onSelect={setSelected} lastEdit={lastEdit} />
            <section className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden border-l border-border bg-panel">
              <Tabs value={main} onValueChange={(v) => setMain(v === "activity" ? "activity" : "agents")} className="min-h-0 min-w-0">
                <TabsList className="h-11 px-3">
                  <TabsTrigger value="agents" className="h-11" onClick={() => setMain("agents")}>
                    Agents
                  </TabsTrigger>
                  <TabsTrigger value="activity" className="h-11" onClick={() => setMain("activity")}>
                    Activity
                    {pending > 0 && <Badge variant="warning">{pending} unacked</Badge>}
                    {conflicts > 0 && <Badge variant="destructive">{conflicts} conflict</Badge>}
                  </TabsTrigger>
                  <Button variant="outline" size="sm" className="ml-auto" onClick={() => setDialog(true)}>
                    <Plus />
                    New agent
                  </Button>
                  <Button variant="outline" size="sm" className="ml-1.5" title="Start agent-alex and agent-nika with the demo tasks" onClick={() => void spawnDemoAgents()}>
                    <Users />
                    Spawn demo agents
                  </Button>
                </TabsList>

                <TabsContent value="agents" className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]">
                  <ScrollArea className="h-full">
                    <div className="flex flex-col gap-2 p-3" aria-label="agents">
                      {state.agents.length === 0 && <div className="px-1 py-3 text-xs text-muted-foreground">No agents yet. Start one with New agent, or open ?mock=1 for the scripted demo.</div>}
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
                          meta={state.agentMeta[a.agentId]}
                          files={filesOfAgent(state, a.agentId)}
                          testsRunning={Boolean(state.tests.running)}
                          now={now}
                          selected={a.agentId === chatTarget}
                          onSelect={() => setChatAgent(a.agentId)}
                        />
                      ))}
                      <ProjectActivity
                        state={state}
                        now={now}
                        onShowAll={() => {
                          setMain("activity");
                          setSub("feed");
                        }}
                      />
                    </div>
                  </ScrollArea>
                  <ChatBox agents={state.agents} target={chatTarget} onTarget={setChatAgent} humanId={humanId} />
                </TabsContent>

                <TabsContent value="activity" className="min-h-0 min-w-0">
                  {/* Controlled sub-tabs; onClick keeps plain click events (and fireEvent.click) working. */}
                  <Tabs value={sub} onValueChange={(v) => setSub(SUBS.includes(v as Sub) ? (v as Sub) : "feed")} className="h-full min-h-0 min-w-0">
                    <TabsList className="h-9 px-2">
                      <TabsTrigger value="feed" onClick={() => setSub("feed")}>
                        <Rss />
                        Feed
                      </TabsTrigger>
                      <TabsTrigger value="history" onClick={() => setSub("history")}>
                        <GitBranch />
                        History
                        <span className="font-mono text-[11px] text-muted-foreground">{state.history.length}</span>
                      </TabsTrigger>
                      <TabsTrigger value="culprit" onClick={() => setSub("culprit")}>
                        <FlaskConical />
                        Culprit
                        {state.tests.running && <Badge variant="warning">running</Badge>}
                      </TabsTrigger>
                      <TabsTrigger value="contracts" onClick={() => setSub("contracts")}>
                        <FileText />
                        Contracts
                        <span className="font-mono text-[11px] text-muted-foreground">{state.intents.length}</span>
                      </TabsTrigger>
                      <label className="ml-auto flex items-center gap-1.5 whitespace-nowrap pr-1 text-[11px] text-muted-foreground">
                        <input type="checkbox" className="size-3 accent-violet-400" checked={showLlm} onChange={(e) => setShowLlm(e.target.checked)} /> llm calls
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
                </TabsContent>
              </Tabs>
            </section>
          </div>
        </div>
        {dialog && <StartAgentDialog humanId={humanId} onClose={() => setDialog(false)} />}
      </div>
    </TooltipProvider>
  );
}
