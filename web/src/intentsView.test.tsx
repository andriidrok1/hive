import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Intent } from "@hive/shared";
import { earlierMap, visibleIntents } from "./intentsView";
import { intentRanges } from "./editor/ranges";
import { MockEditor } from "./editor/MockEditor";
import { presentAgents } from "./components/ProjectPanel";
import { TooltipProvider } from "./components/ui/tooltip";
import { PresenceStrip } from "./editor/PresenceStrip";

const base: Omit<Intent, "id" | "status" | "createdAt"> = {
  agentId: "agent-andrii",
  humanId: "andrii",
  updatedAt: 0,
  baseRev: 0,
  target: { file: "src/checkout.ts", symbol: "calculateTotal" },
  action: "modify",
  what: "tweak the total",
  input: "",
  output: "returns the total in cents",
};
// Three intents of one agent on one symbol: two closed, one live.
const A1: Intent = { ...base, id: "A1", status: "done", createdAt: 1 };
const A3: Intent = { ...base, id: "A3", status: "cancelled", createdAt: 3 };
const A5: Intent = { ...base, id: "A5", status: "in_progress", createdAt: 5, what: "add shipping" };
// Another agent on the same symbol, and a closed one elsewhere.
const M1: Intent = { ...base, id: "M1", agentId: "agent-masha", humanId: "masha", status: "approved", createdAt: 4 };
const M9: Intent = { ...base, id: "M9", agentId: "agent-masha", humanId: "masha", status: "failed", createdAt: 9, target: { file: "src/tax.ts", symbol: "applyTax" } };

const content = `export function calculateTotal(items: number[]): number {\n  return items.length;\n}\n`;

describe("visibleIntents", () => {
  it("shows one label per agent per symbol and folds the agent's earlier intents", () => {
    const v = visibleIntents([A1, A3, A5, M1, M9], "src/checkout.ts");
    expect(v.map((x) => x.intent.id)).toEqual(["M1", "A5"]);
    expect(v.find((x) => x.intent.id === "A5")?.earlier).toEqual(["A1", "A3"]);
    expect(v.find((x) => x.intent.id === "M1")?.earlier).toEqual([]);
    // Only closed intents left: nothing shown, nothing folded.
    expect(visibleIntents([A1, A3], "src/checkout.ts")).toEqual([]);
    // Verified lingers only while listed.
    const v5: Intent = { ...A5, status: "verified" };
    expect(visibleIntents([A1, v5], "src/checkout.ts", new Set(["A5"])).map((x) => x.intent.id)).toEqual(["A5"]);
    expect(visibleIntents([A1, v5], "src/checkout.ts")).toEqual([]);
  });

  it("editor labels carry the +N earlier suffix, once per agent", () => {
    const v = visibleIntents([A1, A3, A5], "src/checkout.ts");
    const ranges = intentRanges(v.map((x) => x.intent), content, null, earlierMap(v));
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.label).toBe("agent-andrii: add shipping → returns the total in cents +2 earlier");
    expect(ranges[0]?.earlier).toEqual(["A1", "A3"]);
  });

  it("mock editor renders a single label with the earlier ids in its tooltip", () => {
    const v = visibleIntents([A1, A3, A5], "src/checkout.ts");
    render(<MockEditor content={content} intents={v.map((x) => x.intent)} earlier={earlierMap(v)} />);
    expect(screen.queryByTestId("label-A1")).toBeNull();
    expect(screen.queryByTestId("label-A3")).toBeNull();
    const label = screen.getByTestId("label-A5");
    expect(label.textContent).toContain("+2 earlier");
    expect(label.getAttribute("title")).toBe("earlier intents on calculateTotal: A1, A3");
  });

  it("file tree counts live agents only; presence strip shows +N earlier", () => {
    expect(presentAgents([A1, A3, A5, M1, M9], "src/checkout.ts").map((a) => a.humanId).sort()).toEqual(["andrii", "masha"]);
    expect(presentAgents([A1, A3], "src/checkout.ts")).toEqual([]);
    render(
      <TooltipProvider>
        <PresenceStrip intents={[A1, A3, A5]} openPath="src/checkout.ts" />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("presence-A5")).toBeTruthy();
    expect(screen.queryByTestId("presence-A1")).toBeNull();
    expect(screen.getByTestId("earlier-A5").textContent).toBe("+2 earlier");
  });
});
