import { Suspense, lazy, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { SymbolInfo } from "@hive/shared";
import { intentsForFile, type UiState } from "../state";
import { fetchFile } from "../api";
import { mockFileContent } from "../mock";
import { MockEditor } from "./MockEditor";
import { PresenceStrip } from "./PresenceStrip";
import { cn } from "../lib/utils";

const LiveEditor = lazy(() => import("./LiveEditor"));

interface Props {
  state: UiState;
  mock: boolean;
  humanId: string;
  path: string | null; // controlled by App (shared with the project tree)
  onSelect: (path: string) => void;
}

// Which file to open when nothing is selected yet: first src/ file, else the first file.
export function defaultPath(files: { path: string }[], selected: string | null): string | null {
  if (selected && files.some((f) => f.path === selected)) return selected;
  return (files.find((f) => f.path.startsWith("src/")) ?? files[0])?.path ?? null;
}

export function EditorPane({ state, mock, humanId, path, onSelect }: Props) {
  const files = state.files;
  const fileRev = files.find((f) => f.path === path)?.rev ?? 0;
  const symbols = useServerSymbols(path, fileRev, mock);
  const intents = path ? intentsForFile(state, path) : [];

  return (
    <section className="grid min-h-0 grid-rows-[44px_auto_1fr] bg-background">
      <nav className="flex items-stretch overflow-x-auto border-b border-border" aria-label="files">
        {files.map((f) => (
          <button
            key={f.path}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 border-transparent border-r border-r-border px-4 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
              f.path === path && "border-b-violet bg-panel text-foreground",
            )}
            onClick={() => onSelect(f.path)}
            aria-current={f.path === path ? "true" : undefined}
          >
            <span className="font-mono text-[11px] font-semibold text-violet/90">TS</span>
            {f.path.slice(f.path.lastIndexOf("/") + 1)}
            <span className="font-mono text-[10px] text-zinc-600">@{f.rev}</span>
          </button>
        ))}
        {files.length === 0 && <span className="px-4 font-mono text-xs leading-[44px] text-muted-foreground">no files yet</span>}
        <span className="flex items-center px-3 text-muted-foreground" aria-hidden>
          <Plus className="size-4" />
        </span>
      </nav>
      {/* Who is in this file: live from intent_declared / intent_status through state.intents. */}
      <PresenceStrip intents={state.intents} openPath={path} />
      <div className="editor relative min-h-0 overflow-auto bg-background">
        {path === null ? (
          <div className="px-4 py-6 text-xs text-muted-foreground">Waiting for the project.</div>
        ) : mock ? (
          <MockEditor content={mockFileContent(path, state.rev)} intents={intents} />
        ) : (
          <Suspense fallback={<div className="px-4 py-6 text-xs text-muted-foreground">Loading editor.</div>}>
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
