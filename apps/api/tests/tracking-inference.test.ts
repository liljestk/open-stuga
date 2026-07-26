import type {
  AssetPositionEstimate,
  TrackingObservation,
  TrackingObserver,
  TrackingPropertySettings,
} from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { inferTrackedEquipmentPosition } from "../src/tracking/inference.js";

const now = new Date("2026-07-25T19:14:30.000Z");
const settings: TrackingPropertySettings = {
  propertyId: "property-main",
  enabled: true,
  propertyBoundary: [],
  liveNearbySeconds: 10,
  recentlySeenSeconds: 120,
  staleSeconds: 1_800,
  unknownSeconds: 604_800,
  movementThresholdMeters: 8,
  movementMaximumIntervalSeconds: 120,
  minimumMovementConfidence: 0.55,
  exitAlertDebounceSeconds: 120,
  updatedAt: now.toISOString(),
};

function observer(
  id: string,
  type: TrackingObserver["type"],
  options: Partial<TrackingObserver> = {},
): TrackingObserver {
  return {
    id,
    tenantId: "local",
    propertyId: "property-main",
    type,
    name: id,
    trustLevel: 1,
    fixedPosition: null,
    fixedPositionAccuracyMeters: null,
    zoneId: null,
    appInstallationId: null,
    hardwareMetadata: {},
    lastHeartbeatAt: now.toISOString(),
    status: "online",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...options,
  };
}

function observation(
  id: string,
  observerId: string,
  options: Partial<TrackingObservation> = {},
): TrackingObservation {
  return {
    id,
    tenantId: "local",
    propertyId: "property-main",
    tagId: "tag-1",
    observerId,
    observerType: "ios-phone",
    observedAt: new Date(now.getTime() - 2_000).toISOString(),
    receivedAt: now.toISOString(),
    rotatingTagId: "AQIDBAUGBwg",
    protocolVersion: 1,
    epochCounter: 1,
    eventCounter: 1,
    rssi: -67,
    txPower: null,
    motion: false,
    batteryPercent: 80,
    observerPosition: null,
    scanMode: "passive",
    appState: "foreground",
    deviceTimeOffsetMs: 0,
    qualityFlags: [],
    accepted: true,
    metadata: {},
    ...options,
  };
}

function infer(
  entries: Array<{ observation: TrackingObservation; observer: TrackingObserver }>,
  previous: AssetPositionEstimate | null = null,
) {
  return inferTrackedEquipmentPosition({
    equipmentId: "equipment-1",
    propertyId: "property-main",
    observations: entries,
    previous,
    settings,
    zones: [],
    now,
  });
}

describe("tracking location inference", () => {
  it("represents foreground proximity without fabricating a phone coordinate", () => {
    const phone = observer("phone-1", "ios-phone");
    const result = infer([{
      observer: phone,
      observation: observation("observation-1", phone.id, {
        scanMode: "find-nearby",
        rssi: -51,
        qualityFlags: ["LOCATION_UNAVAILABLE"],
      }),
    }]);

    expect(result.positionType).toBe("nearby-live");
    expect(result.coordinate).toBeNull();
    expect(result.accuracyRadiusMeters).toBeNull();
    expect(result.explanation.primaryFactors).toContain(
      "LIVE_PROXIMITY_WITHOUT_OBSERVER_COORDINATE",
    );
  });

  it("keeps a single-phone map estimate broad", () => {
    const phone = observer("phone-1", "ios-phone");
    const result = infer([{
      observer: phone,
      observation: observation("observation-1", phone.id, {
        rssi: -80,
        observerPosition: {
          latitude: 60.17,
          longitude: 24.93,
          horizontalAccuracyMeters: 5,
          source: "gps",
        },
      }),
    }]);

    expect(result.positionType).toBe("estimated-coordinate");
    expect(result.coordinate).toEqual({ latitude: 60.17, longitude: 24.93 });
    expect(result.accuracyRadiusMeters).toBeGreaterThanOrEqual(35);
  });

  it("requires persistent evidence before changing a fresh gateway zone", () => {
    const firstGateway = observer("gateway-a", "linux-gateway", { zoneId: "zone-a" });
    const initial = infer([{
      observer: firstGateway,
      observation: observation("observation-a", firstGateway.id, {
        observerType: "linux-gateway",
        scanMode: "gateway",
        rssi: -55,
      }),
    }]);
    const previous: AssetPositionEstimate = { ...initial, id: "estimate-1", version: 1 };
    const nextGateway = observer("gateway-b", "linux-gateway", { zoneId: "zone-b" });
    const isolated = infer([{
      observer: nextGateway,
      observation: observation("observation-b1", nextGateway.id, {
        observerType: "linux-gateway",
        scanMode: "gateway",
        rssi: -50,
      }),
    }], previous);

    expect(initial.zoneId).toBe("zone-a");
    expect(isolated.zoneId).toBe("zone-a");

    const persistent = infer([
      {
        observer: nextGateway,
        observation: observation("observation-b1", nextGateway.id, {
          observerType: "linux-gateway",
          scanMode: "gateway",
          rssi: -50,
        }),
      },
      {
        observer: nextGateway,
        observation: observation("observation-b2", nextGateway.id, {
          observerType: "linux-gateway",
          scanMode: "gateway",
          eventCounter: 2,
          observedAt: new Date(now.getTime() - 1_000).toISOString(),
          rssi: -52,
        }),
      },
    ], previous);

    expect(persistent.zoneId).toBe("zone-b");
  });
});
