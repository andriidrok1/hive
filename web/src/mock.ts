import type { FeedEvent, FeedEventBody, HiveState, Intent, ChangeSet } from "@hive/shared";

// A scripted demo: two agents on one checkout module. Masha's intent contradicts Andrii's
// promise and is caught before any code; she adapts; both finish; tests go red; the culprit
// search finds the pair; Masha fixes; green.

export const A = "agent-andrii";
export const M = "agent-masha";

const CHECKOUT_V0 = `export interface Item {
  sku: string;
  priceCents: number;
  qty: number;
}

export interface Promo {
  code: string;
  percentOff: number;
}

export function calculateTotal(items: Item[], promo?: Promo): number {
  const subtotal = items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);
  return applyDiscount(subtotal, promo);
}

export function applyDiscount(subtotal: number, promo?: Promo): number {
  if (!promo) return subtotal;
  return Math.round(subtotal * (1 - promo.percentOff / 100));
}

export function applyTax(total: number, state: string): number {
  const rate = state === "CA" ? 0.0725 : 0;
  return Math.round(total * (1 + rate));
}

export function formatPrice(cents: number): string {
  return \`$\${(cents / 100).toFixed(2)}\`;
}
`;

const CHECKOUT_V1 = CHECKOUT_V0.replace(
  `export function calculateTotal(items: Item[], promo?: Promo): number {
  const subtotal = items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);
  return applyDiscount(subtotal, promo);
}`,
  `export const FREE_SHIPPING_CENTS = 5000;
export const SHIPPING_CENTS = 599;

export function calculateTotal(items: Item[], promo?: Promo): number {
  const subtotal = items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);
  const discounted = applyDiscount(subtotal, promo);
  const shipping = discounted >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;
  return discounted + shipping;
}`,
);

const CHECKOUT_V2 = CHECKOUT_V1.replace(
  `export function applyTax(total: number, state: string): number {
  const rate = state === "CA" ? 0.0725 : 0;
  return Math.round(total * (1 + rate));
}`,
  `const TAX_RATES: Record<string, number> = { CA: 0.0725, NY: 0.08875, WA: 0.065 };

export function applyTax(total: number, state: string): number {
  const rate = TAX_RATES[state] ?? 0;
  return Math.round(total * (1 + rate));
}`,
);

const TEST_V0 = `import { describe, it, expect } from "vitest";
import { calculateTotal, applyTax, formatPrice } from "../src/checkout";

describe("checkout", () => {
  it("sums items", () => {
    expect(calculateTotal([{ sku: "a", priceCents: 1000, qty: 2 }])).toBe(2000);
  });
  it("applies promo", () => {
    expect(calculateTotal([{ sku: "a", priceCents: 1000, qty: 1 }], { code: "TEN", percentOff: 10 })).toBe(900);
  });
  it("applies CA tax", () => {
    expect(applyTax(1000, "CA")).toBe(1073);
  });
  it("formats", () => {
    expect(formatPrice(1234)).toBe("$12.34");
  });
});
`;

export const MOCK_FILES: Record<string, string> = {
  "src/checkout.ts": CHECKOUT_V0,
  "test/checkout.test.ts": TEST_V0,
  "package.json": `{\n  "name": "@hive/demo-app",\n  "private": true,\n  "scripts": { "test": "vitest run" }\n}\n`,
};

// Content as the mock editor should show it at a given project rev.
export function mockFileContent(path: string, rev: number): string {
  if (path === "src/checkout.ts") return rev >= 4 ? CHECKOUT_V2 : rev >= 2 ? CHECKOUT_V1 : CHECKOUT_V0;
  return MOCK_FILES[path] ?? "";
}

const T0 = 1_760_700_000_000;

function intent(partial: Omit<Intent, "createdAt" | "updatedAt" | "humanId"> & { humanId?: string }, at: number): Intent {
  return { humanId: partial.agentId === A ? "andrii" : "masha", createdAt: at, updatedAt: at, ...partial };
}

const A1 = intent(
  {
    id: "A1",
    agentId: A,
    status: "approved",
    target: { file: "src/checkout.ts", symbol: "calculateTotal" },
    action: "modify",
    what: "add a shipping fee with free shipping over $50",
    input: "items: Item[], promo?: Promo",
    output: "returns discounted subtotal plus shipping (599 cents, 0 when discounted subtotal >= 5000); still pre-tax",
    check: "expect(calculateTotal([{ sku: 'a', priceCents: 1000, qty: 1 }])).toBe(1599)",
    baseRev: 0,
  },
  T0 + 5_000,
);

