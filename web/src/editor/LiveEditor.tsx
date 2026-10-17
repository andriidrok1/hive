import { useEffect, useRef, useState } from "react";
import type { Intent, SymbolInfo } from "@hive/shared";
import * as Y from "yjs";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { hub, useShared } from "./yjs";
import { intentRanges, type IntentRange } from "./ranges";
import { FLASH_MS, changedRange } from "./diff";
import { agentColor } from "../state";
import type { LastEdit } from "./MockEditor";

// ---------- Live-writing flash: the span a remote edit changed, in the agent's colour, fading out ----------

const addFlash = StateEffect.define<{ from: number; to: number; color: string }>();
const clearFlash = StateEffect.define<null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = tr.docChanged ? deco.map(tr.changes) : deco;
    for (const e of tr.effects) {
      if (e.is(clearFlash)) next = Decoration.none;
      if (e.is(addFlash) && e.value.to > e.value.from) {
        next = next.update({ add: [Decoration.mark({ class: "cm-flash", attributes: { style: `--flash: ${e.value.color}` } }).range(e.value.from, e.value.to)], sort: true });
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
    el.style.borderLeftColor = this.color;
    el.style.setProperty("--c", this.color);
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = this.id;
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = this.text;
    el.append(pill, what);
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
        // Thin bar in the agent colour only; no fill, so code stays readable.
        deco: Decoration.line({ attributes: { style: `box-shadow: inset 2px 0 0 ${r.color}` } }),
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
  lastEdit?: LastEdit; // latest edit_applied from the feed, to colour the flash by agent
}

export default function LiveEditor({ path, humanId, intents, symbols, lastEdit }: Props) {
  const lastEditRef = useRef<LastEdit | undefined>(lastEdit);
  lastEditRef.current = lastEdit;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [ytext, setYtext] = useState<Y.Text | null>(null);
  const [synced, setSynced] = useState(false);
  // Replaced wholesale after a server reset (close code 4000); every effect below re-binds to it.
  const shared = useShared();

  useEffect(() => hub.setUser(humanId), [humanId, shared]);

  // Resolve the Y.Text for the path, waiting for the key to appear after sync.
  useEffect(() => {
    const { files, provider } = shared;
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
  }, [path, shared]);

  useEffect(() => {
    if (!host.current || !ytext) return;
    const { provider } = shared;
    const extensions: Extension[] = [
      basicSetup,
      javascript({ typescript: true }),
      oneDark,
      keymap.of(yUndoManagerKeymap),
      yCollab(ytext, provider.awareness),
      intentField,
      flashField,
      EditorView.lineWrapping,
    ];
    const view = new EditorView({ state: EditorState.create({ doc: ytext.toString(), extensions }), parent: host.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [ytext, shared]);

  // Push intent ranges whenever intents, symbols or the document text change.
  // Never dispatch synchronously from inside another update (Yjs observers fire mid-transaction),
  // so recomputation is always deferred and debounced.
  const latest = useRef({ intents, symbols });
  latest.current = { intents, symbols };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const v = viewRef.current;
      if (!v) return;
      const { intents: i, symbols: s } = latest.current;
      v.dispatch({ effects: setRanges.of(intentRanges(i, v.state.doc.toString(), s)) });
    }, 60);
  };
  useEffect(() => {
    schedule();
    if (!ytext) return;
    ytext.observe(schedule);
    return () => {
      ytext.unobserve(schedule);
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intents, symbols, ytext]);

  // Remote edits (agents, other humans): flash the changed span in the editing agent's colour.
  useEffect(() => {
    if (!ytext) return;
    let prev = ytext.toString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (_e: Y.YTextEvent, tr: Y.Transaction) => {
      const next = ytext.toString();
      const range = changedRange(prev, next);
      prev = next;
      if (!range || tr.local) return;
      const le = lastEditRef.current;
      const color = le && le.path === path ? agentColor(le.agentId) : "#8b90a3";
      setTimeout(() => {
        const v = viewRef.current;
        if (!v) return;
        v.dispatch({ effects: addFlash.of({ from: Math.min(range.from, v.state.doc.length), to: Math.min(range.to, v.state.doc.length), color }) });
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => viewRef.current?.dispatch({ effects: clearFlash.of(null) }), FLASH_MS);
      }, 0);
    };
    ytext.observe(onChange);
    return () => {
      ytext.unobserve(onChange);
      if (timer) clearTimeout(timer);
    };
  }, [ytext, path]);

  if (!ytext) {
    return <div className="editor-wait">{synced ? `No shared document for ${path} yet.` : `Connecting to the shared project… (${path})`}</div>;
  }
  return <div ref={host} style={{ height: "100%" }} />;
}
