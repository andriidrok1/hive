import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_GAP_MS, DEMO_PRESETS, spawnDemoAgents } from "./demoPresets";
import { setMockSink } from "./api";
import { firstClause, getAgentTitle } from "./titles";

describe("spawnDemoAgents", () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  beforeEach(() => {
    vi.useFakeTimers();
    setMockSink(null);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts alex immediately and nika 3 s later with the preset tasks", async () => {
    const done = spawnDemoAgents();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const first = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(first[0]).toBe("/api/agents");
    const alex = DEMO_PRESETS[0];
    // The API body is exactly { agentId, humanId, task }; the title stays on the client.
    expect(JSON.parse(String(first[1].body))).toEqual({ agentId: alex?.agentId, humanId: alex?.humanId, task: alex?.task });
    expect(getAgentTitle("agent-alex")).toBe("Receipt and receipt width in order.ts");

    await vi.advanceTimersByTimeAsync(DEMO_GAP_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const nika = DEMO_PRESETS[1];
    expect(JSON.parse(String(second[1].body))).toEqual({ agentId: nika?.agentId, humanId: nika?.humanId, task: nika?.task });
    expect(getAgentTitle("agent-nika")).toBe("Negative prices and percent formatting in format.ts");
  });

  it("firstClause gives untitled agents a short summary", () => {
    expect(firstClause("Add state tax to checkout. Then write tests.")).toBe("Add state tax to checkout");
    expect(firstClause("Make formatPrice handle -1.50 values. More.")).toBe("Make formatPrice handle -1.50 values");
    expect(firstClause("x".repeat(100))).toHaveLength(70);
    expect(firstClause("short task")).toBe("short task");
  });

  it("presets match the demo script", () => {
    expect(DEMO_PRESETS.map((p) => p.agentId)).toEqual(["agent-alex", "agent-nika"]);
    expect(DEMO_PRESETS[0]?.task).toContain("receiptWidth(items, promo?)");
    expect(DEMO_PRESETS[0]?.task).toContain('"\\n"');
    // Final decision: Alex in src/order.ts, Nika in src/format.ts (separate files, separate test files).
    expect(DEMO_PRESETS[1]?.task).toContain("formatPercent(value)");
    expect(DEMO_PRESETS[1]?.task).toContain('"-$1.50" for -150');
    expect(DEMO_PRESETS[1]?.task).toContain('"7.5%" for 7.5');
    expect(DEMO_PRESETS[1]?.task).toContain("You own src/format.ts and test/format.test.ts.");
    expect(DEMO_PRESETS[0]?.task).toContain("In src/order.ts add two exported functions");
    expect(DEMO_PRESETS[0]?.task).toContain("Never edit orderSummary or its existing tests: if they go red, tell their owner via ask_agent and keep your own tests green.");
    expect(DEMO_PRESETS[0]?.task).not.toContain("do not change orderSummary itself");
  });
});