const M1 = intent(
  {
    id: "M1",
    agentId: M,
    status: "conflict",
    target: { file: "src/checkout.ts", symbol: "calculateTotal" },
    action: "modify",
    what: "add state tax to calculateTotal",
    input: "items: Item[], promo?: Promo, state: string",
    output: "returns total including state tax (CA 7.25%)",
    baseRev: 0,
  },
  T0 + 9_000,
);

const M2 = intent(
  {
    id: "M2",
    agentId: M,
    status: "approved",
    target: { file: "src/checkout.ts", symbol: "applyTax" },
    action: "modify",
    what: "support NY and WA tax rates in applyTax",
    input: "total: number, state: string",
    output: "returns total with CA 7.25%, NY 8.875%, WA 6.5%, unknown state 0%",
    check: "expect(applyTax(1000, 'NY')).toBe(1089)",
    baseRev: 1,
  },
  T0 + 14_000,
);

const M3 = intent(
  {
    id: "M3",
    agentId: M,
    status: "approved",
    target: { file: "test/checkout.test.ts", symbol: "checkout" },
    action: "modify",
    what: "update the promo test for the shipping line A1 added",
    input: "",
    output: "promo test expects 900 + 599 shipping = 1499 and the tax test expects 1073",
    baseRev: 6,
  },
  T0 + 40_000,
);

type Body = FeedEventBody;

