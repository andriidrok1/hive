import type { Intent } from "@hive/shared";
import { agentColor } from "../state";
import { intentRanges } from "./ranges";

// ?mock=1 editor: a plain <pre> with the same intent decorations as CodeMirror, no sockets.
// Agents with an intent in progress get a fake remote cursor on the symbol's first line,
// the same pill the live editor shows from awareness ("masha is editing…").
export function MockEditor({ content, intents }: { content: string; intents: Intent[] }) {
  const ranges = intentRanges(intents, content, null);
  const lines = content.split("\n");
  return (
    <pre className="mockpre" data-testid="mock-editor">
      {lines.map((text, idx) => {
        const ln = idx + 1;
        const covering = ranges.filter((r) => ln >= r.startLine && ln <= r.endLine);
        const top = covering[covering.length - 1];
        const starting = ranges.filter((r) => r.startLine === ln);
        const cursors = starting.filter((r) => r.intent.status === "in_progress");
        return (
          <span key={ln}>
            {starting.map((r) => (
              <span key={r.intent.id} className="intent-label" style={{ ["--c" as string]: r.color }}>
                <span className="pill">{r.intent.id}</span>
                <span className="what">{r.label}</span>
              </span>
            ))}
            <span className={`ln${top ? " hl" : ""}`} style={top ? { ["--c" as string]: top.color } : undefined}>
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
