import { useSyncExternalStore } from "react";
import type { FeedEvent, FeedEventBody, HiveState } from "@hive/shared";
import { initialUiState, reduce, resync, type UiState } from "./state";
import { MOCK_EVENTS, MOCK_STEP_MS, mockHistoryAt, mockInitialState } from "./mock";
import { fetchState } from "./api";

export interface HiveStore {
  getState(): UiState;
  subscribe(cb: () => void): () => void;
  dispatch(e: FeedEvent): void;
  emit(body: FeedEventBody): void; // local event with a fresh id (mock mode and optimistic UI)
  update(fn: (s: UiState) => UiState): void;
}

export function createStore(initial: UiState = initialUiState()): HiveStore {
  let state = initial;
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((cb) => cb());
  return {
    getState: () => state,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    dispatch(e) {
      const next = reduce(state, e);
      if (next !== state) {
        state = next;
        notify();
      }
    },
    emit(body) {
      const e = { id: state.lastEventId + 1, ts: Date.now(), ...body } as FeedEvent;
      this.dispatch(e);
    },
    update(fn) {
      const next = fn(state);
      if (next !== state) {
        state = next;
        notify();
      }
    },
  };
}

export function useHive(store: HiveStore): UiState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

// ---------- Mock driver ----------

export function startMock(store: HiveStore, stepMs = MOCK_STEP_MS): () => void {
  store.update(() => ({ ...initialUiState(mockInitialState()), connection: "mock" }));
  let i = 0;
  const tick = () => {
    const e = MOCK_EVENTS[i++];
    if (!e) {
      clearInterval(timer);
      return;
    }
    store.emit(stripId(e));
    store.update((s) => ({ ...s, history: mockHistoryAt(s.lastEventId) }));
  };
  const timer = setInterval(tick, stepMs);
  return () => clearInterval(timer);
}

function stripId(e: FeedEvent): FeedEventBody {
  const { id: _id, ts: _ts, ...body } = e;
  return body as FeedEventBody;
}

// After POST /api/reset (Yjs close code 4000 or a restarted id counter): fresh state, counters from zero.
export async function resyncAfterReset(store: HiveStore): Promise<void> {
  try {
    const h = await fetchState();
    store.update((s) => resync(s, h, { reset: true }));
  } catch {
    // the feed socket's reconnect path re-syncs again
  }
}

// ---------- Live connection: GET /api/state, then /ws/feed with reconnect + re-sync ----------

export function connectLive(store: HiveStore): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let everOpen = false;

  const applyState = (h: HiveState, first: boolean) => {
    store.update((s) => (first ? { ...initialUiState(h), connection: s.connection } : resync(s, h)));
  };

  const open = async () => {
    if (closed) return;
    try {
      const h = await fetchState();
      applyState(h, !everOpen);
    } catch {
      // The socket handler below retries; keep whatever we have.
    }
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws/feed`);
    ws.onopen = () => {
      attempt = 0;
      store.update((s) => ({ ...s, connection: "open" }));
      if (everOpen) void fetchState().then((h) => applyState(h, false)).catch(() => undefined);
      everOpen = true;
    };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(String(m.data)) as FeedEvent;
        if (typeof e.id !== "number" || typeof e.type !== "string") return;
        // A live event with an id below what we already saw can only mean the server restarted
        // its counter: pull a fresh state instead of silently dropping everything that follows.
        if (e.id < store.getState().lastEventId) {
          void resyncAfterReset(store);
          return;
        }
        store.dispatch(e);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (closed) return;
      store.update((s) => ({ ...s, connection: "reconnecting" }));
      const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5));
      timer = setTimeout(() => void open(), delay);
    };
    ws.onerror = () => ws?.close();
  };
  void open();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
