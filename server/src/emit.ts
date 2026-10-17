import type { FeedEvent, FeedEventBody } from "@hive/shared";

export interface Emitter {
  /** Adds id and ts, stores it in the ring buffer, notifies subscribers, returns the full event. */
  emit(body: FeedEventBody): FeedEvent;
  /** Last 200 events, oldest first. */
  recent(): FeedEvent[];
  subscribe(cb: (e: FeedEvent) => void): () => void;
  /** Drops the ring buffer (used by /api/reset); ids keep growing. */
  clear(): void;
}

const KEEP = 200;

export function createEmitter(): Emitter {
  let nextId = 1;
  const ring: FeedEvent[] = [];
  const subs = new Set<(e: FeedEvent) => void>();
  return {
    emit(body) {
      const event = { id: nextId++, ts: Date.now(), ...body } as FeedEvent;
      ring.push(event);
      if (ring.length > KEEP) ring.splice(0, ring.length - KEEP);
      for (const cb of subs) {
        try {
          cb(event);
        } catch {
          // a broken subscriber must not break the producer
        }
      }
      return event;
    },
    recent() {
      return ring.slice();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    clear() {
      ring.length = 0;
    },
  };
}
