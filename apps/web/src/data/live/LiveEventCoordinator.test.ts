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
  client.setQueryData(["house", "home-1", "analytics", "home-performance", "live"], {});
  client.setQueryData(["analytics", "opening-activity", "request"], {});
  client.setQueryData(["analytics", "calendar-comparison", "request"], {});
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
      ["analytics", "opening-activity", "request"],
      ["analytics", "calendar-comparison", "request"],
    ]) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
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
});
