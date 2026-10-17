import type { AgentId, Briefing, BriefingAck, FeedEventBody } from "@hive/shared";

const SUMMARY_MAX = 400;
const DIFF_MAX = 2000;

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

/** Per-agent briefing inbox. The only producer of briefing_sent / briefing_acked events. */
export class BriefingQueue {
  private items: Briefing[] = [];
  private delivered = new Set<string>();
  private counter = 0;
  private onEvent: (e: FeedEventBody) => void;

  constructor(opts?: { onEvent?: (e: FeedEventBody) => void }) {
    this.onEvent = opts?.onEvent ?? (() => {});
  }

  push(b: Omit<Briefing, "id" | "createdAt">): Briefing {
    this.counter += 1;
    const details = { ...b.details };
    if (details.diff !== undefined) details.diff = clip(details.diff, DIFF_MAX);
    const briefing: Briefing = {
      ...b,
      details,
      summary: clip(b.summary, SUMMARY_MAX),
      id: `br_${this.counter}`,
      createdAt: Date.now(),
    };
    this.items.push(briefing);
    this.onEvent({ type: "briefing_sent", briefing });
    return briefing;
  }

  /**
   * Like push, but if an undelivered, unacked briefing with the same toAgent, kind, sender,
   * file and symbol was pushed within `windowMs`, replace its content in place (same id)
   * instead of adding another. No event on replace: it is the same briefing, updated.
   */
  upsert(b: Omit<Briefing, "id" | "createdAt">, opts?: { windowMs?: number }): Briefing {
    const windowMs = opts?.windowMs ?? 3000;
    const now = Date.now();
    const existing = [...this.items].reverse().find(
      (x) =>
        x.toAgent === b.toAgent &&
        x.kind === b.kind &&
        x.fromAgent === b.fromAgent &&
        x.fromHuman === b.fromHuman &&
        x.details.file === b.details.file &&
        x.details.symbol === b.details.symbol &&
        !x.ack &&
        !this.delivered.has(x.id) &&
        now - x.createdAt <= windowMs,
    );
    if (!existing) return this.push(b);
    const details = { ...b.details };
    if (details.diff !== undefined) details.diff = clip(details.diff, DIFF_MAX);
    existing.summary = clip(b.summary, SUMMARY_MAX);
    existing.details = details;
    existing.requiresAck = b.requiresAck || existing.requiresAck;
    existing.createdAt = now;
    return existing;
  }

  /** Undelivered briefings for this agent, oldest first; marks them delivered. */
  takeUndelivered(agentId: AgentId): Briefing[] {
    const out: Briefing[] = [];
    for (const b of this.items) {
      if (b.toAgent !== agentId || this.delivered.has(b.id)) continue;
      this.delivered.add(b.id);
      out.push(b);
    }
    return out;
  }

  /** Briefings (delivered or not) that require an ack and have none yet. */
  unackedRequired(agentId: AgentId): Briefing[] {
    return this.items.filter((b) => b.toAgent === agentId && b.requiresAck && !b.ack);
  }

  ack(agentId: AgentId, briefingId: string, ack: Omit<BriefingAck, "at">): boolean {
    const b = this.items.find((x) => x.id === briefingId);
    if (!b || b.toAgent !== agentId) return false;
    if (b.ack) return true; // idempotent, no second event
    b.ack = { ...ack, at: Date.now() };
    this.delivered.add(b.id);
    this.onEvent({ type: "briefing_acked", briefingId: b.id, agentId, ack: b.ack });
    return true;
  }

  get(briefingId: string): Briefing | undefined {
    return this.items.find((x) => x.id === briefingId);
  }

  all(): Briefing[] {
    return [...this.items];
  }

  forAgent(agentId: AgentId): Briefing[] {
    return this.items.filter((b) => b.toAgent === agentId);
  }
}
