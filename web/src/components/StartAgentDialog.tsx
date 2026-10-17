import { useState } from "react";
import { startAgent } from "../api";

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
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>Start an agent</h2>
        <label>
          agent id
          <input value={agentId} onChange={(e) => setAgentId(e.target.value)} />
        </label>
        <label>
          human id
          <input value={human} onChange={(e) => setHuman(e.target.value)} />
        </label>
        <label>
          task
          <textarea autoFocus rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Add state tax support to checkout" />
        </label>
        {err && <div className="error">{err}</div>}
        <div className="buttons">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || task.trim().length < 5}>
            Start
          </button>
        </div>
      </form>
    </div>
  );
}
