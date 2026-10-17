import type { HiveMode } from "@hive/shared";
import { CSV_COLUMNS, type ResultRow } from "./feed.js";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ResultRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\n") + "\n";
}

export interface VariantSummary {
  variant: HiveMode;
  runs: number;
  completed: number; // runs without an error
  successRate: number; // successes / runs
  meanTokens: number; // in + out, over completed runs
  meanWallMs: number;
  meanToolCalls: number;
  meanBriefings: number;
  conflictsCaughtRate: number; // conflict rows where at least one conflict was caught before code
  culpritSearches: number;
  culpritCorrectRate: number | null; // over culprit reports on conflict rows; null when none
  falseAlarms: number; // control rows with a conflict caught or a culprit search
  controlRuns: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(rows: ResultRow[]): VariantSummary[] {
  const variants = [...new Set(rows.map((r) => r.variant))];
  return variants.map((variant) => {
    const vs = rows.filter((r) => r.variant === variant);
    const done = vs.filter((r) => !r.error);
    const conflicts = vs.filter((r) => r.conflict);
    const controls = vs.filter((r) => !r.conflict);
    const reports = conflicts.filter((r) => r.culpritCorrect !== null);
    return {
      variant,
      runs: vs.length,
      completed: done.length,
      successRate: vs.length ? vs.filter((r) => r.success).length / vs.length : 0,
      meanTokens: mean(done.map((r) => r.tokensIn + r.tokensOut)),
      meanWallMs: mean(done.map((r) => r.wallMs)),
      meanToolCalls: mean(done.map((r) => r.toolCalls)),
      meanBriefings: mean(done.map((r) => r.briefingsSent)),
      conflictsCaughtRate: conflicts.length ? conflicts.filter((r) => r.conflictsCaught > 0).length / conflicts.length : 0,
      culpritSearches: vs.reduce((a, r) => a + r.culpritSearches, 0),
      culpritCorrectRate: reports.length ? reports.filter((r) => r.culpritCorrect === true).length / reports.length : null,
      falseAlarms: controls.filter((r) => r.conflictsCaught > 0 || r.culpritSearches > 0).length,
      controlRuns: controls.length,
    };
  });
}

export interface ScenarioSummary {
  scenario: string;
  variant: HiveMode;
  conflict: boolean;
  runs: number;
  successes: number;
  meanPassed: number;
  meanFailed: number;
  meanTokens: number;
  meanWallMs: number;
  meanBriefings: number;
  meanConflictsCaught: number;
  culpritCorrect: string; // "k/n" over runs that produced a culprit report, "-" when none
}

/** One entry per (scenario, variant) in first-seen order, aggregated over repeats. */
export function summarizeScenarios(rows: ResultRow[]): ScenarioSummary[] {
  const keys = [...new Set(rows.map((r) => `${r.scenario}\u0000${r.variant}`))];
  return keys.map((key) => {
    const [scenario, variant] = key.split("\u0000") as [string, HiveMode];
    const rs = rows.filter((r) => r.scenario === scenario && r.variant === variant);
    const reports = rs.filter((r) => r.culpritCorrect !== null);
    return {
      scenario,
      variant,
      conflict: rs[0]!.conflict,
      runs: rs.length,
      successes: rs.filter((r) => r.success).length,
      meanPassed: mean(rs.map((r) => r.passed)),
      meanFailed: mean(rs.map((r) => r.failed)),
      meanTokens: mean(rs.map((r) => r.tokensIn + r.tokensOut)),
      meanWallMs: mean(rs.map((r) => r.wallMs)),
      meanBriefings: mean(rs.map((r) => r.briefingsSent)),
      meanConflictsCaught: mean(rs.map((r) => r.conflictsCaught)),
      culpritCorrect: reports.length ? `${reports.filter((r) => r.culpritCorrect === true).length}/${reports.length}` : "-",
    };
  });
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const n0 = (x: number) => String(Math.round(x));

export function summaryMarkdown(rows: ResultRow[], meta: { startedAt: Date; args: string } = { startedAt: new Date(), args: "" }): string {
  const sums = summarize(rows);
  const out: string[] = [];
  out.push(`# Bench summary`, ``, `${rows.length} runs, ${meta.startedAt.toISOString()}${meta.args ? `, args: \`${meta.args}\`` : ""}`, ``);
  out.push(`## Per variant`, ``);
  out.push(`| variant | runs | success | mean tokens | mean wall s | mean tool calls | mean briefings | conflicts caught | culprit searches | culprit correct | false alarms (controls) |`);
  out.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of sums) {
    out.push(
      `| ${s.variant} | ${s.runs}${s.completed < s.runs ? ` (${s.runs - s.completed} errored)` : ""} | ${pct(s.successRate)} | ${n0(s.meanTokens)} | ${(s.meanWallMs / 1000).toFixed(1)} | ${s.meanToolCalls.toFixed(1)} | ${s.meanBriefings.toFixed(1)} | ${pct(s.conflictsCaughtRate)} | ${s.culpritSearches} | ${s.culpritCorrectRate === null ? "n/a" : pct(s.culpritCorrectRate)} | ${s.falseAlarms}/${s.controlRuns} |`,
    );
  }
  out.push(``, `## Per scenario`, ``);
  out.push(`One row per scenario and variant, means over repeats.`, ``);
  out.push(`| scenario | variant | success | passed/failed | tokens | wall s | briefings | conflicts caught | culprit correct |`);
  out.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const s of summarizeScenarios(rows)) {
    out.push(
      `| ${s.scenario} | ${s.variant} | ${s.successes}/${s.runs} | ${s.meanPassed.toFixed(1)}/${s.meanFailed.toFixed(1)} | ${n0(s.meanTokens)} | ${(s.meanWallMs / 1000).toFixed(1)} | ${s.meanBriefings.toFixed(1)} | ${s.meanConflictsCaught.toFixed(1)} | ${s.culpritCorrect} |`,
    );
  }
  const errors = rows.filter((r) => r.error);
  if (errors.length) {
    out.push(``, `## Errors`, ``);
    for (const r of errors) out.push(`- ${r.scenario}/${r.variant}#${r.repeat}: ${r.error}`);
  }
  return out.join("\n") + "\n";
}
