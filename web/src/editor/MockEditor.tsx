import { useEffect, useRef, useState } from "react";
import type { Intent, IntentId } from "@hive/shared";
import { agentColor } from "../state";
import { intentRanges } from "./ranges";
import { FLASH_MS, changedLines } from "./diff";

export interface LastEdit {
  rev: number;
  agentId: string;
  path: string;
}

// ?mock=1 editor: a plain <pre> with the same intent decorations as CodeMirror, no sockets.
// Agents with an intent in progress get a fake remote cursor on the symbol's first line,
// the same pill the live editor shows from awareness ("masha is editing…"). When the content
// changes, the changed lines flash in the editing agent's colour for 1.5 s.
export function MockEditor({ content, intents, earlier = {}, lastEdit }: { content: string; intents: Intent[]; earlier?: Record<IntentId, IntentId[]>; lastEdit?: LastEdit }) {
  const ranges = intentRanges(intents, content, null, earlier);
  const lines = content.split("\n");
  const prev = useRef(content);
  const [flash, setFlash] = useState<{ lines: number[]; color: string } | null>(null);
  useEffect(() => {
    if (prev.current === content) return;
    const changed = changedLines(prev.current, content);
    prev.current = content;
    if (changed.length === 0) return;
    setFlash({ lines: changed, color: lastEdit ? agentColor(lastEdit.agentId) : "#8b90a3" });
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [content, lastEdit]);

  return (
    <pre className="mockpre" data-testid="mock-editor">
      {lines.map((text, idx) => {
        const ln = idx + 1;
        const covering = ranges.filter((r) => ln >= r.startLine && ln <= r.endLine);
        const top = covering[covering.length - 1];
        const starting = ranges.filter((r) => r.startLine === ln);
        const cursors = starting.filter((r) => r.intent.status === "in_progress");
        const flashing = flash?.lines.includes(ln) ? flash.color : null;
        return (
          <span key={ln}>
            {starting.map((r) => (
              <span
                key={r.intent.id}
                className="intent-label"
                style={{ ["--c" as string]: r.color }}
                title={r.earlier.length ? `earlier intents on ${r.intent.target.symbol}: ${r.earlier.join(", ")}` : undefined}
                data-testid={`label-${r.intent.id}`}
              >
                <span className="pill">{r.intent.id}</span>
                <span className="what">{r.label}</span>
              </span>
            ))}
            <span
              className={`ln${top ? " hl" : ""}${flashing ? " flash" : ""}`}
              style={{ ...(top ? { ["--c" as string]: top.color } : {}), ...(flashing ? { ["--flash" as string]: flashing } : {}) }}
              data-flash={flashing ? "1" : undefined}
            >
              <span className="n">{ln}</span>
              {text}
              {cursors.map((r) => (
                <span key={r.intent.id} className="cursor" style={{ ["--c" as string]: agentColor(r.intent.agentId) }} aria-label={`${r.intent.humanId} is editing`}>
                  <span className="cursor-pill">
                    <i />
                    {r.intent.humanId}
                    <em>is editing…</em>
                  </span>
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </pre>
  );
}
