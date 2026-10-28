import { describe, expect, it } from "vitest";
import { decodeTelemetryEvent } from "./telemetry-events";

const reading = { sensorId: "sensor-1", timestamp: "2026-10-28T08:00:00.000Z", temperature: 21.5, humidity: 44, battery: null, source: "api", quality: "good" };

describe("decodeTelemetryEvent", () => {
  it("returns the event when the payload has the fields its consumers read", () => {
    expect(decodeTelemetryEvent("reading", reading)).toEqual({ type: "reading", data: reading });
    expect(decodeTelemetryEvent("heartbeat", { timestamp: "2026-10-28T08:00:00.000Z" })?.type).toBe("heartbeat");
    expect(decodeTelemetryEvent("mutation", { method: "PATCH", resource: "/sensors/a", occurredAt: "2026-10-28T08:00:00.000Z" })?.type).toBe("mutation");
  });

  it("drops payloads that are not that event type's shape", () => {
    expect(decodeTelemetryEvent("reading", { ...reading, humidity: "44" })).toBeNull();
    expect(decodeTelemetryEvent("alert", { id: "alert-1", sensorId: "sensor-1" })).toBeNull();
    expect(decodeTelemetryEvent("integration", { tpLink: {} })).toBeNull();
    expect(decodeTelemetryEvent("weather", { type: "weather.stale", houseId: "house-1", weather: {} })).toBeNull();
    expect(decodeTelemetryEvent("measurement", { sensorId: "sensor-1", metric: "co2", timestamp: "t", value: Number.NaN })).toBeNull();
    expect(decodeTelemetryEvent("heartbeat", null)).toBeNull();
    expect(decodeTelemetryEvent("opening", [])).toBeNull();
  });
});
