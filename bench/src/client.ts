import type { FeedEvent, HiveMode, HiveState, MergeResult, TestRequest, TestResult } from "@hive/shared";
import { FeedCounters } from "./feed.js";

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** The subset of the WHATWG WebSocket the feed subscription uses; Node 24's global WebSocket fits. */
export interface FeedSocket {
  addEventListener(type: "open" | "message" | "error" | "close", cb: (ev: { data?: unknown }) => void): void;
  close(): void;
}
export type FeedSocketFactory = (url: string) => FeedSocket;

export class HiveHttpError extends Error {
  constructor(public readonly status: number, public readonly path: string, body: string) {
    super(`${path} -> HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

/** Thin HTTP client for one Hive server. `fetchImpl` is injectable for tests. */
export class HiveClient {
  constructor(public readonly baseUrl: string, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new HiveHttpError(res.status, path, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  state(): Promise<HiveState> {
    return this.json<HiveState>("GET", "/api/state");
  }
  reset(mode: HiveMode): Promise<unknown> {
    return this.json("POST", "/api/reset", { mode });
  }
  startAgent(agentId: string, humanId: string, task: string): Promise<{ ok: boolean }> {
    return this.json("POST", "/api/agents", { agentId, humanId, task });
  }
  merge(): Promise<MergeResult> {
    return this.json<MergeResult>("POST", "/api/merge");
  }
  test(req: TestRequest): Promise<TestResult> {
    return this.json<TestResult>("POST", "/api/test", req);
  }

  /** ws://host/ws/feed for this server. */
  feedUrl(): string {
    return this.baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/feed";
  }
}

export interface FeedSubscription {
  counters: FeedCounters;
  close(): void;
}

/** Opens /ws/feed and counts every event until closed. Resolves once the socket is open. */
export function subscribeFeed(url: string, factory: FeedSocketFactory, openTimeoutMs = 10_000): Promise<FeedSubscription> {
  return new Promise((resolve, reject) => {
    const counters = new FeedCounters();
    let settled = false;
    const ws = factory(url);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`feed ${url}: not open after ${openTimeoutMs}ms`));
      }
    }, openTimeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ counters, close: () => ws.close() });
    });
    ws.addEventListener("message", (ev) => {
      try {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        counters.ingest(JSON.parse(raw) as FeedEvent);
      } catch {
        // ignore malformed frames
      }
    });
    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`feed ${url}: connection error`));
      }
    });
  });
}
