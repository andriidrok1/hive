import type { AgentId, ToolArgs, ToolName, ToolResponse, ToolResults } from "@hive/shared";

export interface HiveClient {
  call<T extends ToolName>(tool: T, args: ToolArgs[T]): Promise<ToolResponse<ToolResults[T]>>;
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

// POST {baseUrl}/api/agents/:agentId/tools/:tool with the args as JSON body.
// fetchImpl is resolved at call time so tests can stub globalThis.fetch after construction.
export function httpClient(baseUrl: string, agentId: AgentId, fetchImpl?: FetchLike): HiveClient {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async call(tool, args) {
      const f: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
      const url = `${base}/api/agents/${encodeURIComponent(agentId)}/tools/${tool}`;
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args ?? {}),
      });
      const text = await res.text();
      if (res.status === 404) throw new Error(`hive: unknown agent or tool (${res.status}) at ${url}: ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text) as ToolResponse<never>;
      } catch {
        throw new Error(`hive: non-JSON response (${res.status}) from ${url}: ${text.slice(0, 200)}`);
      }
    },
  };
}