const script: Body[] = [
  { type: "agent_status", agentId: A, humanId: "andrii", status: "thinking", task: "Add a shipping fee with free shipping over $50", step: 1 },
  { type: "agent_status", agentId: M, humanId: "masha", status: "thinking", task: "Add state tax support to checkout", step: 1 },
  { type: "file_read", agentId: A, path: "src/checkout.ts", rev: 0 },
  { type: "llm_call", purpose: `agent:${A}`, model: "gpt-5.4-mini", ms: 1840, tokensIn: 2210, tokensOut: 180 },
  { type: "file_read", agentId: M, path: "src/checkout.ts", rev: 0 },
  { type: "file_read", agentId: M, path: "test/checkout.test.ts", rev: 0 },
  { type: "intent_declared", intent: A1, conflicts: [], dependents: [M] },
  { type: "llm_call", purpose: "check:dependents", model: "gpt-5.4-nano", ms: 620, tokensIn: 900, tokensOut: 60 },
  {
    type: "briefing_sent",
    briefing: {
      id: "br_1",
      toAgent: M,
      kind: "intent_declared",
      fromAgent: A,
      summary: "agent-andrii is about to change calculateTotal (you read it at rev 0): it will add a shipping line and stay pre-tax. If you planned to touch calculateTotal, coordinate.",
      details: { file: "src/checkout.ts", symbol: "calculateTotal", intentId: "A1", yourUsages: [{ file: "test/checkout.test.ts", line: 5 }] },
      requiresAck: true,
      createdAt: T0 + 6_000,
    },
  },
  { type: "agent_status", agentId: A, humanId: "andrii", status: "tool", step: 3 },
  { type: "llm_call", purpose: `agent:${M}`, model: "gpt-5.4-mini", ms: 2100, tokensIn: 3100, tokensOut: 220 },
  {
    type: "intent_declared",
    intent: M1,
    conflicts: [
      {
        intentId: "A1",
        kind: "contradiction",
        reason: "A1 promises calculateTotal stays pre-tax; M1 promises it returns a tax-inclusive total. Both cannot hold for the same symbol.",
      },
    ],
    dependents: [A],
  },
  { type: "llm_call", purpose: "check:contradiction", model: "gpt-5.4-nano", ms: 710, tokensIn: 1200, tokensOut: 90 },
  {
    type: "briefing_sent",
    briefing: {
      id: "br_2",
      toAgent: M,
      kind: "intent_conflict",
      summary: "M1 contradicts A1 (agent-andrii): calculateTotal is promised to stay pre-tax. Put tax in applyTax instead, or ask a human to resolve.",
      details: { file: "src/checkout.ts", symbol: "calculateTotal", intentId: "A1" },
      requiresAck: true,
      createdAt: T0 + 9_500,
    },
  },
  { type: "briefing_acked", briefingId: "br_1", agentId: M, ack: { response: "adapted", note: "will not touch calculateTotal; moving tax logic to applyTax", at: T0 + 11_000 } },
  { type: "briefing_acked", briefingId: "br_2", agentId: M, ack: { response: "adapted", note: "re-planning around applyTax", at: T0 + 11_500 } },
  { type: "intent_status", intentId: "M1", status: "cancelled" },
  { type: "edit_applied", agentId: A, intentId: "A1", path: "src/checkout.ts", rev: 1, added: 3, removed: 0 },
  { type: "intent_status", intentId: "A1", status: "in_progress" },
  { type: "intent_declared", intent: M2, conflicts: [], dependents: [] },
  { type: "edit_applied", agentId: A, intentId: "A1", path: "src/checkout.ts", rev: 2, added: 4, removed: 1 },
  { type: "message_sent", message: { id: "msg_1", from: M, to: A, about: "calculateTotal", text: "Does your shipping line apply before or after promo discount?", exchange: 1, createdAt: T0 + 16_000 } },
  { type: "message_sent", message: { id: "msg_2", from: A, to: M, about: "calculateTotal", text: "After the discount; free over 5000 cents discounted.", inReplyTo: "msg_1", exchange: 2, createdAt: T0 + 17_000 } },
  { type: "edit_applied", agentId: M, intentId: "M2", path: "src/checkout.ts", rev: 3, added: 1, removed: 0 },
  { type: "intent_status", intentId: "M2", status: "in_progress" },
  { type: "edit_applied", agentId: M, intentId: "M2", path: "src/checkout.ts", rev: 4, added: 2, removed: 1 },
  { type: "intent_status", intentId: "A1", status: "done" },
  { type: "agent_status", agentId: A, humanId: "andrii", status: "done", step: 7 },
  { type: "test_run_started", runId: "run_1", rev: 4, reason: "A1 finished" },
  {
    type: "briefing_sent",
    briefing: {
      id: "br_3",
      toAgent: M,
      kind: "symbol_changed",
      fromAgent: A,
      summary: "calculateTotal changed after you read it: it now adds SHIPPING_CENTS (599) below 5000. Your promo test expectation of 900 is stale.",
      details: { file: "src/checkout.ts", symbol: "calculateTotal", intentId: "A1", diff: "-  return applyDiscount(subtotal, promo);\n+  const discounted = applyDiscount(subtotal, promo);\n+  const shipping = discounted >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;\n+  return discounted + shipping;" },
      requiresAck: true,
      createdAt: T0 + 24_000,
    },
  },
  { type: "edit_applied", agentId: M, intentId: "M2", path: "test/checkout.test.ts", rev: 5, added: 3, removed: 0 },
  { type: "intent_status", intentId: "M2", status: "done" },
  { type: "test_run_started", runId: "run_2", rev: 5, reason: "M2 finished" },
  {
    type: "test_run_finished",
    runId: "run_2",
    rev: 5,
    result: {
      ok: false,
      passed: 4,
      failed: 2,
      failures: [
        { name: "checkout > applies promo", message: "expected 1499 to be 900" },
        { name: "checkout > NY tax on cart total", message: "expected 2176 to be 1089" },
      ],
      durationMs: 3400,
    },
  },
  { type: "culprit_search_started", searchId: "cs_1", suspects: ["A1", "M2"] },
  { type: "culprit_variant_result", searchId: "cs_1", variant: { label: "green+A1", applied: ["A1"], ok: true } },
  { type: "culprit_variant_result", searchId: "cs_1", variant: { label: "all-M2", applied: ["A1"], ok: true } },
  { type: "culprit_variant_result", searchId: "cs_1", variant: { label: "green+M2", applied: ["M2"], ok: true } },
  { type: "culprit_variant_result", searchId: "cs_1", variant: { label: "all-A1", applied: ["M2"], ok: true } },
  { type: "culprit_variant_result", searchId: "cs_1", variant: { label: "all", applied: ["A1", "M2"], ok: false } },
  {
    type: "culprit_found",
    searchId: "cs_1",
    report: {
      kind: "pair",
      culprits: ["A1", "M2"],
      greenRev: 0,
      variants: [
        { label: "green+A1", applied: ["A1"], ok: true },
        { label: "green+M2", applied: ["M2"], ok: true },
        { label: "all-A1", applied: ["M2"], ok: true },
        { label: "all-M2", applied: ["A1"], ok: true },
        { label: "all", applied: ["A1", "M2"], ok: false },
      ],
      durationMs: 6200,
    },
  },
  { type: "intent_status", intentId: "A1", status: "failed" },
  { type: "intent_status", intentId: "M2", status: "failed" },
  {
    type: "briefing_sent",
    briefing: {
      id: "br_4",
      toAgent: M,
      kind: "culprit",
      summary: "Tests pass with A1 alone and with M2 alone, fail together: your new NY test computes tax on a cart total that now includes shipping. Fix the test expectation or compute tax before shipping.",
      details: { file: "test/checkout.test.ts", intentId: "M2", failingTests: [{ name: "checkout > NY tax on cart total", message: "expected 2176 to be 1089" }] },
      requiresAck: true,
      createdAt: T0 + 36_000,
    },
  },
  { type: "briefing_acked", briefingId: "br_3", agentId: M, ack: { response: "adapted", note: "updating expectations", at: T0 + 38_000 } },
  { type: "briefing_acked", briefingId: "br_4", agentId: M, ack: { response: "adapted", note: "fixing the test", at: T0 + 38_500 } },
  { type: "intent_declared", intent: M3, conflicts: [], dependents: [] },
  { type: "edit_applied", agentId: M, intentId: "M3", path: "test/checkout.test.ts", rev: 6, added: 2, removed: 2 },
  { type: "intent_status", intentId: "M3", status: "done" },
  { type: "test_run_started", runId: "run_3", rev: 6, reason: "M3 finished" },
  { type: "test_run_finished", runId: "run_3", rev: 6, result: { ok: true, passed: 6, failed: 0, failures: [], durationMs: 2900 } },
  { type: "intent_status", intentId: "A1", status: "verified" },
  { type: "intent_status", intentId: "M2", status: "verified" },
  { type: "intent_status", intentId: "M3", status: "verified" },
  { type: "agent_status", agentId: M, humanId: "masha", status: "done", step: 12 },
  { type: "human_action", humanId: "andrii", action: "viewed history", target: "A1" },
];

