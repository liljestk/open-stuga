import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("cross-tab auth epoch", () => {
  it("broadcasts only an opaque epoch and revalidates on a valid external message", async () => {
    class FakeBroadcastChannel {
      static latest: FakeBroadcastChannel | null = null;
      readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
      readonly posted: unknown[] = [];

      constructor(readonly name: string) { FakeBroadcastChannel.latest = this; }
      postMessage(value: unknown) { this.posted.push(value); }
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        if (typeof listener === "function") this.listeners.add(listener as (event: MessageEvent<unknown>) => void);
      }
      removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        if (typeof listener === "function") this.listeners.delete(listener as (event: MessageEvent<unknown>) => void);
      }
      emit(data: unknown) { for (const listener of this.listeners) listener(new MessageEvent("message", { data })); }
    }
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const { publishAuthEpoch, subscribeToAuthEpoch } = await import("./authEpoch");
    const listener = vi.fn();
    const dispose = subscribeToAuthEpoch(listener);

    publishAuthEpoch();

    const channel = FakeBroadcastChannel.latest!;
    expect(channel.name).toBe("stuga-local-auth-epoch");
    expect(channel.posted).toHaveLength(1);
    expect(Object.keys(channel.posted[0] as object).sort()).toEqual(["epoch", "type"]);
    expect(channel.posted[0]).toMatchObject({ type: "auth-epoch", epoch: expect.any(String) });
    channel.emit(channel.posted[0]);
    expect(listener).toHaveBeenCalledOnce();
    channel.emit({ type: "auth-epoch", epoch: 123, csrfToken: "must-not-be-consumed" });
    expect(listener).toHaveBeenCalledOnce();
    dispose();
  });

  it("does not make authentication fail when BroadcastChannel is blocked", async () => {
    vi.stubGlobal("BroadcastChannel", class {
      constructor() { throw new DOMException("Blocked", "SecurityError"); }
    });
    const { publishAuthEpoch, subscribeToAuthEpoch } = await import("./authEpoch");

    expect(() => publishAuthEpoch()).not.toThrow();
    expect(() => subscribeToAuthEpoch(vi.fn())()).not.toThrow();
  });
});
