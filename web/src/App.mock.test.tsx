import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App";
import { MOCK_EVENTS, MOCK_STEP_MS } from "./mock";

describe("App in ?mock=1 mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/?mock=1");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no server in mock mode"))));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("plays the scripted story without a server; the right column never switches on its own", async () => {
    render(<App />);
    expect(screen.getByText(/No agents yet/)).toBeTruthy();
    // Labelled spawn button in the tab bar and, large, in the empty state; hint names the two agents.
    expect(screen.getAllByRole("button", { name: /Spawn demo agents/ })).toHaveLength(2);
    expect(screen.getByText("Starts Alex (order.ts) and Nika (format.ts)")).toBeTruthy();
    expect(screen.getByText("mock")).toBeTruthy(); // connection state next to the Live dot
    expect(screen.getByTestId("mode-pill").textContent).toBe("hive");
    // No header counters anywhere on the main page.
    expect(screen.queryByText("conflicts before code")).toBeNull();
    expect(screen.queryByText("plan changes")).toBeNull();
    // Project tree lists the mock files grouped by folder.
    expect(screen.getByTestId("file-src/checkout.ts")).toBeTruthy();
    expect(screen.getByTestId("file-package.json")).toBeTruthy();

    // A few events in: both agents have cards; the Agents tab is selected.
    await act(async () => {
      vi.advanceTimersByTime(MOCK_STEP_MS * 3);
    });
    expect(screen.getByTestId("card-agent-andrii")).toBeTruthy();
    expect(screen.getByTestId("card-agent-masha")).toBeTruthy();
    // Your agent (agent-andrii) is running: the demo button is disabled and says why.
    const spawn = screen.getByRole("button", { name: /Spawn demo agents/ }) as HTMLButtonElement;
    expect(spawn.disabled).toBe(true);
    expect(spawn.title).toBe("Agents are running");
    const agentsTab = screen.getByRole("tab", { name: /^Agents/ });
    expect(agentsTab.getAttribute("aria-selected")).toBe("true");

    // Up to the culprit search start: still on Agents, red alert badge on Activity, running notice under the tiles.
    const searchIdx = MOCK_EVENTS.findIndex((e) => e.type === "culprit_search_started");
    await act(async () => {
      vi.advanceTimersByTime(MOCK_STEP_MS * (searchIdx + 1 - 3));
    });
    expect(screen.getByRole("tab", { name: /^Agents/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("activity-alerts").textContent).toBe("1");
    expect(screen.getByTestId("culprit-notice").textContent).toContain("Culprit search running");

    // Whole story: still on Agents; the notice names the culprits; tiles show tests passed.
    await act(async () => {
      vi.advanceTimersByTime(MOCK_STEP_MS * (MOCK_EVENTS.length + 2));
    });
    expect(screen.getByRole("tab", { name: /^Agents/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("culprit-notice").textContent).toBe("Culprit: andrii's A1 + masha's M2 together");
    expect(screen.getByTestId("tests-tile").textContent).toContain("6");
    expect(screen.getByTestId("tests-tile").textContent).toContain("@rev 6");

    // Mock editor shows the file with intent labels on the target symbol.
    expect(screen.getByTestId("mock-editor").textContent).toContain("calculateTotal");
    expect(screen.getByTestId("mock-editor").textContent).toContain("agent-andrii: add a shipping fee");

    // The user opens Activity: feed, culprit grid + banner, contracts, history are all there.
    fireEvent.click(screen.getByRole("tab", { name: /^Activity/ }));
    expect(screen.getByLabelText("feed").children.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: /Culprit/ }));
    expect(screen.getByRole("status").textContent).toContain("A1 alone ok, M2 alone ok, together red: conflict between A1 and M2");
    expect(screen.getByTestId("variant-green+A1").className).toContain("ok");
    expect(screen.getByTestId("variant-all").className).toContain("red");
    expect(screen.getAllByTestId(/^variant-/)).toHaveLength(5); // only this search's labels
    fireEvent.click(screen.getByRole("tab", { name: /Contracts/ }));
    expect(screen.getByTestId("contract-M1")).toBeTruthy();
    expect(screen.getByTestId("contract-M3")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /History/ }));
    expect(screen.getByText("add a shipping fee with free shipping over $50")).toBeTruthy();
    expect(screen.getByText("2 files changed")).toBeTruthy();

    // Clicking a file in the tree switches the editor.
    fireEvent.click(screen.getByTestId("file-test/checkout.test.ts"));
    expect(screen.getByTestId("mock-editor").textContent).toContain('describe("checkout"');

    // P switches the center column to the store preview (static sample in mock mode), P again back to code.
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByTestId("view-preview").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("preview")).toBeTruthy();
    expect(screen.getByTestId("receipt-lines").textContent).toContain("Items: 5");
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByTestId("mock-editor")).toBeTruthy();

    // The avatar popover holds the "you" field and the phone QR link.
    fireEvent.click(screen.getByLabelText("You"));
    expect((screen.getByLabelText("your human id") as HTMLInputElement).value).toBe("andrii");
    expect(screen.getByLabelText("QR code for the phone page")).toBeTruthy();
  });
});
