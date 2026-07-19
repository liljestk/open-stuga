import type { AlertEvent, AlertRule, House, IntegrationStatus, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { deriveHouseMonitoring } from "./houseMonitoring";

const referenceTime = "2026-07-15T12:00:00.000Z";
const house: House = {
  id: "house-one",
  propertyId: "property-one",
  name: "House one",
  timezone: "UTC",
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const secondHouse: House = { ...house, id: "house-two", name: "House two" };
const sensor: Sensor = {
  id: "sensor-one",
  houseId: house.id,
  floorId: "floor-one",
  name: "Cellar",
  room: "Cellar",
  model: "T315",
  x: 1,
  y: 1,
  z: 1,
  tags: [],
  enabled: true,
};
const humidityRule: AlertRule = {
  id: "rule-humidity",
  name: "Humidity coverage",
  sensorId: sensor.id,
  metric: "humidity",
  operator: "gte",
  threshold: 70,
  durationSeconds: 900,
  severity: "warning",
  enabled: true,
  webhookEnabled: false,
  telegramEnabled: false,
};
const disconnectedIntegration: IntegrationStatus = {
  homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
  tpLink: { configured: true, connected: false, lastPollAt: "2026-07-15T11:50:00.000Z", mappedDevices: 1, discoveredDevices: 1, hubModel: "H100", error: "offline" },
  webhook: { configured: false, lastDeliveryAt: null, error: null },
  mock: { enabled: false, intervalMs: 2_000, mode: "real", activatedAt: "2026-01-01T00:00:00.000Z" },
  weather: { policy: "automatic", availableProviders: ["fmi", "open-meteo"], provider: "fmi", configuredHouses: 1, lastSuccessAt: null, error: null },
};

function sample(overrides: Partial<MeasurementSample> = {}): MeasurementSample {
  return {
    sensorId: sensor.id,
    metric: "temperature",
    value: 20,
    canonicalUnit: "°C",
    timestamp: "2026-07-15T11:50:00.000Z",
    source: "tp-link",
    quality: "good",
    ...overrides,
  };
}

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: "alert-one",
    ruleId: "rule-one",
    sensorId: sensor.id,
    metric: "temperature",
    value: 4,
    threshold: 8,
    severity: "critical",
    startedAt: "2026-07-15T11:30:00.000Z",
    acknowledgedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

function derive(overrides: Partial<Parameters<typeof deriveHouseMonitoring>[0]> = {}) {
  return deriveHouseMonitoring({
    house,
    sensors: [sensor],
    latestMeasurements: { [sensor.id]: { temperature: sample() } },
    alerts: [],
    referenceTime,
    ...overrides,
  });
}

describe("deriveHouseMonitoring", () => {
  it("returns monitoring-ok only when every enabled sensor has current trustworthy coverage", () => {
    const result = derive();
    expect(result.status).toBe("monitoring-ok");
    expect(result.coverage).toMatchObject({ enabledSensors: 1, freshSensors: 1, sensorsWithoutData: 0 });
    expect(result.blockers).toEqual([]);
  });

  it("reports unknown instead of all-clear when readings are missing, stale, or from the future", () => {
    expect(derive({ latestMeasurements: {} }).status).toBe("unknown");
    expect(derive({ latestMeasurements: { [sensor.id]: { temperature: sample({ quality: "stale" }) } } }).status).toBe("unknown");
    const future = derive({
      latestMeasurements: { [sensor.id]: { temperature: sample({ timestamp: "2026-07-15T12:10:00.000Z" }) } },
    });
    expect(future.status).toBe("unknown");
    expect(future.blockers.some((blocker) => blocker.kind === "missing-data")).toBe(true);
  });

  it("uses inspection-recommended for aging coverage while keeping its evidence time", () => {
    const freshSensor = { ...sensor, id: "sensor-fresh", name: "Kitchen" };
    const result = derive({
      sensors: [sensor, freshSensor],
      latestMeasurements: {
        [sensor.id]: { temperature: sample({ timestamp: "2026-07-15T10:45:00.000Z" }) },
        [freshSensor.id]: { temperature: sample({ sensorId: freshSensor.id }) },
      },
    });
    expect(result.status).toBe("inspection-recommended");
    expect(result.blockers).toContainEqual(expect.objectContaining({
      kind: "aging-data",
      sensorIds: [sensor.id],
      evidenceAt: "2026-07-15T10:45:00.000Z",
    }));
  });

  it("does not let a fresh unrelated metric hide a missing alert-rule input", () => {
    const result = derive({ alertRules: [humidityRule] });
    expect(result.status).toBe("unknown");
    expect(result.coverage).toMatchObject({ freshSensors: 0, sensorsWithoutData: 1 });
    expect(result.blockers[0]).toMatchObject({ kind: "missing-data", sensorIds: [sensor.id] });
  });

  it("requires inspection when the only current evidence is estimated", () => {
    const result = derive({
      latestMeasurements: { [sensor.id]: { temperature: sample({ quality: "estimated" }) } },
    });
    expect(result.status).toBe("inspection-recommended");
    expect(result.coverage).toMatchObject({ freshSensors: 0, estimatedSensors: 1 });
    expect(result.blockers[0]).toMatchObject({ kind: "estimated-data", sensorIds: [sensor.id] });
  });

  it("downgrades fresh readings whose configured source is disconnected", () => {
    const result = derive({ integration: disconnectedIntegration });
    expect(result.status).toBe("inspection-recommended");
    expect(result.blockers[0]).toMatchObject({ kind: "source-disconnected", sensorIds: [sensor.id] });
  });

  it("uses the sensor's TP-Link connection instead of another connection in the same Home", () => {
    const integration: IntegrationStatus = {
      ...disconnectedIntegration,
      tpLink: {
        ...disconnectedIntegration.tpLink,
        connected: true,
        connections: [
          { id: "working", houseId: house.id, configured: true, connected: true, lastPollAt: referenceTime, mappedDevices: 1, discoveredDevices: 1, hubModel: "H100", error: null },
          { id: "offline", houseId: house.id, configured: true, connected: false, lastPollAt: null, mappedDevices: 1, discoveredDevices: 1, hubModel: "H200", error: "offline" },
        ],
      },
    };
    const working = derive({ sensors: [{ ...sensor, tpLinkConnectionId: "working", tpLinkDeviceId: "meter" }], integration });
    expect(working.blockers.some((blocker) => blocker.kind === "source-disconnected")).toBe(false);

    const offline = derive({ sensors: [{ ...sensor, tpLinkConnectionId: "offline", tpLinkDeviceId: "meter" }], integration });
    expect(offline.blockers).toContainEqual(expect.objectContaining({ kind: "source-disconnected", sensorIds: [sensor.id] }));
  });

  it("keeps acknowledged unresolved alerts visible and lets critical conditions outrank missing data", () => {
    const result = derive({
      alerts: [alert({ acknowledgedAt: "2026-07-15T11:40:00.000Z" })],
      latestMeasurements: {},
    });
    expect(result.status).toBe("action-required");
    expect(result.blockers[0]).toMatchObject({ kind: "critical-alert", acknowledged: true });
    expect(result.blockers.some((blocker) => blocker.kind === "missing-data")).toBe(true);
  });

  it("explains unknown coverage before a lower-priority informational alert", () => {
    const result = derive({
      alerts: [alert({ severity: "info" })],
      latestMeasurements: {},
    });
    expect(result.status).toBe("unknown");
    expect(result.blockers.map((blocker) => blocker.kind)).toEqual(["missing-data", "information-alert"]);
  });

  it("ignores resolved alerts but retains unresolved incidents after a sensor is disabled", () => {
    const resolved = derive({ alerts: [alert({ resolvedAt: "2026-07-15T11:45:00.000Z" })] });
    expect(resolved.status).toBe("monitoring-ok");
    const disabled = derive({ sensors: [{ ...sensor, enabled: false }], latestMeasurements: {}, alerts: [alert()] });
    expect(disabled.status).toBe("action-required");
    expect(disabled.activeAlertCount).toBe(1);
    expect(disabled.blockers.map((blocker) => blocker.kind)).toEqual(["critical-alert", "no-sensors"]);
  });

  it("keeps telemetry and alerts scoped to the selected house", () => {
    const otherSensor = { ...sensor, id: "sensor-two", houseId: secondHouse.id };
    const result = derive({
      sensors: [sensor, otherSensor],
      latestMeasurements: {
        [sensor.id]: { temperature: sample() },
        [otherSensor.id]: { temperature: sample({ sensorId: otherSensor.id, quality: "stale" }) },
      },
      alerts: [alert({ id: "other-alert", sensorId: otherSensor.id })],
    });
    expect(result.status).toBe("monitoring-ok");
    expect(result.activeAlertCount).toBe(0);
    expect(result.coverage.enabledSensors).toBe(1);
  });
});
