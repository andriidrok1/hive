import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Intent } from "@hive/shared";
import { ContractsTab } from "./ContractsTab";
import { setMockSink } from "../api";

const A1: Intent = {
  id: "A1",
  agentId: "agent-andrii",
  humanId: "andrii",
  status: "approved",
  createdAt: 1,
  updatedAt: 1,
  baseRev: 0,
  target: { file: "src/checkout.ts", symbol: "calculateTotal" },
  action: "modify",
  what: "add shipping",
  input: "items, promo?",
  output: "returns discounted subtotal plus shipping",
};
const M1: Intent = { ...A1, id: "M1", agentId: "agent-masha", humanId: "masha", status: "conflict", createdAt: 2, what: "add tax", output: "returns total including tax" };

describe("ContractsTab", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  beforeEach(() => {
    setMockSink(null);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("edit posts the new output to /api/intents/:id/output", async () => {
    render(<ContractsTab intents={[A1]} conflictsOf={{}} humanId="andrii" />);
    expect(screen.getByText("returns discounted subtotal plus shipping")).toBeTruthy();
    fireEvent.click(screen.getByText("Edit output"));
    fireEvent.change(screen.getByLabelText("output of A1"), { target: { value: "returns discounted subtotal plus shipping, never tax" } });
    fireEvent.click(screen.getByText("Save contract"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/intents/A1/output");
    expect(JSON.parse(String(init.body))).toEqual({ humanId: "andrii", output: "returns discounted subtotal plus shipping, never tax" });
    await waitFor(() => expect(screen.queryByText("Save contract")).toBeNull());
  });

  it("conflict resolution posts keep/cancel", async () => {
    render(<ContractsTab intents={[A1, M1]} conflictsOf={{ M1: [{ intentId: "A1", kind: "contradiction", reason: "pre-tax vs tax" }] }} humanId="masha" />);
    expect(screen.getByText(/contradiction with A1/)).toBeTruthy();
    fireEvent.click(screen.getByText("Keep A1, cancel M1"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/intents/resolve");
    expect(JSON.parse(String(init.body))).toEqual({ humanId: "masha", keep: "A1", cancel: "M1" });
  });
});
