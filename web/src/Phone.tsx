import { useEffect, useState } from "react";
import { MessageSquare, Zap } from "lucide-react";
import { connectLive, createStore, startMock, useHive } from "./store";
import { isMock, loadHumanId, saveHumanId } from "./env";
import { sendNote, setMockSink } from "./api";
import { ContractsTab } from "./components/ContractsTab";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { TooltipProvider } from "./components/ui/tooltip";

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
    <TooltipProvider>
      <div className="flex h-full flex-col gap-4 overflow-auto p-4 text-[15px]">
        <div className="flex items-center gap-2">
          <span className="text-[17px] font-semibold tracking-tight">Hive</span>
          <Badge variant="outline" className="font-mono uppercase tracking-wide">
            {state.mode}
          </Badge>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            rev {state.rev} · {state.connection}
          </span>
        </div>
        <label className="flex items-center gap-3 text-sm text-muted-foreground">
          you
          <Input
            className="h-10 font-mono text-[15px]"
            value={humanId}
            onChange={(e) => {
              setHumanId(e.target.value);
              saveHumanId(e.target.value);
            }}
          />
        </label>

        <Card className="gap-3 p-4">
          <div className="text-[15px] font-semibold">Note to an agent</div>
          <select
            value={target}
            onChange={(e) => setTo(e.target.value)}
            aria-label="agent"
            className="h-11 rounded-md border border-input bg-background px-3 font-mono text-[15px] text-foreground outline-none focus-visible:border-ring"
          >
            {state.agents.length === 0 && <option value="">no agents running</option>}
            {state.agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.agentId} ({a.humanId}, {a.status})
              </option>
            ))}
          </select>
          <Textarea rows={3} className="text-[15px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="Put tax in applyTax, not in calculateTotal" />
          <div className="flex gap-2">
            <Button size="lg" className="flex-1" disabled={!target || !text.trim()} onClick={() => void send(false)}>
              <MessageSquare />
              Send note
            </Button>
            <Button size="lg" variant="outline" className="flex-1" disabled={!target || !text.trim()} onClick={() => void send(true)}>
              <Zap />
              Urgent
            </Button>
          </div>
          {msg && <div className="text-sm text-muted-foreground">{msg}</div>}
        </Card>

        <div className="text-[15px] font-semibold">Contracts</div>
        <ContractsTab intents={state.intents} conflictsOf={state.conflictsOf} humanId={humanId} big />
      </div>
    </TooltipProvider>
  );
}
