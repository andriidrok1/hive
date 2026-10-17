import { startAgent } from "./api";

// Two scripted agents for the demo video. Started 3 s apart so the feed shows them arriving.
export const DEMO_PRESETS: { agentId: string; humanId: string; task: string }[] = [
  {
    agentId: "agent-alex",
    humanId: "alex",
    task:
      'In src/order.ts add two exported functions and tests for both in test/order.test.ts. (1) receipt(items, promo?) returns one string: the lines of orderSummary(items, promo) joined with "\\n", with an extra first line "Items: N" where N is the total quantity. (2) receiptWidth(items, promo?) returns the length of the longest line of receipt(items, promo). Cover: empty cart, one item without promo, two items with a percent promo. You own the new functions receipt and receiptWidth and their tests; do not change orderSummary itself.',
  },
  {
    agentId: "agent-nika",
    humanId: "nika",
    task:
      'In src/format.ts make formatPrice handle negative cents by returning the sign before the dollar ("-$1.50" for -150) and add an exported helper alignMoney(label, cents, width) that returns the label, spaces, and formatPrice(cents) right-aligned to the given total width. Add tests for both in test/format.test.ts. You own src/format.ts and test/format.test.ts.',
  },
];

export const DEMO_GAP_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function spawnDemoAgents(gapMs = DEMO_GAP_MS): Promise<void> {
  for (let i = 0; i < DEMO_PRESETS.length; i++) {
    const p = DEMO_PRESETS[i];
    if (!p) continue;
    if (i > 0) await sleep(gapMs);
    await startAgent(p);
  }
}
