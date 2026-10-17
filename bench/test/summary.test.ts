import { describe, expect, it } from "vitest";
import type { ResultRow } from "../src/feed.js";
import { FeedCounters } from "../src/feed.js";
import { summarize, summaryMarkdown, toCsv } from "../src/summary.js";

function row(over: Partial<ResultRow>): ResultRow {
  return {
    scenario: "s01-double-tax",
    variant: "hive",
    repeat: 1,
    conflict: true,
    success: true,
    passed: 27,
    failed: 0,
    toolCalls: 10,
    llmCalls: 12,
    tokensIn: 1000,
    tokensOut: 200,
    wallMs: 60_000,
    briefingsSent: 2,
    acksAdapted: 1,
    conflictsCaught: 1,
    culpritSearches: 0,
    culpritCorrect: null,
    mergeOk: null,
    agentsFinished: true,
    error: "",
    ...over,
  };
}

describe("summarize", () => {
  const rows: ResultRow[] = [
    row({}),
    row({ repeat: 2, success: false, tokensIn: 3000, tokensOut: 400, wallMs: 120_000, culpritSearches: 1, culpritCorrect: true }),
    row({ scenario: "c01-control", conflict: false, conflictsCaught: 1 }), // false alarm
    row({ variant: "naive", success: false, briefingsSent: 0, conflictsCaught: 0, culpritSearches: 1, culpritCorrect: false }),
    row({ variant: "naive", scenario: "c01-control", conflict: false, conflictsCaught: 0 }),
    row({ variant: "isolated", error: "timeout", success: false, tokensIn: 0, tokensOut: 0, wallMs: 0 }),
  ];

  it("computes per-variant rates and means over completed runs", () => {
    const [hive, naive, isolated] = summarize(rows);
    expect(hive).toMatchObject({ variant: "hive", runs: 3, completed: 3, falseAlarms: 1, controlRuns: 1, culpritSearches: 1 });
    expect(hive!.successRate).toBeCloseTo(2 / 3);
    expect(hive!.meanTokens).toBeCloseTo((1200 + 3400 + 1200) / 3);
    expect(hive!.meanWallMs).toBeCloseTo((60_000 + 120_000 + 60_000) / 3);
    expect(hive!.conflictsCaughtRate).toBe(1);
    expect(hive!.culpritCorrectRate).toBe(1);
    expect(naive).toMatchObject({ runs: 2, successRate: 0.5, falseAlarms: 0, culpritCorrectRate: 0, conflictsCaughtRate: 0 });
    expect(isolated).toMatchObject({ runs: 1, completed: 0, successRate: 0, meanTokens: 0, culpritCorrectRate: null });
  });

  it("renders markdown with one row per variant and per scenario", () => {
    const md = summaryMarkdown(rows, { startedAt: new Date(0), args: "--repeats 2" });
    expect(md).toContain("| hive | 3 | 67% |");
    expect(md).toContain("| isolated | 1 (1 errored) | 0% |");
    expect(md).toContain("| s01-double-tax | 1/2 | 0/1 | 0/1 |");
    expect(md).toContain("- s01-double-tax/isolated#1: timeout");
  });

  it("writes CSV with a header, booleans, blanks for null and quoted errors", () => {
    const csv = toCsv([row({ error: 'boom, "quoted"', culpritCorrect: null, mergeOk: false })]);
    const [header, line] = csv.trim().split("\n");
    expect(header!.startsWith("scenario,variant,repeat,conflict,success,passed,failed,toolCalls")).toBe(true);
    expect(line).toBe('s01-double-tax,hive,1,true,true,27,0,10,12,1000,200,60000,2,1,1,0,,false,true,"boom, ""quoted"""');
  });
});

describe("FeedCounters.culpritCorrect", () => {
  it("maps culprit intent ids to their owners and compares as a set", () => {
    const c = new FeedCounters();
    const intent = (id: string, agentId: string) => ({
      id: 1,
      ts: 0,
      type: "intent_declared" as const,
      intent: { id, agentId, humanId: "h", status: "approved" as const, createdAt: 0, updatedAt: 0, baseRev: 0, target: { file: "f", symbol: "s" }, action: "modify" as const, what: "w", input: "i", output: "o" },
      conflicts: [],
      dependents: [],
    });
    c.ingest(intent("A1", "agent-andrii"));
    c.ingest(intent("B1", "agent-masha"));
    expect(c.culpritCorrect(["agent-andrii"])).toBeNull();
    c.ingest({ id: 3, ts: 0, type: "culprit_found", searchId: "x", report: { kind: "pair", culprits: ["B1", "A1"], greenRev: 0, variants: [], durationMs: 1 } });
    expect(c.culpritCorrect(["agent-andrii", "agent-masha"])).toBe(true);
    expect(c.culpritCorrect(["agent-andrii"])).toBe(false);
  });
});
