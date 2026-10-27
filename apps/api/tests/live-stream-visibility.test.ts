import { describe, expect, it } from "vitest";
import type { TelemetryEvent } from "@climate-twin/contracts";
import { visibleStreamEvent, type StreamAccess } from "../src/app/live-stream-visibility.js";

const occurredAt = "2026-10-27T12:00:00.000Z";

function access(restricted: boolean, granted: { houses?: string[]; sensors?: string[] } = {}): StreamAccess {
  return {
    restricted,
    house: (houseId) => !restricted || (granted.houses ?? []).includes(houseId),
    sensor: (sensorId) => !restricted || (granted.sensors ?? []).includes(sensorId),
  };
}

const mutation: TelemetryEvent = {
  type: "mutation",
  data: { method: "PUT", resource: "/tenant/members/guest@example.test/access", occurredAt },
};

describe("live stream visibility", () => {
  it("sends restricted principals a mutation refresh signal without the request path", () => {
    expect(visibleStreamEvent(mutation, access(true))).toEqual({
      type: "mutation",
      data: { method: "PUT", resource: "", occurredAt },
    });
    expect(visibleStreamEvent(mutation, access(false))).toBe(mutation);
  });

  it("keeps integration status from restricted principals", () => {
    const integration = { type: "integration", data: {} } as unknown as TelemetryEvent;
    expect(visibleStreamEvent(integration, access(true))).toBeNull();
    expect(visibleStreamEvent(integration, access(false))).toBe(integration);
  });

  it("scopes sensor and house events to grants", () => {
    const opening = { type: "opening", data: { houseId: "house-other" } } as unknown as TelemetryEvent;
    const alert = { type: "alert", data: { sensorId: "sensor-01" } } as unknown as TelemetryEvent;
    const guest = access(true, { houses: ["house-main"], sensors: ["sensor-01"] });
    expect(visibleStreamEvent(opening, guest)).toBeNull();
    expect(visibleStreamEvent(alert, guest)).toBe(alert);
    expect(visibleStreamEvent({ type: "heartbeat", data: { timestamp: occurredAt } }, guest)).not.toBeNull();
  });
});
