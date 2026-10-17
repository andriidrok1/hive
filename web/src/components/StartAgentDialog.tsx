import { useState } from "react";
import { startAgent } from "../api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export function StartAgentDialog({ humanId, onClose }: { humanId: string; onClose: () => void }) {
  const [agentId, setAgentId] = useState(`agent-${humanId || "me"}`);
  const [human, setHuman] = useState(humanId);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!agentId.trim() || !human.trim() || task.trim().length < 5) return;
    setBusy(true);
    setErr(null);
    try {
      await startAgent({ agentId: agentId.trim(), humanId: human.trim(), task: task.trim() });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Start an agent</DialogTitle>
            <DialogDescription>The agent reads, declares an intent, edits under it and finishes; Hive runs the tests.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              agent id
              <Input className="font-mono" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              human id
              <Input className="font-mono" value={human} onChange={(e) => setHuman(e.target.value)} />
            </label>
          </div>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            task
            <Textarea autoFocus rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Add state tax support to checkout" />
          </label>
          {err && <div className="text-xs text-red-400">{err}</div>}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || task.trim().length < 5}>
              Start
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
