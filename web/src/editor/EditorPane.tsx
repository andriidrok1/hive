import { Suspense, lazy, useEffect, useState } from "react";
import type { SymbolInfo } from "@hive/shared";
import { intentsForFile, type UiState } from "../state";
import { fetchFile } from "../api";
import { mockFileContent } from "../mock";
import { MockEditor } from "./MockEditor";

const LiveEditor = lazy(() => import("./LiveEditor"));

interface Props {
  state: UiState;
  mock: boolean;
  humanId: string;
}

export function EditorPane({ state, mock, humanId }: Props) {
  const files = state.files;
  const [selected, setSelected] = useState<string | null>(null);
  const path = selected && files.some((f) => f.path === selected) ? selected : (files.find((f) => f.path.startsWith("src/")) ?? files[0])?.path ?? null;
  const fileRev = files.find((f) => f.path === path)?.rev ?? 0;
  const symbols = useServerSymbols(path, fileRev, mock);
  const intents = path ? intentsForFile(state, path) : [];

  return (
    <section className="left">
      <nav className="filetabs" aria-label="files">
        {files.map((f) => (
          <button key={f.path} className={`filetab${f.path === path ? " active" : ""}`} onClick={() => setSelected(f.path)}>
            {f.path}
            <span className="rev">@{f.rev}</span>
          </button>
        ))}
        {files.length === 0 && <span className="filetab">no files yet</span>}
      </nav>
      <div className="editor">
        {path === null ? (
          <div className="editor-wait">Waiting for the project…</div>
        ) : mock ? (
          <MockEditor content={mockFileContent(path, state.rev)} intents={intents} />
        ) : (
          <Suspense fallback={<div className="editor-wait">Loading editor…</div>}>
            <LiveEditor path={path} humanId={humanId} intents={intents} symbols={symbols} />
          </Suspense>
        )}
      </div>
    </section>
  );
}

// Symbols from GET /api/files/<path>, refetched when the file's rev changes (every edit_applied on it).
function useServerSymbols(path: string | null, rev: number, mock: boolean): SymbolInfo[] | null {
  const [symbols, setSymbols] = useState<{ path: string; list: SymbolInfo[] } | null>(null);
  useEffect(() => {
    if (mock || !path) return;
    let alive = true;
    const t = setTimeout(() => {
      fetchFile(path)
        .then((r) => alive && setSymbols({ path, list: r.symbols }))
        .catch(() => alive && setSymbols(null));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [path, rev, mock]);
  return symbols && symbols.path === path ? symbols.list : null;
}
