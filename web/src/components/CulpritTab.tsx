import { FlaskConical, ShieldAlert } from "lucide-react";
import type { CulpritVariant } from "@hive/shared";
import { describeReport } from "../format";
import type { CulpritGrid, TestsState } from "../state";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "../lib/utils";

export function CulpritTab({ grid, tests }: { grid?: CulpritGrid; tests: TestsState }) {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-3">
        <TestLine tests={tests} />
        {!grid ? (
          <div className="px-1 py-3 text-xs text-muted-foreground">No culprit search yet. When tests go red after an intent finishes, Hive runs the suite with and without each change set in parallel.</div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-1 text-[13px]">
              <ShieldAlert className="size-3.5 text-muted-foreground" />
              <span className="font-medium">Culprit search</span>
              <span className="font-mono text-xs text-muted-foreground">
                {grid.searchId} · suspects {grid.suspects.join(", ") || "–"}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2" aria-label="culprit grid">
              {labelsFor(grid).map((label) => (
                <VariantCard key={label} label={label} v={grid.variants[label]} />
              ))}
            </div>
            {grid.report && (
              <div className={cn("rounded-md border px-3 py-2.5 text-sm leading-snug", grid.report.kind === "unknown" ? "border-border" : "border-red-500/60 bg-red-500/5")} role="status">
                <span className="font-medium text-red-300">
                  {grid.report.kind === "pair" ? "Pair conflict" : grid.report.kind === "single" ? "Single culprit" : grid.report.kind === "dependent" ? "Dependent pair" : "No single culprit"}
                </span>
                <span className="text-foreground"> · {describeReport(grid.report)}</span>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {grid.report.variants.length} variants in {(grid.report.durationMs / 1000).toFixed(1)} s · green baseline rev {grid.report.greenRev}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

// Expected labels first (green+X, all-X per suspect), then anything else the server sent.
function labelsFor(grid: CulpritGrid): string[] {
  const expected: string[] = [];
  for (const s of grid.suspects) expected.push(`green+${s}`);
  for (const s of grid.suspects) expected.push(`all-${s}`);
  const extra = grid.order.filter((l) => !expected.includes(l));
  return [...expected, ...extra];
}

// The plain "ok" / "red" / "pending" / "apply" tokens stay in className: tests assert on them.
function VariantCard({ label, v }: { label: string; v?: CulpritVariant }) {
  const cls = !v ? "pending" : v.applyError ? "apply" : v.ok ? "ok" : "red";
  return (
    <div
      className={cn(
        "variant flex h-16 flex-col items-center justify-center gap-1 rounded-md border font-mono text-[13px] font-medium transition-colors",
        cls,
        cls === "pending" && "border-dashed border-zinc-700 text-muted-foreground",
        cls === "ok" && "border-emerald-500/50 bg-emerald-500/10 text-emerald-300",
        cls === "red" && "border-red-500/60 bg-red-500/10 text-red-300",
        cls === "apply" && "border-amber-500/60 bg-amber-500/10 text-amber-300",
      )}
      data-testid={`variant-${label}`}
    >
      <span>{label}</span>
      <span className="text-[11px] font-normal opacity-80">{!v ? "running" : v.applyError ? "patch failed" : v.ok ? "green" : "red"}</span>
    </div>
  );
}

function TestLine({ tests }: { tests: TestsState }) {
  if (tests.running) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
        <FlaskConical className="size-3.5 animate-pulse text-amber-400" />
        Running tests @{tests.running.rev}
        <span className="font-mono text-xs text-muted-foreground">({tests.running.reason})</span>
      </div>
    );
  }
  if (!tests.last) return <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">No test run yet.</div>;
  const r = tests.last.result;
  return (
    <div className={cn("rounded-md border px-3 py-2 text-[13px]", r.ok ? "border-emerald-500/50" : "border-red-500/60")}>
      <div className="flex items-center gap-2">
        <FlaskConical className={cn("size-3.5", r.ok ? "text-emerald-400" : "text-red-400")} />
        <span className={r.ok ? "text-emerald-300" : "text-red-300"}>{r.ok ? `Tests green @${tests.last.rev}: ${r.passed} passed` : `Tests red @${tests.last.rev}: ${r.failed} failed, ${r.passed} passed`}</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{(r.durationMs / 1000).toFixed(1)} s</span>
      </div>
      {!r.ok && r.failures.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 font-mono text-xs text-muted-foreground">
          {r.failures.slice(0, 5).map((f) => (
            <li key={f.name} className="truncate">
              {f.name}: {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
