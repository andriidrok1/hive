import { useEffect, useRef, useState } from "react";
import { Code2, GitBranch, Hexagon, Search, Settings } from "lucide-react";
import { Qr } from "./Qr";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";

interface Props {
  humanId: string;
  onHumanId: (id: string) => void;
  qrUrl: string;
}

// Far-left icon rail. Only the code view exists today; the other icons are inert.
// The avatar at the bottom opens a popover with the "you" name (persisted in localStorage) and the phone QR.
export function Rail({ humanId, onHumanId, qrUrl }: Props) {
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (pop.current && !pop.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = (active: boolean) =>
    cn("flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors", active ? "bg-violet/15 text-violet" : "hover:bg-accent hover:text-foreground");
  return (
    <aside className="relative flex flex-col items-center gap-2 border-r border-border bg-background py-2" aria-label="rail">
      <div className="mb-2 flex h-10 items-center" title="Hive">
        <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-panel text-violet">
          <Hexagon className="size-5" />
        </div>
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
      <div ref={pop} className="relative mt-1">
        <button
          className="flex size-9 items-center justify-center rounded-full border border-border bg-panel text-sm font-semibold uppercase hover:border-violet/60"
          title={`You are ${humanId}`}
          aria-label="You"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {humanId.slice(0, 1) || "?"}
        </button>
        {open && (
          <div className="absolute bottom-0 left-12 z-30 flex w-64 flex-col gap-3 rounded-lg border border-border bg-popover p-3 shadow-lg" role="dialog" aria-label="you">
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              you
              <Input aria-label="your human id" value={humanId} onChange={(e) => onHumanId(e.target.value)} className="h-8 font-mono" />
              <span className="text-[11px]">Notes and contract edits are signed with this name. Your agent is agent-{humanId || "me"}.</span>
            </label>
            <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              phone page
              <Qr url={qrUrl} />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
