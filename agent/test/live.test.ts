import { describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import type { Briefing } from "@hive/shared";
import { runAgent, type AgentEvent } from "../src/index.js";
import { InMemoryHive } from "./inMemoryHive.js";

// Optional live run: HIVE_LIVE=1 npm test -w @hive/agent. Loads OPENAI_API_KEY from the repo-root .env
// and never prints it. Skipped otherwise, so the suite stays green without any key.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const live = process.env.HIVE_LIVE === "1" && !!process.env.OPENAI_API_KEY;

const checkout = `export interface Item { price: number; qty: number }
export const TAX_RATES: Record<string, number> = { CA: 0.0725, NY: 0.04, OR: 0 };
export function applyTax(total: number, state: string): number {
  return Math.round(total * (1 + (TAX_RATES[state] ?? 0)));
}
// Returns the final amount in integer cents, tax INCLUDED (changed by agent-masha).
export function calculateTotal(items: Item[], state: string): number {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  return applyTax(subtotal, state);
}
`;

const tax = `import { calculateTotal, TAX_RATES, type Item } from "./checkout.js";

// Final amount the customer pays for a cart in a state, integer cents.
export function totalWithTax(items: Item[], state: string): number {
  const base = calculateTotal(items, state);
  return Math.round(base * (1 + (TAX_RATES[state] ?? 0)));
}
`;

const doubleTaxed = (src: string) => /\(1\s*\+\s*\(?TAX_RATES/.test(src) || /applyTax\(/.test(src);

describe.skipIf(!live)("live: briefing leads the agent to drop its own tax multiplication", () => {
  it(
    "ends done with tax.ts applying tax exactly once",
    async () => {
      let sent = false;
      const hive = new InMemoryHive({
        agentId: "agent-andrii",
        humanId: "andrii",
        files: { "src/checkout.ts": checkout, "src/tax.ts": tax },
        onCall: (tool) => {
          if (tool === "read_file" && !sent) {
            sent = true;
            const b: Briefing = {
              id: "br_1",
              toAgent: "agent-andrii",
              kind: "symbol_changed",
              fromAgent: "agent-masha",
              summary: "calculateTotal now includes tax: it returns applyTax(subtotal, state), the final amount in cents. You call it at src/tax.ts:5.",
              details: { file: "src/checkout.ts", symbol: "calculateTotal", yourUsages: [{ file: "src/tax.ts", line: 5 }] },
              requiresAck: true,
              createdAt: Date.now(),
            };
            return [b];
          }
        },
        runTests: (files) => {
          const src = files["src/tax.ts"] ?? "";
          if (doubleTaxed(src)) return { ok: false, passed: 1, failed: 1, failures: [{ name: "totalWithTax CA", message: "expected 1073 (1000 cents + 7.25% once) but got 1150: tax applied twice" }], durationMs: 40 };
          return { ok: true, passed: 2, failed: 0, failures: [], durationMs: 40 };
        },
      });

      const calls: { step: unknown; ms: unknown; tokensIn: unknown; tokensOut: unknown; error?: unknown }[] = [];
      const onEvent = (e: AgentEvent) => {
        if (e.type === "llm_call") calls.push({ step: e.step, ms: e.ms, tokensIn: e.tokensIn, tokensOut: e.tokensOut, error: e.error });
        else if (e.type === "tool_call") console.log(`[tool] ${String(e.tool)} ok=${String(e.ok)}${e.code ? ` code=${String(e.code)}` : ""} ${String(e.ms)}ms`);
      };

      const res = await runAgent({
        agentId: "agent-andrii",
        humanId: "andrii",
        task:
          "You own src/tax.ts. totalWithTax(items, state) must return the final amount the customer pays in integer cents, with sales tax applied exactly once. " +
          "Read src/checkout.ts to see what calculateTotal returns today, fix src/tax.ts if it double-counts tax, finish your intent and run the tests.",
        client: hive,
        maxToolCalls: 20,
        maxMs: 9 * 60_000,
        onEvent,
      });

      console.log("LIVE RESULT", JSON.stringify({ status: res.status, toolCalls: res.toolCalls, tokensIn: res.tokensIn, tokensOut: res.tokensOut, ms: res.ms, error: res.error }));
      console.log("LIVE LLM CALLS", JSON.stringify(calls));
      console.log("LIVE TOOL LOG", JSON.stringify(hive.log.map((l) => `${l.tool}${l.ok ? "" : `:${l.code}`}`)));
      console.log("LIVE FINAL tax.ts\n" + hive.files["src/tax.ts"]);
      console.log("LIVE FINAL MESSAGE\n" + (res.finalMessage ?? ""));

      expect(res.status).toBe("done");
      expect(doubleTaxed(hive.files["src/tax.ts"] ?? "")).toBe(false);
      expect(hive.files["src/tax.ts"]).toContain("calculateTotal(");
      expect(hive.log.some((l) => l.tool === "ack_briefing" && l.ok)).toBe(true);
      expect(hive.log.some((l) => l.tool === "finish_intent" && l.ok)).toBe(true);
    },
    10 * 60_000,
  );
});
