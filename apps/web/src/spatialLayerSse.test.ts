import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToSpatialLayerEvents } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("spatial layer event client", () => {
  it("handles the backend host's named snapshot-ID notification", () => {
    class FakeEventSource {
      static latest: FakeEventSource | null = null;
      readonly listeners = new Map<string, EventListener>();
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      closed = false;

      constructor(readonly url: string) { FakeEventSource.latest = this; }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === "function") this.listeners.set(type, listener);
      }
      close(): void { this.closed = true; }
      emit(type: string, data: unknown): void {
        this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onSnapshot = vi.fn();
    const dispose = subscribeToSpatialLayerEvents("house/main", onSnapshot, vi.fn());
    const source = FakeEventSource.latest;

    expect(source?.url).toContain("/api/v1/layers/events?scopeKind=house&scopeId=house%2Fmain");
    expect(source?.listeners.has("spatial-layer-snapshot")).toBe(true);
    source?.emit("spatial-layer-snapshot", {
      partition: { dataMode: "real", sourceDbId: "local" },
      scope: { kind: "house", id: "house/main" },
      snapshotIds: ["snapshot-1"],
      bucketAt: "2026-07-16T12:00:00.000Z",
      emittedAt: "2026-07-16T12:00:01.000Z",
    });
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "house", id: "house/main" },
      snapshotIds: ["snapshot-1"],
    }));
    dispose();
    expect(source?.closed).toBe(true);
  });
});
