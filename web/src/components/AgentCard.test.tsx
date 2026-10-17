import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentCard } from "./AgentCard";
import { setMockSink } from "../api";

describe("AgentCard", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  beforeEach(() => {
    setMockSink(null);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders status, task, intent and posts pause on Pause", async () => {
    render(
      <AgentCard
        agentId="agent-masha"
        humanId="masha"
        status="thinking"
        control="run"
        task="Add state tax"
        intent={{ id: "M2", agentId: "agent-masha", humanId: "masha", status: "in_progress", createdAt: 1, updatedAt: 1, baseRev: 1, target: { file: "src/checkout.ts", symbol: "applyTax" }, action: "modify", what: "support NY", input: "", output: "returns total with NY tax" }}
        actions={["read src/checkout.ts @0"]}
        viewer="andrii"
      />,
    );
    expect(screen.getByText("thinking")).toBeTruthy();
    expect(screen.getByText("Add state tax")).toBeTruthy();
    expect(screen.getByText("M2")).toBeTruthy();
    expect(screen.getByText("read src/checkout.ts @0")).toBeTruthy();

    fireEvent.click(screen.getByText("Pause"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/agents/agent-masha/control");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ humanId: "andrii", control: "pause" });
  });

  it("shows Resume when paused and posts run; Stop posts stop; Note posts a note", async () => {
    render(<AgentCard agentId="agent-a" humanId="a" status="paused" control="pause" actions={[]} viewer="andrii" />);
    fireEvent.click(screen.getByText("Resume"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ humanId: "andrii", control: "run" });

    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ humanId: "andrii", control: "stop" });

    fireEvent.click(screen.getByText("Urgent"));
    const input = screen.getByLabelText("urgent note");
    fireEvent.change(input, { target: { value: "stop touching calculateTotal" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(url).toBe("/api/agents/agent-a/note");
    expect(JSON.parse(String(init.body))).toEqual({ humanId: "andrii", text: "stop touching calculateTotal", urgent: true });
  });
});
