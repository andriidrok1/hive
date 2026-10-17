import { startAgent } from "./api";
import { setAgentTitle } from "./titles";

export interface DemoPreset {
  agentId: string;
  humanId: string;
  title: string; // short human summary shown on the card ("Feature: …")
  task: string; // full instruction sent to the server
}

// Two scripted agents for the demo video. Started 3 s apart so the feed shows them arriving.
export const DEMO_PRESETS: DemoPreset[] = [
  {
    agentId: "agent-alex",
    humanId: "alex",
    title: "Receipt and receipt width in order.ts",
    task:
      'In src/order.ts add two exported functions and tests for both in test/order.test.ts. (1) receipt(items, promo?) returns one string: the lines of orderSummary(items, promo) joined with "\\n", with an extra first line "Items: N" where N is the total quantity. (2) receiptWidth(items, promo?) returns the length of the longest line of receipt(items, promo). Cover: empty cart, one item without promo, two items with a percent promo. You own the new functions receipt and receiptWidth and their tests; do not change orderSummary itself.',
  },
  {
    agentId: "agent-nika",
    humanId: "nika",
    title: "Negative prices and percent formatting in format.ts",
    task:
      'In src/format.ts make formatPrice handle negative cents by returning the sign before the dollar ("-$1.50" for -150) and add an exported function formatPercent(value) that returns the number followed by a percent sign, without decimals for whole numbers ("10%" for 10, "7.5%" for 7.5). Add tests for both in test/format.test.ts. You own src/format.ts and test/format.test.ts.',
  },
];

export const DEMO_GAP_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function spawnDemoAgents(gapMs = DEMO_GAP_MS): Promise<void> {
  for (let i = 0; i < DEMO_PRESETS.length; i++) {
    const p = DEMO_PRESETS[i];
    if (!p) continue;
    if (i > 0) await sleep(gapMs);
    setAgentTitle(p.agentId, p.title);
    // The API body is exactly { agentId, humanId, task }; the title stays client-side.
    await startAgent({ agentId: p.agentId, humanId: p.humanId, task: p.task });
  }
}
