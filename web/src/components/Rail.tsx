import { Code2, GitBranch, Hexagon, Search, Settings } from "lucide-react";
import { cn } from "../lib/utils";

// Far-left icon rail. Only the code view exists today; the other icons are inert.
export function Rail({ humanId }: { humanId: string }) {
  const item = (active: boolean) =>
    cn("flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors", active ? "bg-violet/15 text-violet" : "hover:bg-accent hover:text-foreground");
  return (
    <aside className="flex flex-col items-center gap-2 border-r border-border bg-background py-3" aria-label="rail">
      <div className="mb-2 flex size-10 items-center justify-center rounded-lg border border-border bg-panel text-violet">
        <Hexagon className="size-5" />
      </div>
      <button className={item(true)} title="Code" aria-label="Code">
        <Code2 className="size-[18px]" />
      </button>
      <button className={item(false)} title="Search" aria-label="Search">
        <Search className="size-[18px]" />
      </button>
      <button className={item(false)} title="Branches" aria-label="Branches">
        <GitBranch className="size-[18px]" />
      </button>
      <div className="flex-1" />
      <button className={item(false)} title="Settings" aria-label="Settings">
        <Settings className="size-[18px]" />
      </button>
      <div className="mt-1 flex size-9 items-center justify-center rounded-full border border-border bg-panel text-sm font-semibold uppercase" title={humanId}>
        {humanId.slice(0, 1) || "?"}
      </div>
    </aside>
  );
}
