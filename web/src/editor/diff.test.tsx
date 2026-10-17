import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { FLASH_MS, changedLines, changedRange } from "./diff";
import { MockEditor } from "./MockEditor";

describe("changedRange / changedLines", () => {
  it("finds the edited span and its lines", () => {
    expect(changedRange("abc", "abc")).toBeNull();
    expect(changedRange("hello world", "hello brave world")).toEqual({ from: 6, to: 12 });
    expect(changedRange("a\nb\nc", "a\nB\nc")).toEqual({ from: 2, to: 3 });
    expect(changedLines("a\nb\nc", "a\nB\nc")).toEqual([2]);
    expect(changedLines("a\nb\nc", "a\nb\nx\ny\nc")).toEqual([3, 4]);
    expect(changedLines("same", "same")).toEqual([]);
    // Pure deletion still points at one line.
    expect(changedLines("a\nb\nc", "a\nc")).toEqual([2]);
  });
});

describe("MockEditor live-writing flash", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flashes the changed lines in the agent colour, then clears after 1.5 s", () => {
    const v0 = "line one\nline two\nline three";
    const v1 = "line one\nline TWO\nline three";
    const { container, rerender } = render(<MockEditor content={v0} intents={[]} />);
    expect(container.querySelectorAll("[data-flash]")).toHaveLength(0);
    rerender(<MockEditor content={v1} intents={[]} lastEdit={{ rev: 1, agentId: "agent-masha", path: "src/x.ts" }} />);
    const flashed = container.querySelectorAll("[data-flash]");
    expect(flashed).toHaveLength(1);
    expect(flashed[0]?.textContent).toContain("line TWO");
    expect((flashed[0] as HTMLElement).style.getPropertyValue("--flash")).not.toBe("");
    act(() => {
      vi.advanceTimersByTime(FLASH_MS + 10);
    });
    expect(container.querySelectorAll("[data-flash]")).toHaveLength(0);
  });
});
