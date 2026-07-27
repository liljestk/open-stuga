import type {
  EquipmentLocationEstimate,
  TrackingObservation,
  TrackingObserver,
  TrackingPropertySettings,
} from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { inferTrackedEquipmentPosition } from "../src/tracking/inference.js";

const now = new Date("2026-07-27T12:00:00.000Z");
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
  observationRetentionDays: 14,
  rollupRetentionDays: 180,
  estimateRetentionDays: 730,
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
    observationId: id,
    idempotencyKey: `key-${id}`,
    dataMode: "demo",
    tenantId: "local",
    propertyId: "property-main",
    endpointId: "endpoint-1",
    equipmentId: "equipment-1",
    observerId,
    observerType: "ios-phone",
    observedAt: new Date(now.getTime() - 2_000).toISOString(),
    receivedAt: now.toISOString(),
    profileId: "org.bluetooth.ibeacon",
    profileVersion: "2026.07",
    rssi: -67,
    txPower: null,
    batteryPercent: 80,
    motion: null,
    counter: null,
    observerPosition: null,
    scanContext: "foreground",
    qualityFlags: [],
    trust: 1,
    telemetry: {},
    ...options,
  };
}

function infer(
  entries: Array<{ observation: TrackingObservation; observer: TrackingObserver }>,
  options: {
    previous?: EquipmentLocationEstimate | null;
    mapCapability?: "NEARBY" | "AREA" | "ZONE" | "COORDINATE";
    at?: Date;
  } = {},
) {
  return inferTrackedEquipmentPosition({
    dataMode: "demo",
    equipmentId: "equipment-1",
    propertyId: "property-main",
    endpointId: "endpoint-1",
    mapCapability: options.mapCapability ?? "ZONE",
    observations: entries,
    rollups: [],
    previous: options.previous ?? null,
    settings,
    now: options.at ?? now,
  });
}

describe("uncertainty-aware tracking inference", () => {
  it("uses current foreground Find evidence as nearby, not an exact device coordinate", () => {
    const phone = observer("phone-1", "ios-phone");
    const result = infer([{
      observer: phone,
      observation: observation("observation-1", phone.id, {
        scanContext: "foreground-find",
        rssi: -51,
        observerPosition: {
          latitude: 60.17,
          longitude: 24.93,
          horizontalAccuracyMeters: 6,
          source: "gps",
          capturedAt: new Date(now.getTime() - 1_000).toISOString(),
        },
      }),
    }], { mapCapability: "NEARBY" });

    expect(result).toMatchObject({
      kind: "nearby",
      source: "mobile-observer",
      freshness: "live",
      coordinate: { latitude: 60.17, longitude: 24.93 },
    });
    expect(result.uncertaintyRadiusMeters).toBeGreaterThan(6);
    expect(result.provenance.factors[0]).toMatch(/Find/u);
  });

  it("keeps opportunistic phone observations as a broad area estimate", () => {
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
          capturedAt: new Date(now.getTime() - 1_000).toISOString(),
        },
      }),
    }], { mapCapability: "AREA" });

    expect(result).toMatchObject({
      kind: "area",
      source: "mobile-observer",
      coordinate: { latitude: 60.17, longitude: 24.93 },
    });
    expect(result.uncertaintyRadiusMeters).toBeGreaterThanOrEqual(25);
    expect(result.confidence).toBeLessThanOrEqual(0.65);
  });

  it("uses a fixed gateway as zone evidence without fabricating coordinates", () => {
    const gateway = observer("gateway-1", "linux-gateway", { zoneId: "zone-shed" });
    const result = infer([{
      observer: gateway,
      observation: observation("observation-1", gateway.id, {
        observerType: "linux-gateway",
        scanContext: "fixed-gateway",
        rssi: -55,
      }),
    }], { mapCapability: "ZONE" });

    expect(result).toMatchObject({
      kind: "zone",
      zoneId: "zone-shed",
      coordinate: null,
      source: "fixed-gateway",
    });
  });

  it("decays the previous estimate during radio silence instead of inventing an exit", () => {
    const gateway = observer("gateway-1", "linux-gateway", { zoneId: "zone-shed" });
    const first = infer([{
      observer: gateway,
      observation: observation("observation-1", gateway.id, {
        observerType: "linux-gateway",
        scanContext: "fixed-gateway",
      }),
    }], { mapCapability: "ZONE" });
    const previous: EquipmentLocationEstimate = { ...first, id: "estimate-1", version: 1 };
    const later = infer([], {
      previous,
      mapCapability: "ZONE",
      at: new Date(now.getTime() + 31 * 60_000),
    });

    expect(later).toMatchObject({
      kind: "zone",
      zoneId: "zone-shed",
      freshness: "stale",
      movementState: "unknown",
    });
    expect(later.confidence).toBeLessThan(previous.confidence);
    expect(later.provenance.observationIds).toEqual([]);
    expect(later.provenance.factors[0]).toMatch(/No new evidence/u);
  });
});
