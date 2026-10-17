import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Intent } from "@hive/shared";
import { TooltipProvider } from "../components/ui/tooltip";
import { PresenceStrip, VERIFIED_LINGER_MS, presenceFor } from "./PresenceStrip";

const base: Omit<Intent, "id" | "agentId" | "humanId" | "target" | "status"> = {
  createdAt: 1,
  updatedAt: 1,
  baseRev: 0,
  action: "modify",
  what: "do a thing",
  input: "",
  output: "returns the receipt total including the shipping line and the promo discount, never tax, as integer cents",
};
const A1: Intent = { ...base, id: "A1", agentId: "agent-alex", humanId: "alex", status: "in_progress", target: { file: "src/checkout.ts", symbol: "receipt" } };
const B1: Intent = { ...base, id: "B1", agentId: "agent-bo", humanId: "bo", status: "approved", createdAt: 2, target: { file: "src/order.ts", symbol: "placeOrder" } };
const C1: Intent = { ...base, id: "C1", agentId: "agent-cy", humanId: "cy", status: "cancelled", target: { file: "src/checkout.ts", symbol: "formatPrice" } };

function show(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("PresenceStrip", () => {
  it("renders active intents of the open file only, with a truncated promise", () => {
    show(<PresenceStrip intents={[A1, B1, C1]} openPath="src/checkout.ts" />);
    const row = screen.getByTestId("presence-A1");
    expect(row.textContent).toContain("A1");
    expect(row.textContent).toContain("agent-alex (alex) is working on receipt");
    expect(row.textContent).toContain("promised: returns the receipt total");
    expect(row.textContent).toContain("…");
    expect(row.textContent).toContain("in progress");
    expect(screen.queryByTestId("presence-B1")).toBeNull(); // other file
    expect(screen.queryByTestId("presence-C1")).toBeNull(); // cancelled
    expect(screen.queryByText("No one else is working in this file.")).toBeNull();
  });

  it("shows the empty-state line when nobody is in the file", () => {
    show(<PresenceStrip intents={[A1, B1]} openPath="src/tax.ts" />);
    expect(screen.getByText("No one else is working in this file.")).toBeTruthy();
  });

  it("keeps a freshly verified intent for a few seconds, then drops it", () => {
    const v: Intent = { ...A1, status: "verified" };
    expect(presenceFor([v], "src/checkout.ts", { A1: 1000 }, 1000 + VERIFIED_LINGER_MS - 1).map((i) => i.id)).toEqual(["A1"]);
    expect(presenceFor([v], "src/checkout.ts", { A1: 1000 }, 1000 + VERIFIED_LINGER_MS + 1)).toEqual([]);
    expect(presenceFor([v], "src/checkout.ts", {}, 5000)).toEqual([]); // verified before we were watching
    expect(presenceFor([{ ...A1, status: "conflict" }], "src/checkout.ts", {}, 0).map((i) => i.id)).toEqual(["A1"]);
  });
});
