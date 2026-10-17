import { useState } from "react";
import type { ChangeSet } from "@hive/shared";
import { agentColor } from "../state";

export function HistoryTab({ history }: { history: ChangeSet[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (history.length === 0) return <div className="editor-wait">No finished change sets yet. Each finished intent becomes a version here.</div>;
  const items = [...history].reverse();
  return (
    <div className="history">
      {items.map((cs, idx) => (
        <div key={cs.id} className="version" style={{ ["--c" as string]: agentColor(cs.agentId) }} onClick={() => setOpen(open === cs.id ? null : cs.id)}>
          <div className="row">
            <span className="muted mono" style={{ fontSize: 12 }}>
              v{items.length - idx}
            </span>
            <span className="id">{cs.id}</span>
            <span style={{ color: agentColor(cs.agentId), fontWeight: 600 }}>{cs.humanId}</span>
            <span className="muted mono" style={{ fontSize: 12 }}>
              {cs.agentId}
            </span>
            <span className="plus">+{cs.added}</span>
            <span className="minus">−{cs.removed}</span>
            <span className="muted mono" style={{ fontSize: 12, marginLeft: "auto" }}>
              rev {cs.baseRev}→{cs.endRev}
            </span>
          </div>
          <div>{cs.what}</div>
          <div className="files">{cs.files.join(", ")}</div>
          {open === cs.id && <Patch text={cs.patch} />}
        </div>
      ))}
    </div>
  );
}

export function Patch({ text }: { text: string }) {
  return (
    <pre className="patch">
      {text.split("\n").map((l, i) => (
        <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "ctx"}>
          {l || " "}
        </span>
      ))}
    </pre>
  );
}
