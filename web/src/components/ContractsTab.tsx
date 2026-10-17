import { useState } from "react";
import type { Intent, IntentConflict } from "@hive/shared";
import { agentColor, intentColor } from "../state";
import { resolveConflict, setIntentOutput } from "../api";

interface Props {
  intents: Intent[];
  conflictsOf: Record<string, IntentConflict[]>;
  humanId: string;
  big?: boolean; // phone layout
}

export function ContractsTab({ intents, conflictsOf, humanId, big = false }: Props) {
  if (intents.length === 0) return <div className="editor-wait">No intents yet. Agents declare what they will change and what it will return before touching code.</div>;
  const items = [...intents].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="contracts">
      {items.map((i) => (
        <ContractCard key={i.id} intent={i} conflicts={conflictsOf[i.id] ?? []} humanId={humanId} big={big} />
      ))}
    </div>
  );
}

function ContractCard({ intent, conflicts, humanId, big }: { intent: Intent; conflicts: IntentConflict[]; humanId: string; big: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(intent.output);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const color = intentColor(intent.status, intent.agentId);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await setIntentOutput(intent.id, humanId, draft.trim());
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (keep: string, cancel: string) => {
    setBusy(true);
    setErr(null);
    try {
      await resolveConflict(humanId, keep, cancel);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contract" style={{ ["--c" as string]: color }} data-testid={`contract-${intent.id}`}>
      <div className="row">
        <span className="id">{intent.id}</span>
        <span style={{ color: agentColor(intent.agentId), fontWeight: 600 }}>{intent.humanId}</span>
        <span className="target">
          {intent.action} {intent.target.file} · {intent.target.symbol}
        </span>
        <span className="status-pill" style={{ color }}>
          {intent.status}
        </span>
      </div>
      <div>{intent.what}</div>
      {intent.input && (
        <div className="target">
          in: {intent.input}
        </div>
      )}
      {editing ? (
        <>
          <textarea aria-label={`output of ${intent.id}`} rows={big ? 5 : 3} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="buttons">
            <button className={big ? "primary" : "small primary"} disabled={busy || draft.trim().length < 10} onClick={() => void save()}>
              Save contract
            </button>
            <button
              className={big ? "" : "small"}
              onClick={() => {
                setEditing(false);
                setDraft(intent.output);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="output">
            <b>returns</b>
            {intent.output}
          </div>
          {intent.check && <div className="target">check: {intent.check}</div>}
          <div className="buttons">
            <button className={big ? "" : "small"} onClick={() => setEditing(true)} disabled={busy}>
              Edit output
            </button>
            {intent.status === "conflict" &&
              conflicts.map((c) => (
                <span key={c.intentId} className="buttons">
                  <button className={big ? "primary" : "small primary"} disabled={busy} onClick={() => void resolve(intent.id, c.intentId)}>
                    Keep {intent.id}, cancel {c.intentId}
                  </button>
                  <button className={big ? "" : "small"} disabled={busy} onClick={() => void resolve(c.intentId, intent.id)}>
                    Keep {c.intentId}, cancel {intent.id}
                  </button>
                </span>
              ))}
          </div>
          {intent.status === "conflict" &&
            conflicts.map((c) => (
              <div key={c.intentId} className="conflict">
                {c.kind} with {c.intentId}: {c.reason}
              </div>
            ))}
        </>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  );
}
