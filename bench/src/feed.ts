import type { AgentId, FeedEvent, HiveMode, IntentId } from "@hive/shared";

/** Counters the bench needs from a full run's feed. Feed it every event from /ws/feed, in order. */
export class FeedCounters {
  events = 0;
  toolCalls = 0; // agent_status events with status "tool" (one per tool execution)
  llmCalls = 0;
  agentLlmCalls = 0;
  tokensIn = 0; // total prompt tokens: uncached + cached, comparable across agent-loop versions
  tokensOut = 0;
  tokensCached = 0; // cached prompt tokens (llm_call.tokensCached, 0 when the event has none)
  briefingsSent = 0;
  acksAdapted = 0;
  conflictsCaught = 0; // intent_declared with at least one conflict: caught before any code
  intentsDeclared = 0;
  edits = 0;
  culpritSearches = 0;
  culpritReports: { culprits: IntentId[]; kind: string }[] = [];
  private intentOwner = new Map<IntentId, AgentId>();

  ingest(e: FeedEvent): void {
    this.events++;
    switch (e.type) {
      case "agent_status":
        if (e.status === "tool") this.toolCalls++;
        break;
      case "llm_call":
        this.llmCalls++;
        if (e.purpose.startsWith("agent:")) this.agentLlmCalls++;
        {
          // The agent loop reports tokensIn as UNCACHED input and adds tokensCached (not yet in the contract type).
          const cached = (e as { tokensCached?: number }).tokensCached ?? 0;
          this.tokensIn += e.tokensIn + cached;
          this.tokensCached += cached;
          this.tokensOut += e.tokensOut;
        }
        break;
      case "briefing_sent":
        this.briefingsSent++;
        break;
      case "briefing_acked":
        if (e.ack.response === "adapted") this.acksAdapted++;
        break;
      case "intent_declared":
        this.intentsDeclared++;
        this.intentOwner.set(e.intent.id, e.intent.agentId);
        // Caught before any code: the registry reports conflicts on the event and marks the intent "conflict".
        if ((e.conflicts?.length ?? 0) > 0 || e.intent.status === "conflict") this.conflictsCaught++;
        break;
      case "edit_applied":
        this.edits++;
        break;
      case "culprit_search_started":
        this.culpritSearches++;
        break;
      case "culprit_found":
        this.culpritReports.push({ culprits: e.report.culprits, kind: e.report.kind });
        break;
      default:
        break;
    }
  }

  /** Owners (agentIds) named by the last culprit report, deduplicated. Unknown intent ids are kept as-is. */
  lastCulpritOwners(): AgentId[] | null {
    const last = this.culpritReports.at(-1);
    if (!last) return null;
    return [...new Set(last.culprits.map((id) => this.intentOwner.get(id) ?? id))].sort();
  }

  /** true/false when a culprit report exists, null when no search produced one. */
  culpritCorrect(expected: AgentId[]): boolean | null {
    const owners = this.lastCulpritOwners();
    if (owners === null) return null;
    const want = [...new Set(expected)].sort();
    return owners.length === want.length && owners.every((o, i) => o === want[i]);
  }
}

export interface ResultRow {
  scenario: string;
  variant: HiveMode;
  repeat: number;
  conflict: boolean;
  success: boolean; // full suite + extraTests green
  passed: number;
  failed: number;
  // The acceptance file run alone (same files, vitest -t <acceptance describe>): "did the agents deliver the
  // intended combined behavior" even when stale pre-existing tests are red.
  acceptancePassed: number;
  acceptanceFailed: number;
  acceptanceOk: boolean;
  toolCalls: number;
  llmCalls: number;
  tokensIn: number; // total prompt tokens (uncached + cached)
  tokensOut: number;
  tokensCached: number;
  wallMs: number; // from the first agent start to the last agent's terminal status
  briefingsSent: number;
  acksAdapted: number;
  conflictsCaught: number;
  culpritSearches: number;
  culpritCorrect: boolean | null;
  mergeOk: boolean | null; // isolated only
  agentsFinished: boolean; // false when the wait timed out
  error: string; // empty when the run completed
}

export const CSV_COLUMNS: (keyof ResultRow)[] = [
  "scenario",
  "variant",
  "repeat",
  "conflict",
  "success",
  "passed",
  "failed",
  "acceptancePassed",
  "acceptanceFailed",
  "acceptanceOk",
  "toolCalls",
  "llmCalls",
  "tokensIn",
  "tokensOut",
  "tokensCached",
  "wallMs",
  "briefingsSent",
  "acksAdapted",
  "conflictsCaught",
  "culpritSearches",
  "culpritCorrect",
  "mergeOk",
  "agentsFinished",
  "error",
];
