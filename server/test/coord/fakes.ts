import type { AgentId, FeedEventBody, Rev } from "@hive/shared";
import type { ReadLogLike } from "../../src/coord/deps.js";

/** Minimal ReadLog with the same semantics as brief 01: latest read per (agent, path). */
export class FakeReadLog implements ReadLogLike {
  private reads: { agentId: AgentId; path: string; rev: Rev; symbols: string[] }[] = [];

  record(agentId: AgentId, path: string, rev: Rev, symbols: string[]): void {
    this.reads.push({ agentId, path, rev, symbols: [...symbols] });
  }

  readsOf(agentId: AgentId): { path: string; rev: Rev; symbols: string[] }[] {
    return this.reads.filter((r) => r.agentId === agentId).map(({ path, rev, symbols }) => ({ path, rev, symbols }));
  }

  readersOf(path: string, symbol?: string): { agentId: AgentId; rev: Rev }[] {
    const latest = new Map<AgentId, Rev>();
    for (const r of this.reads) {
      if (r.path !== path) continue;
      if (symbol && !r.symbols.includes(symbol)) continue;
      const prev = latest.get(r.agentId);
      if (prev === undefined || r.rev > prev) latest.set(r.agentId, r.rev);
    }
    return [...latest].map(([agentId, rev]) => ({ agentId, rev }));
  }
}

export function eventSink(): { events: FeedEventBody[]; onEvent: (e: FeedEventBody) => void; ofType: <T extends FeedEventBody["type"]>(t: T) => Extract<FeedEventBody, { type: T }>[] } {
  const events: FeedEventBody[] = [];
  return {
    events,
    onEvent: (e) => events.push(e),
    ofType: (t) => events.filter((e) => e.type === t) as never,
  };
}

export const CHECKOUT_TS = `import { Item, Promo } from "./types.js";

/** Sum of item prices minus the promo discount, in cents. No tax. */
export function calculateTotal(items: Item[], promo?: Promo): number {
  const subtotal = items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);
  return promo ? applyDiscount(subtotal, promo) : subtotal;
}

export function applyDiscount(subtotal: number, promo: Promo): number {
  if (promo.kind === "percent") return Math.round(subtotal * (1 - promo.value / 100));
  return Math.max(0, subtotal - promo.value);
}

export function applyTax(items: Item[], state: string, promo?: Promo): number {
  const total = calculateTotal(items, promo);
  const rate = state === "CA" ? 0.0725 : 0;
  return Math.round(total * (1 + rate));
}

export const formatPrice = (cents: number): string => {
  const dollars = (cents / 100).toFixed(2);
  return "$" + dollars;
};

export type Money = number;

export interface Receipt {
  total: Money;
  lines: string[];
}

function helper(items: Item[]): number[] {
  return items.map((it) => calculateTotal([it]));
}
`;

export const REPORT_TS = `import { calculateTotal, formatPrice } from "./checkout.js";
import type { Item } from "./types.js";

export function report(items: Item[]): string {
  return formatPrice(calculateTotal(items));
}
`;
