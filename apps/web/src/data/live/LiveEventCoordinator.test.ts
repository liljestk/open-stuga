import type { MeasurementSample, TelemetryEvent } from "@climate-twin/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  LiveEventCoordinator,
  invalidateForMeasurement,
  invalidateForTelemetry,
} from "./LiveEventCoordinator";

function clientWithQueries(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(["monitoring", "houses", "live"], {});
  client.setQueryData(["house", "home-1", "monitoring", "live"], {});
  client.setQueryData(["house", "home-2", "monitoring", "live"], {});
  client.setQueryData(["house", "home-1", "analytics", "home-performance", "live"], {});
  client.setQueryData(["house", "home-2", "analytics", "home-performance", "live"], {});
  client.setQueryData(["analytics", "opening-activity", "home-1", "request"], {});
  client.setQueryData(["analytics", "opening-activity", "home-2", "request"], {});
  client.setQueryData(["analytics", "calendar-comparison", "home-1", "request"], {});
  client.setQueryData(["analytics", "calendar-comparison", "home-2", "request"], {});
  client.setQueryData(["connected-devices", "home-1"], []);
  client.setQueryData(["connected-devices", "home-2"], []);
  return client;
}

describe("LiveEventCoordinator", () => {
  it("keeps routine measurements from invalidating Home Performance", async () => {
    const client = clientWithQueries();
    invalidateForMeasurement(client);
    await Promise.resolve();

    expect(client.getQueryState(["house", "home-1", "monitoring", "live"])?.isInvalidated).toBe(true);
    expect(
      client.getQueryState(["house", "home-1", "analytics", "home-performance", "live"])?.isInvalidated,
    ).toBe(false);
  });

  it("maps topology mutations to every affected derived query family", async () => {
    const client = clientWithQueries();
    invalidateForTelemetry(client, {
      type: "mutation",
      data: {
        method: "PATCH",
        resource: "/sensors/sensor-1",
        occurredAt: "2027-01-15T08:00:00Z",
      },
    });
    await Promise.resolve();

    for (const key of [
      ["house", "home-1", "monitoring", "live"],
      ["house", "home-1", "analytics", "home-performance", "live"],
      ["analytics", "opening-activity", "home-1", "request"],
      ["analytics", "calendar-comparison", "home-1", "request"],
      ["connected-devices", "home-1"],
    ]) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("invalidates only the affected Home detail for a scoped opening event", async () => {
    const client = clientWithQueries();
    invalidateForTelemetry(client, {
      type: "opening",
      data: {
        id: "opening-1",
        houseId: "home-1",
        floorId: "floor-1",
        elementId: "window-1",
        state: "open",
        source: "manual",
        observedAt: "2027-01-15T08:00:00Z",
      },
    }, "home-1");
    await Promise.resolve();

    expect(client.getQueryState(["monitoring", "houses", "live"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["house", "home-1", "monitoring", "live"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["house", "home-2", "monitoring", "live"])?.isInvalidated).toBe(false);
    expect(
      client.getQueryState(["analytics", "opening-activity", "home-1", "request"])?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(["analytics", "opening-activity", "home-2", "request"])?.isInvalidated,
    ).toBe(false);
  });

  it("owns exactly one subscription to each transport and disposes both once", () => {
    let onTelemetry: ((event: TelemetryEvent) => void) | undefined;
    let onMeasurement: ((sample: MeasurementSample) => void) | undefined;
    const stopLegacy = vi.fn();
    const stopMeasurements = vi.fn();
    const handlers = {
      onTelemetry: vi.fn(),
      onMeasurement: vi.fn(),
      onConnection: vi.fn(),
      onOpen: vi.fn(),
    };
    const coordinator = new LiveEventCoordinator(new QueryClient(), {
      legacy: vi.fn((next) => {
        onTelemetry = next;
        return stopLegacy;
      }),
      measurements: vi.fn((next) => {
        onMeasurement = next;
        return stopMeasurements;
      }),
    });

    const stop = coordinator.start(handlers);
    onTelemetry?.({ type: "heartbeat", data: {} } as TelemetryEvent);
    onMeasurement?.({
      sensorId: "sensor-1",
      metric: "temperature",
      value: 20,
      canonicalUnit: "°C",
      timestamp: "2027-01-15T08:00:00Z",
      source: "api",
      quality: "good",
    });
    stop();
    stop();

    expect(handlers.onTelemetry).toHaveBeenCalledOnce();
    expect(handlers.onMeasurement).toHaveBeenCalledOnce();
    expect(stopLegacy).toHaveBeenCalledOnce();
    expect(stopMeasurements).toHaveBeenCalledOnce();
  });

  it("coalesces duplicate reading and measurement refreshes into one invalidation", async () => {
    vi.useFakeTimers();
    try {
      let onTelemetry: ((event: TelemetryEvent) => void) | undefined;
      let onMeasurement: ((sample: MeasurementSample) => void) | undefined;
      const client = clientWithQueries();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const coordinator = new LiveEventCoordinator(client, {
        legacy: vi.fn((next) => {
          onTelemetry = next;
          return vi.fn();
        }),
        measurements: vi.fn((next) => {
          onMeasurement = next;
          return vi.fn();
        }),
      });
      const stop = coordinator.start({
        onTelemetry: vi.fn(),
        onMeasurement: vi.fn(),
        onConnection: vi.fn(),
        onOpen: vi.fn(),
        houseIdForSensor: (sensorId) => sensorId === "sensor-1" ? "home-1" : null,
      });
      const timestamp = "2027-01-15T08:00:00Z";
      for (let index = 0; index < 5; index += 1) {
        onTelemetry?.({
          type: "reading",
          data: {
            sensorId: "sensor-1",
            timestamp,
            temperature: 20,
            humidity: 50,
            battery: null,
            source: "api",
            quality: "good",
          },
        });
        onMeasurement?.({
          sensorId: "sensor-1",
          metric: "temperature",
          value: 20,
          canonicalUnit: "Â°C",
          timestamp,
          source: "api",
          quality: "good",
        });
      }

      expect(invalidate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(invalidate).toHaveBeenCalledOnce();
      expect(client.getQueryState(["house", "home-1", "monitoring", "live"])?.isInvalidated).toBe(true);
      expect(client.getQueryState(["house", "home-2", "monitoring", "live"])?.isInvalidated).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles monitoring invalidation during sustained measurement traffic", async () => {
    vi.useFakeTimers();
    try {
      let onMeasurement: ((sample: MeasurementSample) => void) | undefined;
      const client = clientWithQueries();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const coordinator = new LiveEventCoordinator(client, {
        legacy: vi.fn(() => vi.fn()),
        measurements: vi.fn((next) => {
          onMeasurement = next;
          return vi.fn();
        }),
      });
      const stop = coordinator.start({
        onTelemetry: vi.fn(),
        onMeasurement: vi.fn(),
        onConnection: vi.fn(),
        onOpen: vi.fn(),
        houseIdForSensor: () => "home-1",
      });
      const sample: MeasurementSample = {
        sensorId: "sensor-1",
        metric: "temperature",
        value: 20,
        canonicalUnit: "°C",
        timestamp: "2027-01-15T08:00:00Z",
        source: "api",
        quality: "good",
      };

      onMeasurement?.(sample);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(invalidate).toHaveBeenCalledOnce();

      onMeasurement?.({ ...sample, timestamp: "2027-01-15T08:00:02Z" });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(invalidate).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(invalidate).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers monitoring invalidation while the tab is hidden", async () => {
    vi.useFakeTimers();
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    let stop: (() => void) | undefined;
    try {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      let onMeasurement: ((sample: MeasurementSample) => void) | undefined;
      const client = clientWithQueries();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const coordinator = new LiveEventCoordinator(client, {
        legacy: vi.fn(() => vi.fn()),
        measurements: vi.fn((next) => {
          onMeasurement = next;
          return vi.fn();
        }),
      });
      stop = coordinator.start({
        onTelemetry: vi.fn(),
        onMeasurement: vi.fn(),
        onConnection: vi.fn(),
        onOpen: vi.fn(),
        houseIdForSensor: () => "home-1",
      });

      onMeasurement?.({
        sensorId: "sensor-1",
        metric: "temperature",
        value: 20,
        canonicalUnit: "°C",
        timestamp: "2027-01-15T08:00:00Z",
        source: "api",
        quality: "good",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(invalidate).not.toHaveBeenCalled();

      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(invalidate).toHaveBeenCalledOnce();
    } finally {
      stop?.();
      if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
      vi.useRealTimers();
    }
  });
});
