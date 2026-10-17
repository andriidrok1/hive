import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentCard, elapsed, statusView } from "./AgentCard";
import { setMockSink } from "../api";

const openMenu = () => fireEvent.click(screen.getByLabelText("Agent menu"));

describe("AgentCard", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  beforeEach(() => {
    setMockSink(null);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders status, task, intent, files, elapsed time and posts pause on Pause", async () => {
    render(
      <AgentCard
        agentId="agent-masha"
        humanId="masha"
        status="thinking"
        control="run"
        task="Add state tax. Cover NY and WA rates with tests."
        intent={{ id: "M2", agentId: "agent-masha", humanId: "masha", status: "in_progress", createdAt: 1, updatedAt: 1, baseRev: 1, target: { file: "src/checkout.ts", symbol: "applyTax" }, action: "modify", what: "support NY", input: "", output: "returns total with NY tax" }}
        actions={["read src/checkout.ts @0"]}
        viewer="andrii"
        meta={{ startedAt: 1_000, lastAt: 2_000, step: 8, files: ["src/checkout.ts"] }}
        files={["src/checkout.ts", "test/checkout.test.ts"]}
        now={181_000}
      />,
    );
    expect(screen.getByText("Working")).toBeTruthy();
    // Primary line is a short title (first clause of the task when nobody set one); the full task is under "details".
    expect(screen.getByTestId("agent-title").textContent).toBe("Feature: Add state tax");
    expect(screen.getByTestId("agent-task").textContent).toBe("Add state tax. Cover NY and WA rates with tests.");
    expect(screen.getByText(/M2 · modify applyTax · in_progress/)).toBeTruthy();
    expect(screen.getByText("test/checkout.test.ts")).toBeTruthy();
    expect(screen.getByText("3m")).toBeTruthy();
    expect((screen.getByLabelText("progress").firstElementChild as HTMLElement).style.width).toBe("20%");

    openMenu();
    fireEvent.click(screen.getByText("Pause"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/agents/agent-masha/control");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ humanId: "andrii", control: "pause" });
  });

  it("shows Resume when paused and posts run; Stop posts stop; Urgent note posts a note", async () => {
    render(<AgentCard agentId="agent-a" humanId="a" status="paused" control="pause" actions={[]} viewer="andrii" />);
    expect(screen.getByText("Paused")).toBeTruthy();
    openMenu();
    fireEvent.click(screen.getByText("Resume"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ humanId: "andrii", control: "run" });

    openMenu();
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ humanId: "andrii", control: "stop" });

    openMenu();
    fireEvent.click(screen.getByText("Urgent"));
    const input = screen.getByLabelText("urgent note");
    fireEvent.change(input, { target: { value: "stop touching calculateTotal" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(url).toBe("/api/agents/agent-a/note");
    expect(JSON.parse(String(init.body))).toEqual({ humanId: "andrii", text: "stop touching calculateTotal", urgent: true });
  });

  it("maps agent + intent state to the mockup labels", () => {
    const conflict = { id: "X", agentId: "a", humanId: "a", status: "conflict" as const, createdAt: 0, updatedAt: 0, baseRev: 0, target: { file: "f", symbol: "s" }, action: "modify" as const, what: "w", input: "", output: "o" };
    expect(statusView("thinking", undefined, false).label).toBe("Working");
    expect(statusView("tool", { ...conflict, status: "done" }, true).label).toBe("Running tests");
    expect(statusView("thinking", conflict, false).label).toBe("Waiting on conflict");
    expect(statusView("paused", conflict, false).label).toBe("Paused");
    expect(statusView("idle", undefined, false).label).toBe("Idle");
    expect(statusView("done", undefined, false).label).toBe("Done");
    expect(elapsed(42_000)).toBe("42s");
    expect(elapsed(5 * 60_000)).toBe("5m");
  });
});