export const MOCK_EVENTS: FeedEvent[] = script.map((body, i) => ({ id: i + 1, ts: T0 + i * 1_000, ...body }) as FeedEvent);

export const MOCK_HISTORY: ChangeSet[] = [
  {
    id: "A1",
    agentId: A,
    humanId: "andrii",
    what: A1.what,
    files: ["src/checkout.ts"],
    edits: [],
    patch: `--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -12,6 +12,10 @@\n+export const FREE_SHIPPING_CENTS = 5000;\n+export const SHIPPING_CENTS = 599;\n+\n export function calculateTotal(items: Item[], promo?: Promo): number {\n   const subtotal = items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);\n-  return applyDiscount(subtotal, promo);\n+  const discounted = applyDiscount(subtotal, promo);\n+  const shipping = discounted >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;\n+  return discounted + shipping;\n }`,
    baseRev: 0,
    endRev: 2,
    added: 7,
    removed: 1,
  },
  {
    id: "M2",
    agentId: M,
    humanId: "masha",
    what: M2.what,
    files: ["src/checkout.ts", "test/checkout.test.ts"],
    edits: [],
    patch: `--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -24,5 +24,7 @@\n+const TAX_RATES: Record<string, number> = { CA: 0.0725, NY: 0.08875, WA: 0.065 };\n+\n export function applyTax(total: number, state: string): number {\n-  const rate = state === "CA" ? 0.0725 : 0;\n+  const rate = TAX_RATES[state] ?? 0;\n   return Math.round(total * (1 + rate));\n }\n--- a/test/checkout.test.ts\n+++ b/test/checkout.test.ts\n@@ -11,4 +11,7 @@\n+  it("NY tax on cart total", () => {\n+    expect(applyTax(calculateTotal([{ sku: "a", priceCents: 1000, qty: 1 }]), "NY")).toBe(1089);\n+  });`,
    baseRev: 1,
    endRev: 5,
    added: 6,
    removed: 1,
  },
];

export function mockInitialState(): HiveState {
  return {
    mode: "hive",
    rev: 0,
    files: Object.keys(MOCK_FILES).map((path) => ({ path, rev: 0 })),
    agents: [],
    intents: [],
    history: [],
    lastGreen: { rev: 0, at: T0 - 60_000 },
    recentEvents: [],
  };
}

// History arrives in /api/state only; in mock mode we reveal change sets as intents finish.
export function mockHistoryAt(lastEventId: number): ChangeSet[] {
  const out: ChangeSet[] = [];
  const a1Done = MOCK_EVENTS.findIndex((e) => e.type === "intent_status" && e.intentId === "A1" && e.status === "done") + 1;
  const m2Done = MOCK_EVENTS.findIndex((e) => e.type === "intent_status" && e.intentId === "M2" && e.status === "done") + 1;
  const [h0, h1] = MOCK_HISTORY;
  if (h0 && lastEventId >= a1Done) out.push(h0);
  if (h1 && lastEventId >= m2Done) out.push(h1);
  return out;
}

export const MOCK_LAN_URL = "http://192.168.1.42:5173/m";
export const MOCK_STEP_MS = 700;
