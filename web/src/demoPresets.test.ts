import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_GAP_MS, DEMO_PRESETS, spawnDemoAgents } from "./demoPresets";
import { setMockSink } from "./api";

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
    expect(JSON.parse(String(first[1].body))).toEqual(DEMO_PRESETS[0]);

    await vi.advanceTimersByTimeAsync(DEMO_GAP_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(second[1].body))).toEqual(DEMO_PRESETS[1]);
  });

  it("presets match the demo script", () => {
    expect(DEMO_PRESETS.map((p) => p.agentId)).toEqual(["agent-alex", "agent-nika"]);
    expect(DEMO_PRESETS[0]?.task).toContain("receiptWidth(items, promo?)");
    expect(DEMO_PRESETS[0]?.task).toContain('"\\n"');
    expect(DEMO_PRESETS[1]?.task).toContain("alignMoney(label, cents, width)");
    expect(DEMO_PRESETS[1]?.task).toContain('"-$1.50" for -150');
  });
});
