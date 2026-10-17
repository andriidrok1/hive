import type { FeedEvent } from "@hive/shared";

export type Tone = "agent" | "read" | "intent" | "conflict" | "edit" | "briefing" | "ack" | "message" | "test" | "green" | "red" | "culprit" | "human" | "llm";

export interface FeedLine {
  text: string;
  tone: Tone;
  who?: string; // agent or human id, for colour
}

export function shortTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatEvent(e: FeedEvent): FeedLine {
  switch (e.type) {
    case "agent_status":
      return {
        tone: "agent",
        who: e.agentId,
        text: `${e.agentId} ${e.status}${e.step !== undefined ? ` (step ${e.step})` : ""}${e.task ? `: ${e.task}` : ""}`,
      };
    case "file_read":
      return { tone: "read", who: e.agentId, text: `${e.agentId} read ${e.path} @${e.rev}` };
    case "intent_declared": {
      const c = e.conflicts.length > 0 ? ` — CONFLICT with ${e.conflicts.map((x) => x.intentId).join(", ")} (${e.conflicts[0]?.kind ?? ""})` : "";
      const d = e.dependents.length > 0 ? ` → briefed ${e.dependents.join(", ")}` : "";
      return {
        tone: e.conflicts.length > 0 ? "conflict" : "intent",
        who: e.intent.agentId,
        text: `${e.intent.id} ${e.intent.agentId} intends to ${e.intent.action} ${e.intent.target.symbol}: ${e.intent.what}${c}${d}`,
      };
    }
    case "intent_status":
      return { tone: e.status === "conflict" || e.status === "failed" ? "conflict" : e.status === "verified" ? "green" : "intent", text: `${e.intentId} → ${e.status}` };
    case "edit_applied":
      return {
        tone: "edit",
        who: e.agentId,
        text: `${e.agentId} edited ${e.path}${e.intentId ? ` under ${e.intentId}` : ""} +${e.added} −${e.removed} → rev ${e.rev}`,
      };
    case "briefing_sent":
      return {
        tone: "briefing",
        who: e.briefing.toAgent,
        text: `briefing ${e.briefing.id} (${e.briefing.kind}) → ${e.briefing.toAgent}${e.briefing.requiresAck ? " · ack required" : ""}`,
      };
    case "briefing_acked":
      return { tone: "ack", who: e.agentId, text: `${e.agentId} acked ${e.briefingId}: ${e.ack.response}${e.ack.note ? ` — ${e.ack.note}` : ""}` };
    case "message_sent":
      return { tone: "message", who: e.message.from, text: `${e.message.from} → ${e.message.to} about ${e.message.about} (#${e.message.exchange}): ${e.message.text}` };
    case "test_run_started":
      return { tone: "test", text: `tests started @${e.rev} (${e.reason})` };
    case "test_run_finished":
      return {
        tone: e.result.ok ? "green" : "red",
        text: e.result.ok
          ? `tests GREEN @${e.rev}: ${e.result.passed} passed in ${(e.result.durationMs / 1000).toFixed(1)}s`
          : `tests RED @${e.rev}: ${e.result.failed} failed, ${e.result.passed} passed${e.result.failures[0] ? ` — ${e.result.failures[0].name}` : ""}`,
      };
    case "culprit_search_started":
      return { tone: "culprit", text: `culprit search over ${e.suspects.join(", ")}: ${e.suspects.length * 2} variants in parallel` };
    case "culprit_variant_result":
      return {
        tone: e.variant.ok ? "green" : "red",
        text: `variant ${e.variant.label}: ${e.variant.applyError ? `patch failed (${e.variant.applyError})` : e.variant.ok ? "green" : "red"}`,
      };
    case "culprit_found":
      return { tone: "culprit", text: `culprit: ${describeReport(e.report)}` };
    case "human_action":
      return { tone: "human", who: e.humanId, text: `${e.humanId} ${e.action}${e.target ? ` ${e.target}` : ""}` };
    case "llm_call":
      return { tone: "llm", text: `${e.purpose} ${e.model} ${e.ms} ms, ${e.tokensIn}→${e.tokensOut} tok` };
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

export function describeReport(r: { kind: string; culprits: string[]; variants: { label: string; ok: boolean }[] }): string {
  const alone = r.culprits.map((c) => {
    const v = r.variants.find((x) => x.label === `green+${c}`);
    return `${c} alone ${v ? (v.ok ? "ok" : "red") : "?"}`;
  });
  switch (r.kind) {
    case "single":
      return `${r.culprits.join(", ")} breaks the tests on its own`;
    case "pair":
      return `${alone.join(", ")}, together red: conflict between ${r.culprits.join(" and ")}`;
    case "dependent":
      return `${r.culprits.join(" + ")}: one depends on the other, only the pair passes`;
    default:
      return `no single culprit found among ${r.culprits.length ? r.culprits.join(", ") : "the suspects"}`;
  }
}
