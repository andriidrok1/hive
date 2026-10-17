import type { CulpritVariant } from "@hive/shared";
import { describeReport } from "../format";
import type { CulpritGrid, TestsState } from "../state";

export function CulpritTab({ grid, tests }: { grid?: CulpritGrid; tests: TestsState }) {
  return (
    <div className="culprit">
      <TestLine tests={tests} />
      {!grid ? (
        <div className="muted">No culprit search yet. When tests go red after an intent finishes, Hive runs the suite with and without each change set here, in parallel.</div>
      ) : (
        <>
          <h3>
            Search {grid.searchId} · suspects {grid.suspects.join(", ") || "–"}
          </h3>
          <div className="grid" aria-label="culprit grid">
            {labelsFor(grid).map((label) => (
              <VariantCard key={label} label={label} v={grid.variants[label]} />
            ))}
          </div>
          {grid.report && (
            <div className={`banner ${grid.report.kind}`} role="status">
              <b>{grid.report.kind === "pair" ? "Pair conflict" : grid.report.kind === "single" ? "Single culprit" : grid.report.kind === "dependent" ? "Dependent pair" : "Unknown"}</b>
              {" · "}
              {describeReport(grid.report)}
              <small>
                {grid.report.variants.length} variants in {(grid.report.durationMs / 1000).toFixed(1)} s · green baseline rev {grid.report.greenRev}
              </small>
            </div>
          )}
        </>
      )}
    </div>
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

function VariantCard({ label, v }: { label: string; v?: CulpritVariant }) {
  const cls = !v ? "pending" : v.applyError ? "apply" : v.ok ? "ok" : "red";
  return (
    <div className={`variant ${cls}`} data-testid={`variant-${label}`}>
      <span>{label}</span>
      <small>{!v ? "running…" : v.applyError ? "patch failed" : v.ok ? "green" : "red"}</small>
    </div>
  );
}

function TestLine({ tests }: { tests: TestsState }) {
  if (tests.running) {
    return (
      <div className="testline running">
        Running tests @{tests.running.rev} ({tests.running.reason})…
      </div>
    );
  }
  if (!tests.last) return <div className="testline muted">No test run yet.</div>;
  const r = tests.last.result;
  return (
    <div className={`testline ${r.ok ? "green" : "red"}`}>
      {r.ok ? `Tests green @${tests.last.rev}: ${r.passed} passed` : `Tests red @${tests.last.rev}: ${r.failed} failed, ${r.passed} passed`} ·{" "}
      {(r.durationMs / 1000).toFixed(1)} s
      {!r.ok && r.failures.length > 0 && (
        <ul>
          {r.failures.slice(0, 5).map((f) => (
            <li key={f.name}>
              {f.name}: {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
