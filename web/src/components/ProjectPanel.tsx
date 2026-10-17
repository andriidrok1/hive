import { ChevronDown, Cloud, FolderOpen, GitBranch, MoreHorizontal } from "lucide-react";
import type { FileInfo, HiveMode, Intent, IntentStatus } from "@hive/shared";
import { agentColor } from "../state";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "../lib/utils";

const ACTIVE: readonly IntentStatus[] = ["approved", "in_progress", "conflict"];

interface Props {
  files: FileInfo[];
  intents: Intent[];
  selected: string | null;
  onSelect: (path: string) => void;
  mode?: HiveMode;
}

interface Group {
  folder: string | null; // null = root files
  files: FileInfo[];
}

// Root files first, then folders by first path segment, each alphabetical.
export function groupFiles(files: FileInfo[]): Group[] {
  const root: FileInfo[] = [];
  const folders = new Map<string, FileInfo[]>();
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const i = f.path.indexOf("/");
    if (i < 0) root.push(f);
    else {
      const key = f.path.slice(0, i);
      folders.set(key, [...(folders.get(key) ?? []), f]);
    }
  }
  const out: Group[] = [];
  if (root.length) out.push({ folder: null, files: root });
  for (const [folder, list] of [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))) out.push({ folder, files: list });
  return out;
}

export function presentAgents(intents: Intent[], path: string): { agentId: string; humanId: string }[] {
  const seen = new Map<string, string>();
  for (const i of intents) if (i.target.file === path && ACTIVE.includes(i.status)) seen.set(i.agentId, i.humanId);
  return [...seen.entries()].map(([agentId, humanId]) => ({ agentId, humanId }));
}

function ext(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  const e = (m?.[1] ?? "").toLowerCase();
  if (e === "ts" || e === "tsx") return "TS";
  if (e === "js" || e === "mjs") return "JS";
  if (e === "json") return "{}";
  if (e === "md") return "MD";
  return e.slice(0, 2).toUpperCase() || "·";
}

export function ProjectPanel({ files, intents, selected, onSelect, mode = "hive" }: Props) {
  const groups = groupFiles(files);
  const changed = files.filter((f) => f.rev > 0).length;
  return (
    <section className="grid min-h-0 grid-rows-[56px_40px_1fr_40px] border-r border-border bg-panel" aria-label="project">
      {/* Header row, level with the rail logo: wordmark + tiny mode pill. */}
      <div className="flex items-center gap-2 border-b border-border px-4">
        <span className="text-[19px] font-semibold tracking-tight">Hive</span>
        <span className="rounded-full border border-border px-1.5 font-mono text-[10px] uppercase leading-4 tracking-wide text-muted-foreground" data-testid="mode-pill">
          {mode}
        </span>
      </div>
      <div className="flex items-center gap-1 px-4 text-[13px] font-medium">
        Project
        <ChevronDown className="size-3.5 text-muted-foreground" />
        <button className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Project menu">
          <MoreHorizontal className="size-4" />
        </button>
      </div>
      <ScrollArea className="min-h-0">
        <ul className="py-1" aria-label="file tree">
          {files.length === 0 && <li className="px-4 py-2 text-xs text-muted-foreground">No files yet.</li>}
          {groups.map((g) => (
            <li key={g.folder ?? "/"}>
              {g.folder && (
                <div className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-foreground/90">
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                  <FolderOpen className="size-4 text-violet/80" />
                  {g.folder}
                </div>
              )}
              <ul>
                {g.files.map((f) => (
                  <FileRow key={f.path} file={f} indent={g.folder ? 1 : 0} selected={f.path === selected} agents={presentAgents(intents, f.path)} onSelect={onSelect} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div className="flex items-center gap-3 border-t border-border px-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="size-3.5" />
          main
          <ChevronDown className="size-3" />
        </span>
        <Cloud className="size-3.5" />
        <span className="ml-auto inline-flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", changed > 0 ? "bg-emerald-400" : "bg-zinc-600")} />
          {changed} {changed === 1 ? "file" : "files"} changed
        </span>
      </div>
    </section>
  );
}

function FileRow({
  file,
  indent,
  selected,
  agents,
  onSelect,
}: {
  file: FileInfo;
  indent: number;
  selected: boolean;
  agents: { agentId: string; humanId: string }[];
  onSelect: (path: string) => void;
}) {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const owner = agents.length === 1 ? agents[0] : undefined;
  return (
    <li>
      <button
        className={cn(
          "flex h-8 w-full items-center gap-2 border-l-2 border-transparent pr-3 text-left text-[13px] transition-colors hover:bg-accent/60",
          selected && "border-violet bg-accent/80",
        )}
        style={{ paddingLeft: 12 + indent * 24 }}
        onClick={() => onSelect(file.path)}
        aria-current={selected ? "true" : undefined}
        data-testid={`file-${file.path}`}
      >
        <span className="w-5 shrink-0 font-mono text-[11px] font-semibold text-violet/90">{ext(file.path)}</span>
        <span className={cn("min-w-0 flex-1 truncate", selected ? "text-foreground" : "text-foreground/85")}>{name}</span>
        {owner ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-px text-[11px] font-medium"
            style={{ background: `color-mix(in srgb, ${agentColor(owner.agentId)} 18%, transparent)`, color: agentColor(owner.agentId) }}
          >
            {owner.humanId}
            <span className="size-1.5 rounded-full" style={{ background: agentColor(owner.agentId) }} />
          </span>
        ) : agents.length > 1 ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="rounded-full bg-secondary px-1.5 font-mono text-[11px] text-foreground">{agents.length}</span>
            {agents.map((a) => (
              <span key={a.agentId} className="size-2 rounded-full" style={{ background: agentColor(a.agentId) }} title={a.humanId} />
            ))}
          </span>
        ) : null}
      </button>
    </li>
  );
}
