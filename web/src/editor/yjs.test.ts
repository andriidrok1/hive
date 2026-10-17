import { describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { RESET_CLOSE_CODE, YjsHub, type ProviderLike } from "./yjs";

type CloseCb = (event: { code?: number } | null) => void;

function fakeProvider() {
  const closeCbs = new Set<CloseCb>();
  const provider: ProviderLike & { emitClose(code: number): void; destroyed: boolean; user?: unknown } = {
    awareness: {
      setLocalStateField(_field, value) {
        provider.user = value;
      },
    },
    synced: false,
    destroyed: false,
    on(name: string, cb: unknown) {
      if (name === "connection-close") closeCbs.add(cb as CloseCb);
    },
    off() {},
    destroy() {
      provider.destroyed = true;
    },
    emitClose(code) {
      for (const cb of closeCbs) cb({ code });
    },
  };
  return provider;
}

describe("YjsHub reset handling", () => {
  it("replaces doc and provider on close code 4000 and notifies subscribers", () => {
    vi.useFakeTimers();
    const providers: ReturnType<typeof fakeProvider>[] = [];
    const docs: Y.Doc[] = [];
    const hub = new YjsHub((doc) => {
      docs.push(doc);
      const p = fakeProvider();
      providers.push(p);
      return p;
    });
    const changed = vi.fn();
    const reset = vi.fn();
    hub.subscribe(changed);
    hub.onReset(reset);

    const first = hub.snapshot();
    expect(hub.snapshot()).toBe(first); // stable until something happens
    hub.setUser("andrii");
    expect((providers[0]?.user as { name: string }).name).toBe("andrii");

    providers[0]?.emitClose(RESET_CLOSE_CODE);
    vi.runAllTimers(); // the handler is deferred out of the provider's own close handling
    const second = hub.snapshot();
    expect(second).not.toBe(first);
    expect(second.doc).not.toBe(first.doc);
    expect(second.generation).toBe(first.generation + 1);
    expect(providers[0]?.destroyed).toBe(true);
    expect(providers).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);

    // A stale close from the old provider after replacement does nothing.
    providers[0]?.emitClose(RESET_CLOSE_CODE);
    vi.runAllTimers();
    expect(hub.snapshot()).toBe(second);
    expect(providers).toHaveLength(2);
    vi.useRealTimers();
  });

  it("keeps the doc on an ordinary close so the provider reconnects itself", () => {
    const hub = new YjsHub(() => fakeProvider());
    const first = hub.snapshot();
    expect(hub.handleClose(1006)).toBe(false);
    expect(hub.handleClose(undefined)).toBe(false);
    expect(hub.snapshot()).toBe(first);
    expect(hub.handleClose(RESET_CLOSE_CODE)).toBe(true);
    expect(hub.snapshot()).not.toBe(first);
  });
});
