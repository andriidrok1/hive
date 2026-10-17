import type { Intent } from "@hive/shared";
import { intentRanges } from "./ranges";

// ?mock=1 editor: a plain <pre> with the same intent decorations as CodeMirror, no sockets.
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
        return (
          <span key={ln}>
            {starting.map((r) => (
              <span key={r.intent.id} className="intent-label" style={{ ["--c" as string]: r.color }}>
                <span className="pill">{r.intent.id}</span>
                {r.label}
              </span>
            ))}
            <span className={`ln${top ? " hl" : ""}`} style={top ? { ["--c" as string]: top.color } : undefined}>
              <span className="n">{ln}</span>
              {text}
            </span>
          </span>
        );
      })}
    </pre>
  );
}
