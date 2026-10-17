import { useEffect, useRef, useState } from "react";
import type { Intent, SymbolInfo } from "@hive/shared";
import * as Y from "yjs";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { getShared } from "./yjs";
import { intentRanges, type IntentRange } from "./ranges";

// ---------- Intent decorations ----------

const setRanges = StateEffect.define<IntentRange[]>();

class LabelWidget extends WidgetType {
  constructor(
    private id: string,
    private text: string,
    private color: string,
  ) {
    super();
  }
  eq(other: LabelWidget): boolean {
    return other.id === this.id && other.text === this.text && other.color === this.color;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "intent-label";
    el.style.color = this.color;
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = this.id;
    el.append(pill, document.createTextNode(this.text));
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(doc: EditorState["doc"], ranges: IntentRange[]): DecorationSet {
  const out: { from: number; deco: Decoration }[] = [];
  for (const r of ranges) {
    const start = Math.max(1, Math.min(r.startLine, doc.lines));
    const end = Math.max(start, Math.min(r.endLine, doc.lines));
    out.push({
      from: doc.line(start).from,
      deco: Decoration.widget({ widget: new LabelWidget(r.intent.id, r.label, r.color), block: true, side: -1 }),
    });
    for (let ln = start; ln <= end; ln++) {
      out.push({
        from: doc.line(ln).from,
        deco: Decoration.line({ attributes: { style: `background: color-mix(in srgb, ${r.color} 12%, transparent); box-shadow: inset 3px 0 0 ${r.color}` } }),
      });
    }
  }
  return Decoration.set(
    out.map((o) => o.deco.range(o.from)),
    true,
  );
}

const intentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setRanges)) return buildDecorations(tr.state.doc, e.value);
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- Editor ----------

interface Props {
  path: string;
  humanId: string;
  intents: Intent[];
  symbols: SymbolInfo[] | null;
}

export default function LiveEditor({ path, humanId, intents, symbols }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [ytext, setYtext] = useState<Y.Text | null>(null);
  const [synced, setSynced] = useState(false);

  // Resolve the Y.Text for the path, waiting for the key to appear after sync.
  useEffect(() => {
    const { files, provider } = getShared(humanId);
    const pick = () => setYtext(files.get(path) ?? null);
    pick();
    files.observe(pick);
    const onSync = (s: boolean) => setSynced(s);
    provider.on("sync", onSync);
    setSynced(provider.synced);
    return () => {
      files.unobserve(pick);
      provider.off("sync", onSync);
    };
  }, [path, humanId]);

  useEffect(() => {
    if (!host.current || !ytext) return;
    const { provider } = getShared(humanId);
    const extensions: Extension[] = [
      basicSetup,
      javascript({ typescript: true }),
      oneDark,
      keymap.of(yUndoManagerKeymap),
      yCollab(ytext, provider.awareness),
      intentField,
      EditorView.lineWrapping,
    ];
    const view = new EditorView({ state: EditorState.create({ doc: ytext.toString(), extensions }), parent: host.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [ytext, humanId]);

  // Push intent ranges whenever intents, symbols or the document text change.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const apply = () => {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ effects: setRanges.of(intentRanges(intents, v.state.doc.toString(), symbols)) });
    };
    apply();
    if (!ytext) return;
    const onText = () => apply();
    ytext.observe(onText);
    return () => ytext.unobserve(onText);
  }, [intents, symbols, ytext]);

  if (!ytext) {
    return <div className="editor-wait">{synced ? `No shared document for ${path} yet.` : `Connecting to the shared project… (${path})`}</div>;
  }
  return <div ref={host} style={{ height: "100%" }} />;
}
