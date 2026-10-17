import { useEffect, useState } from "react";
import { FileText, FlaskConical, GitBranch, Plus, Rss } from "lucide-react";
import { TERMINAL_AGENT_STATUSES } from "@hive/shared";
import { connectLive, createStore, resyncAfterReset, startMock, useHive } from "./store";
import { hub } from "./editor/yjs";
import { currentIntentOf, filesOfAgent, pendingBriefings, unresolvedConflicts } from "./state";
import { isMock, lanUrl, loadHumanId, saveHumanId } from "./env";
import { setMockSink } from "./api";
import { MOCK_LAN_URL } from "./mock";
import { Rail } from "./components/Rail";
import { ProjectPanel } from "./components/ProjectPanel";
import { ProjectActivity } from "./components/ProjectActivity";
import { AgentCard } from "./components/AgentCard";
import { ChatBox, myAgentId } from "./components/ChatBox";
import { Feed } from "./components/Feed";
import { HistoryTab } from "./components/HistoryTab";
import { CulpritTab } from "./components/CulpritTab";
import { ContractsTab } from "./components/ContractsTab";
import { StartAgentDialog } from "./components/StartAgentDialog";
import { SpawnDemoButton } from "./components/SpawnDemoButton";
import { EditorPane, defaultPath, type CenterView } from "./editor/EditorPane";
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
  // The right column never switches on its own: the user picks the tab.
  const [main, setMain] = useState<Main>("agents");
  const [sub, setSub] = useState<Sub>("feed");
  const [dialog, setDialog] = useState(false);
  const [showLlm, setShowLlm] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const path = defaultPath(state.files, selected);
  // Center column: editor or store preview; P toggles unless the user is typing somewhere.
  const [view, setView] = useState<CenterView>("code");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "p" && e.key !== "P") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || t.closest?.(".cm-editor"))) return;
      e.preventDefault();
      setView((v) => (v === "code" ? "preview" : "code"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Agent the bottom chat box talks to: the one clicked in the list, else your own, else the first working one.
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

  const onHumanId = (id: string) => {
    setHumanId(id);
    saveHumanId(id);
  };

  // Your own agent is running: the demo button must not reset the project under it.
  const agentsRunning = state.agents.some((a) => a.agentId === myAgentId(humanId) && !TERMINAL_AGENT_STATUSES.includes(a.status));
  const conflicts = unresolvedConflicts(state).length;
  const pending = pendingBriefings(state).length;
  const searching = Boolean(state.culprit && !state.culprit.report);
  // Red count on the Activity tab while Agents is selected: things worth a look over there.
  const alerts = conflicts + (searching ? 1 : 0);
  const showAll = () => {
    setMain("activity");
    setSub("feed");
  };

  return (
    <TooltipProvider>
      <div className="grid h-full grid-cols-[56px_minmax(0,1fr)] bg-background">
        <Rail humanId={humanId} onHumanId={onHumanId} qrUrl={mock ? MOCK_LAN_URL : lanUrl("/m")} />
        <div className="grid min-h-0 min-w-0 grid-cols-[240px_minmax(0,1fr)_400px]">
          <ProjectPanel files={state.files} intents={state.intents} selected={path} onSelect={setSelected} mode={state.mode} />
          <EditorPane state={state} mock={mock} humanId={humanId} path={path} onSelect={setSelected} lastEdit={lastEdit} view={view} onView={setView} />
          <section className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden border-l border-border bg-panel">
            <Tabs value={main} onValueChange={(v) => setMain(v === "activity" ? "activity" : "agents")} className="min-h-0 min-w-0">
              <TabsList className="h-11 px-3">
                <TabsTrigger value="agents" className="h-11" onClick={() => setMain("agents")}>
                  Agents
                </TabsTrigger>
                <TabsTrigger value="activity" className="h-11" onClick={() => setMain("activity")}>
                  Activity
                  {main === "agents" && alerts > 0 && (
                    <Badge variant="destructive" data-testid="activity-alerts">
                      {alerts}
                    </Badge>
                  )}
                  {pending > 0 && <Badge variant="warning">{pending} unacked</Badge>}
                </TabsTrigger>
                {/* Labelled primary action first; "New agent" is the compact "+" (also reachable from the empty state and the chat box). */}
                <span className="ml-auto" />
                <SpawnDemoButton size="sm" className="shrink-0" agentsRunning={agentsRunning} />
                <Button variant="outline" size="icon" className="ml-1.5 size-7 shrink-0" title="New agent" aria-label="New agent" onClick={() => setDialog(true)}>
                  <Plus />
                </Button>
              </TabsList>

              <TabsContent value="agents" className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]">
                <ScrollArea className="h-full">
                  <div className="flex flex-col gap-2 p-3" aria-label="agents">
                    {state.agents.length === 0 && (
                      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center" data-testid="empty-agents">
                        <div className="text-[13px] text-muted-foreground">No agents yet.</div>
                        <SpawnDemoButton size="lg" agentsRunning={agentsRunning} />
                        <div className="text-xs text-muted-foreground">Starts Alex (order.ts) and Nika (format.ts)</div>
                        <Button variant="outline" size="sm" onClick={() => setDialog(true)}>
                          <Plus />
                          New agent
                        </Button>
                      </div>
                    )}
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
                      onShowAll={showAll}
                      onOpenCulprit={() => {
                        setMain("activity");
                        setSub("culprit");
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
                      {searching && <Badge variant="warning">running</Badge>}
                    </TabsTrigger>
                    <TabsTrigger value="contracts" onClick={() => setSub("contracts")}>
                      <FileText />
                      Contracts
                      {conflicts > 0 ? <Badge variant="destructive">{conflicts} conflict</Badge> : <span className="font-mono text-[11px] text-muted-foreground">{state.intents.length}</span>}
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
                    <CulpritTab grid={state.culprit} tests={state.tests} lastReport={state.lastReport} />
                  </TabsContent>
                  <TabsContent value="contracts" className="min-h-0">
                    <ContractsTab intents={state.intents} conflictsOf={state.conflictsOf} humanId={humanId} />
                  </TabsContent>
                </Tabs>
              </TabsContent>
            </Tabs>
          </section>
        </div>
        {dialog && <StartAgentDialog humanId={humanId} onClose={() => setDialog(false)} />}
      </div>
    </TooltipProvider>
  );
}
