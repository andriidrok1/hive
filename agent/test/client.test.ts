import { afterEach, describe, expect, it, vi } from "vitest";
import { httpClient } from "../src/index.js";

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

describe("httpClient (test 9)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to /api/agents/:agentId/tools/:tool with the args as JSON body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, data: { path: "src/a.ts", rev: 3 }, briefings: [], control: "run", rev: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = httpClient("http://localhost:4317/", "agent-andrii");
    const res = await client.call("edit_region", { intentId: "A1", path: "src/a.ts", oldText: "a", newText: "b" });

    expect(res).toEqual({ ok: true, data: { path: "src/a.ts", rev: 3 }, briefings: [], control: "run", rev: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock.mock.calls as unknown as [string, { method: string; headers: Record<string, string>; body: string }][])[0]!;
    expect(url).toBe("http://localhost:4317/api/agents/agent-andrii/tools/edit_region");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ intentId: "A1", path: "src/a.ts", oldText: "a", newText: "b" });
  });

  it("sends {} for list_files and returns ok:false envelopes as-is (HTTP 200)", async () => {
    const envelope = { ok: false, error: { code: "UNACKED_BRIEFINGS", message: "ack first" }, briefings: [], control: "run", rev: 9 };
    const fetchMock = vi.fn(async () => jsonResponse(200, envelope));
    vi.stubGlobal("fetch", fetchMock);
    const client = httpClient("http://localhost:4317", "agent-a");
    const res = await client.call("list_files", {});
    expect(res).toEqual(envelope);
    const [url, init] = (fetchMock.mock.calls as unknown as [string, { body: string }][])[0]!;
    expect(url).toBe("http://localhost:4317/api/agents/agent-a/tools/list_files");
    expect(init.body).toBe("{}");
  });

  it("throws on 404 (unknown agent) and on non-JSON bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, text: async () => "Not Found" })));
    await expect(httpClient("http://h", "ghost").call("list_files", {})).rejects.toThrow(/unknown agent/);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "<html>" })));
    await expect(httpClient("http://h", "agent-a").call("list_files", {})).rejects.toThrow(/non-JSON/);
  });

  it("accepts an injected fetch", async () => {
    const f = vi.fn(async () => jsonResponse(200, { ok: true, data: { files: [] }, briefings: [], control: "run", rev: 0 }));
    const client = httpClient("http://h", "agent-a", f);
    const res = await client.call("list_files", {});
    expect(res.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
