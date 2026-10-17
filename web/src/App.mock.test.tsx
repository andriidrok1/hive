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

  it("plays the scripted story and shows the culprit banner without a server", async () => {
    render(<App />);
    expect(screen.getByText(/No agents yet/)).toBeTruthy();
    expect(screen.getByText("mock")).toBeTruthy();
    // Project tree lists the mock files grouped by folder.
    expect(screen.getByTestId("file-src/checkout.ts")).toBeTruthy();
    expect(screen.getByTestId("file-package.json")).toBeTruthy();

    // A few events in: both agents have cards; the Activity tab shows feed lines.
    await act(async () => {
      vi.advanceTimersByTime(MOCK_STEP_MS * 3);
    });
    expect(screen.getByTestId("card-agent-andrii")).toBeTruthy();
    expect(screen.getByTestId("card-agent-masha")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    expect(screen.getByLabelText("feed").children.length).toBeGreaterThan(0);

    // Whole story: culprit sub-tab auto-opens, grid turns, banner names the pair.
    await act(async () => {
      vi.advanceTimersByTime(MOCK_STEP_MS * (MOCK_EVENTS.length + 2));
    });
    expect(screen.getByRole("status").textContent).toContain("A1 alone ok, M2 alone ok, together red: conflict between A1 and M2");
    expect(screen.getByTestId("variant-green+A1").className).toContain("ok");
    expect(screen.getByTestId("variant-all").className).toContain("red");

    // Counters in the header reflect the story: 1 contradiction caught, 4 plan changes, 1 search.
    expect(screen.getByText("conflicts before code").previousElementSibling?.textContent).toBe("1");
    expect(screen.getByText("plan changes").previousElementSibling?.textContent).toBe("4");
    expect(screen.getByText("culprit searches").previousElementSibling?.textContent).toBe("1");

    // Mock editor shows the file with intent labels on the target symbol.
    expect(screen.getByTestId("mock-editor").textContent).toContain("calculateTotal");
    expect(screen.getByTestId("mock-editor").textContent).toContain("agent-andrii: add a shipping fee");

    // Contracts and History sub-tabs still list the story; file tree footer counts changed files.
    fireEvent.click(screen.getByRole("tab", { name: /Contracts/ }));
    expect(screen.getByTestId("contract-M1")).toBeTruthy();
    expect(screen.getByTestId("contract-M3")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /History/ }));
    expect(screen.getByText("add a shipping fee with free shipping over $50")).toBeTruthy();
    expect(screen.getByText("2 files changed")).toBeTruthy();

    // Clicking a file in the tree switches the editor.
    fireEvent.click(screen.getByTestId("file-test/checkout.test.ts"));
    expect(screen.getByTestId("mock-editor").textContent).toContain("describe(\"checkout\"");
  });
});
