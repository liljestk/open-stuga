import type {
  AlertEvent,
  AlertRule,
  House,
  MeasurementSample,
  Sensor,
  WeatherWarning,
} from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveHomeInsights,
  deriveHomePulse,
  HOME_INSIGHT_ADVISORY,
  type HomeInsightInput,
} from "./homeInsights";

const NOW = "2026-07-14T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const house: House = {
  id: "house-1",
  propertyId: "property-1",
  name: "Pine House",
  timezone: "Europe/Helsinki",
  floors: [{
    id: "floor-1",
    name: "Ground floor",
    width: 100,
    height: 100,
    elevation: 0,
    walls: [],
    rooms: [],
  }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function sensor(id: string, room: string, overrides: Partial<Sensor> = {}): Sensor {
  return {
    id,
    houseId: house.id,
    floorId: "floor-1",
    name: `${room} sensor`,
    room,
    model: "Tapo T315",
    x: 10,
    y: 10,
    z: 1.2,
    tags: [],
    enabled: true,
    ...overrides,
  };
}

function sample(
  target: Sensor,
  metric: string,
  value: number,
  minutesAgo: number,
  overrides: Partial<MeasurementSample> = {},
): MeasurementSample {
  const units: Record<string, string> = { temperature: "\u00b0C", humidity: "%", co2: "ppm" };
  return {
    sensorId: target.id,
    metric,
    value,
    canonicalUnit: units[metric] ?? "",
    timestamp: new Date(NOW_MS - minutesAgo * 60_000).toISOString(),
    source: "tp-link",
    quality: "good",
    ...overrides,
  };
}

function baseInput(overrides: Partial<HomeInsightInput> = {}): HomeInsightInput {
  return {
    house,
    sensors: [],
    latestMeasurements: {},
    referenceTime: NOW,
    ...overrides,
  };
}

function warning(overrides: Partial<WeatherWarning> = {}): WeatherWarning {
  return {
    id: "wind-warning",
    event: "Strong wind",
    headline: "Strong wind warning",
    description: "Strong gusts expected",
    severity: "severe",
    urgency: "immediate",
    certainty: "likely",
    effectiveAt: "2026-07-14T10:00:00.000Z",
    onsetAt: "2026-07-14T10:00:00.000Z",
    expiresAt: "2026-07-14T14:00:00.000Z",
    areas: ["Uusimaa"],
    web: null,
    ...overrides,
  };
}

describe("deriveHomePulse", () => {
  it("returns a steady, evidence-backed empty pulse when fresh readings need no action", () => {
    const living = sensor("living", "Living room");
    const office = sensor("office", "Office");
    const latest = {
      [living.id]: {
        temperature: sample(living, "temperature", 21.2, 3),
        humidity: sample(living, "humidity", 43, 3),
        co2: sample(living, "co2", 650, 3),
      },
      [office.id]: {
        temperature: sample(office, "temperature", 21.8, 4),
        humidity: sample(office, "humidity", 46, 4),
        co2: sample(office, "co2", 720, 4),
      },
    };
    const before = JSON.stringify(latest);

    const pulse = deriveHomePulse(baseInput({ sensors: [living, office], latestMeasurements: latest }));

    expect(pulse).toMatchObject({
      houseId: house.id,
      generatedAt: NOW,
      status: "steady",
      coverage: { enabledSensors: 2, freshSensors: 2, estimatedSensors: 0, agingSensors: 0, staleSensors: 0, sensorsWithoutData: 0 },
      insights: [],
      advisory: HOME_INSIGHT_ADVISORY,
    });
    expect(JSON.stringify(latest)).toBe(before);
  });

  it("requires current data for each enabled alert-rule metric", () => {
    const living = sensor("living", "Living room");
    const rule: AlertRule = {
      id: "humidity-rule",
      name: "Humidity",
      sensorId: living.id,
      metric: "humidity",
      operator: "gte",
      threshold: 70,
      durationSeconds: 900,
      severity: "warning",
      enabled: true,
      webhookEnabled: false,
      telegramEnabled: false,
    };
    const pulse = deriveHomePulse(baseInput({
      sensors: [living],
      latestMeasurements: { [living.id]: { temperature: sample(living, "temperature", 21, 2) } },
      alertRules: [rule],
    }));

    expect(pulse.coverage).toMatchObject({ freshSensors: 0, estimatedSensors: 0, sensorsWithoutData: 1 });
    expect(pulse.sensorCoverage).toEqual([{
      sensorId: living.id,
      requiredMetrics: ["humidity"],
      freshness: { state: "unknown", evidenceAt: null, ageMinutes: null },
    }]);
    expect(pulse.insights[0]).toMatchObject({ kind: "sensor-coverage", target: { sensorId: living.id } });
  });

  it("limits all-sensor alert coverage to sensors that support the rule metric", () => {
    const healthyClimate = sensor("healthy-climate", "Living room", {
      model: "T310",
      tpLinkDeviceId: "climate-healthy",
    });
    const missingHumidity = sensor("missing-humidity", "Cellar", {
      model: "T315",
      tpLinkDeviceId: "climate-missing",
    });
    const wattMeter = sensor("watt-meter", "Office", {
      model: "HS110(EU)",
      tpLinkDeviceId: "energy-meter",
    });
    const globalHumidityRule: AlertRule = {
      id: "global-humidity",
      name: "Persistent high humidity",
      sensorId: null,
      metric: "humidity",
      operator: "gte",
      threshold: 65,
      durationSeconds: 900,
      severity: "warning",
      enabled: true,
      webhookEnabled: false,
      telegramEnabled: false,
    };
    const pulse = deriveHomePulse(baseInput({
      sensors: [healthyClimate, missingHumidity, wattMeter],
      latestMeasurements: {
        [healthyClimate.id]: {
          temperature: sample(healthyClimate, "temperature", 21, 2),
          humidity: sample(healthyClimate, "humidity", 48, 2),
        },
        [missingHumidity.id]: {
          temperature: sample(missingHumidity, "temperature", 16, 2),
        },
        [wattMeter.id]: {
          power: sample(wattMeter, "power", 84, 1),
          energy: sample(wattMeter, "energy", 1.86, 2),
        },
      },
      alertRules: [globalHumidityRule],
    }));

    expect(pulse.coverage).toEqual({
      enabledSensors: 3,
      freshSensors: 2,
      estimatedSensors: 0,
      agingSensors: 0,
      staleSensors: 0,
      sensorsWithoutData: 1,
    });
    expect(pulse.sensorCoverage).toEqual(expect.arrayContaining([
      {
        sensorId: missingHumidity.id,
        requiredMetrics: ["humidity", "temperature"],
        freshness: { state: "unknown", evidenceAt: null, ageMinutes: null },
      },
      {
        sensorId: wattMeter.id,
        requiredMetrics: [],
        freshness: { state: "fresh", evidenceAt: "2026-07-14T11:59:00.000Z", ageMinutes: 1 },
      },
    ]));
    expect(pulse.insights.find((insight) => insight.kind === "sensor-coverage")).toMatchObject({
      title: `${missingHumidity.name} needs a data check`,
      target: { sensorId: missingHumidity.id },
    });
  });

  it("keeps estimated-only coverage out of the confirmed steady state", () => {
    const living = sensor("living", "Living room");
    const pulse = deriveHomePulse(baseInput({
      sensors: [living],
      latestMeasurements: {
        [living.id]: { temperature: sample(living, "temperature", 21, 2, { quality: "estimated" }) },
      },
    }));

    expect(pulse.coverage).toMatchObject({ freshSensors: 0, estimatedSensors: 1 });
    expect(pulse.status).toBe("watch");
    expect(pulse.insights[0]).toMatchObject({ kind: "sensor-coverage", severity: "notice" });
  });

  it("does not treat battery telemetry as confirmation of indoor conditions", () => {
    const living = sensor("living", "Living room");
    const pulse = deriveHomePulse(baseInput({
      sensors: [living],
      latestMeasurements: {
        [living.id]: { battery: sample(living, "battery", 94, 2) },
      },
    }));

    expect(pulse.coverage).toMatchObject({ freshSensors: 0, sensorsWithoutData: 1 });
    expect(pulse.status).toBe("attention");
  });

  it("recognizes sustained humidity and uses dry outdoor air as supporting context", () => {
    const bathroom = sensor("bathroom", "Bathroom");
    const humidityHistory = [
      sample(bathroom, "humidity", 67, 100),
      sample(bathroom, "humidity", 69, 70),
      sample(bathroom, "humidity", 71, 40),
      sample(bathroom, "humidity", 72, 5),
    ];
    // Deliberately unsorted to verify that trend derivation does not depend on input order.
    const pulse = deriveHomePulse(baseInput({
      sensors: [bathroom],
      latestMeasurements: {
        [bathroom.id]: {
          temperature: sample(bathroom, "temperature", 22, 5),
          humidity: humidityHistory.at(-1)!,
        },
      },
      measurementHistory: {
        [bathroom.id]: { humidity: [humidityHistory[2]!, humidityHistory[0]!, humidityHistory[3]!, humidityHistory[1]!] },
      },
      outdoor: {
        stale: false,
        current: {
          timestamp: "2026-07-14T11:55:00.000Z",
          temperatureC: 5,
          relativeHumidityPercent: 70,
          windSpeedMps: 2,
        },
      },
    }));

    expect(pulse.status).toBe("attention");
    expect(pulse.insights).toHaveLength(1);
    expect(pulse.insights[0]).toMatchObject({
      rank: 1,
      id: "humidity:bathroom",
      kind: "humidity",
      severity: "warning",
      target: {
        houseId: house.id,
        sensorId: bathroom.id,
        floorName: "Ground floor",
        room: "Bathroom",
      },
      freshness: { state: "fresh", ageMinutes: 5 },
      confidence: { level: "high" },
    });
    expect(pulse.insights[0]!.title).toContain("stayed elevated");
    expect(pulse.insights[0]!.summary).toContain("4 of 4 readings");
    expect(pulse.insights[0]!.action).toContain("outdoor air currently carries less moisture");
    expect(pulse.insights[0]!.evidence.map((item) => item.label)).toEqual(expect.arrayContaining([
      "Latest humidity",
      "Elevated readings",
      "Indoor dew point",
      "Outdoor dew point",
    ]));
    expect(pulse.insights[0]!.safetyNote).toContain("does not detect mold");
  });

  it("prefers extraction when fresh outdoor air is not actually drier", () => {
    const bathroom = sensor("bathroom", "Bathroom");
    const insights = deriveHomeInsights(baseInput({
      sensors: [bathroom],
      latestMeasurements: {
        [bathroom.id]: {
          temperature: sample(bathroom, "temperature", 22, 2),
          humidity: sample(bathroom, "humidity", 70, 2),
        },
      },
      outdoor: {
        conditions: {
          timestamp: "2026-07-14T11:58:00.000Z",
          temperatureC: 28,
          relativeHumidityPercent: 90,
          windSpeedMps: 1,
        },
      },
    }));

    expect(insights[0]?.kind).toBe("humidity");
    expect(insights[0]?.action).toContain("Prefer the extractor or a dehumidifier");
    expect(insights[0]?.action).toContain("outdoor air is not currently drier");
    expect(insights[0]?.confidence.level).toBe("medium");
  });

  it("keeps high-CO2 advice conservative during an active severe weather warning", () => {
    const office = sensor("office", "Office");
    const insight = deriveHomeInsights(baseInput({
      sensors: [office],
      latestMeasurements: {
        [office.id]: { co2: sample(office, "co2", 1_720, 4) },
      },
      outdoor: {
        stale: false,
        current: {
          timestamp: "2026-07-14T11:55:00.000Z",
          temperatureC: 16,
          windSpeedMps: 8,
        },
        warnings: [warning()],
      },
    }))[0]!;

    expect(insight).toMatchObject({ kind: "indoor-air", severity: "warning", target: { room: "Office" } });
    expect(insight.action).toContain("Increase mechanical ventilation");
    expect(insight.action).toContain("do not open windows solely on this insight");
    expect(insight.action).toContain("active severe weather warning");
    expect(insight.safetyNote).toContain("not a medical diagnosis");
  });

  it("does not treat a severe UV advisory as a reason to avoid airing", () => {
    const office = sensor("office", "Office");
    const insight = deriveHomeInsights(baseInput({
      sensors: [office],
      latestMeasurements: {
        [office.id]: { co2: sample(office, "co2", 1_720, 4) },
      },
      outdoor: {
        stale: false,
        current: {
          timestamp: "2026-07-14T11:55:00.000Z",
          temperatureC: 16,
          windSpeedMps: 2,
        },
        warnings: [warning({ event: "UV advisory", headline: "High ultraviolet radiation" })],
      },
    }))[0]!;

    expect(insight.action).toContain("Current outdoor conditions support a short, supervised airing");
    expect(insight.action).not.toContain("active severe weather warning");
  });

  it("prioritizes an open alert, uses its rule name, and suppresses a duplicate inferred condition", () => {
    const bathroom = sensor("bathroom", "Bathroom");
    const openAlert: AlertEvent = {
      id: "alert-humidity",
      ruleId: "rule-humidity",
      sensorId: bathroom.id,
      metric: "humidity",
      value: 78,
      threshold: 65,
      severity: "warning",
      startedAt: "2026-07-14T11:40:00.000Z",
      acknowledgedAt: null,
      resolvedAt: null,
    };
    const duplicateLowerAlert: AlertEvent = {
      ...openAlert,
      id: "alert-humidity-info",
      ruleId: "rule-humidity-info",
      severity: "info",
    };
    const resolvedAlert: AlertEvent = {
      ...openAlert,
      id: "resolved-alert",
      metric: "co2",
      resolvedAt: "2026-07-14T11:50:00.000Z",
    };
    const rule: AlertRule = {
      id: "rule-humidity",
      name: "Sustained high humidity",
      sensorId: null,
      metric: "humidity",
      operator: "gte",
      threshold: 65,
      durationSeconds: 900,
      severity: "warning",
      enabled: true,
      webhookEnabled: false,
      telegramEnabled: false,
    };

    const insights = deriveHomeInsights(baseInput({
      sensors: [bathroom],
      latestMeasurements: {
        [bathroom.id]: {
          temperature: sample(bathroom, "temperature", 22, 2),
          humidity: sample(bathroom, "humidity", 79, 2),
        },
      },
      alerts: [duplicateLowerAlert, resolvedAlert, openAlert],
      alertRules: [rule],
    }));

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      id: "active-alert:alert-humidity",
      rank: 1,
      kind: "active-alert",
      title: "Sustained high humidity - Bathroom",
      freshness: { state: "fresh", ageMinutes: 2 },
      confidence: { level: "high", score: 0.96 },
    });
    expect(insights[0]!.evidence.map((item) => item.label)).toEqual(expect.arrayContaining([
      "Latest reading",
      "Alert value",
      "Trigger threshold",
    ]));
    expect(insights.some((item) => item.id === `humidity:${bathroom.id}`)).toBe(false);
  });

  it("ranks deterministically, honors the cap, and never leaks another house's alert", () => {
    const utility = sensor("utility", "Utility");
    const office = sensor("office", "Office");
    const bathroom = sensor("bathroom", "Bathroom");
    const foreign = sensor("foreign", "Foreign room", { houseId: "house-2" });
    const latest = {
      [utility.id]: { temperature: sample(utility, "temperature", 6, 2) },
      [office.id]: { co2: sample(office, "co2", 1_800, 2) },
      [bathroom.id]: { humidity: sample(bathroom, "humidity", 82, 2) },
      [foreign.id]: { temperature: sample(foreign, "temperature", 40, 2) },
    };
    const foreignAlert: AlertEvent = {
      id: "foreign-critical",
      ruleId: "foreign-rule",
      sensorId: foreign.id,
      metric: "temperature",
      value: 40,
      threshold: 35,
      severity: "critical",
      startedAt: "2026-07-14T11:50:00.000Z",
      acknowledgedAt: null,
      resolvedAt: null,
    };
    const first = deriveHomeInsights(baseInput({
      sensors: [utility, office, foreign, bathroom],
      latestMeasurements: latest,
      alerts: [foreignAlert],
      maxInsights: 2,
    }));
    const second = deriveHomeInsights(baseInput({
      sensors: [bathroom, foreign, office, utility],
      latestMeasurements: latest,
      alerts: [foreignAlert],
      maxInsights: 2,
    }));

    expect(second).toEqual(first);
    expect(first.map((item) => item.kind)).toEqual(["temperature", "indoor-air"]);
    expect(first.map((item) => item.rank)).toEqual([1, 2]);
    expect(first.every((item) => item.target.houseId === house.id)).toBe(true);
    expect(first.some((item) => item.id.includes("foreign"))).toBe(false);
  });

  it("finds a room-to-room temperature imbalance and targets the cooler room", () => {
    const bedroom = sensor("bedroom", "Bedroom");
    const living = sensor("living", "Living room");
    const office = sensor("office", "Office");
    const insight = deriveHomeInsights(baseInput({
      sensors: [living, bedroom, office],
      latestMeasurements: {
        [bedroom.id]: { temperature: sample(bedroom, "temperature", 18, 3) },
        [living.id]: { temperature: sample(living, "temperature", 22, 4) },
        [office.id]: { temperature: sample(office, "temperature", 23.5, 2) },
      },
    }))[0]!;

    expect(insight).toMatchObject({
      kind: "temperature-balance",
      severity: "warning",
      title: "Rooms differ by 5.5\u00b0C",
      target: { sensorId: bedroom.id, room: "Bedroom" },
      confidence: { level: "high" },
    });
    expect(insight.summary).toBe("Bedroom is 18\u00b0C while Office is 23.5\u00b0C.");
  });

  it("separates aging, explicitly stale, missing, and implausibly future sensor data", () => {
    const aging = sensor("aging", "Hall");
    const stale = sensor("stale", "Utility");
    const future = sensor("future", "Office");
    const pulse = deriveHomePulse(baseInput({
      sensors: [aging, stale, future],
      latestMeasurements: {
        [aging.id]: { temperature: sample(aging, "temperature", 20, 31) },
        [stale.id]: { temperature: sample(stale, "temperature", 20, 2, { quality: "stale" }) },
        [future.id]: { temperature: sample(future, "temperature", 20, -10) },
      },
    }));

    expect(pulse.coverage).toEqual({
      enabledSensors: 3,
      freshSensors: 0,
      estimatedSensors: 0,
      agingSensors: 1,
      staleSensors: 1,
      sensorsWithoutData: 1,
    });
    expect(pulse.status).toBe("attention");
    expect(pulse.insights[0]).toMatchObject({
      kind: "sensor-coverage",
      severity: "warning",
      title: "3 sensors need a data check",
      target: { houseId: house.id },
      freshness: { state: "unknown", evidenceAt: null, ageMinutes: null },
      confidence: { level: "high" },
    });
  });

  it("does not infer a health condition from stale history or a resolved alert", () => {
    const basement = sensor("basement", "Basement");
    const staleHumidity = sample(basement, "humidity", 94, 180);
    const resolved: AlertEvent = {
      id: "resolved",
      ruleId: "rule",
      sensorId: basement.id,
      metric: "humidity",
      value: 94,
      threshold: 65,
      severity: "critical",
      startedAt: "2026-07-14T08:00:00.000Z",
      acknowledgedAt: null,
      resolvedAt: "2026-07-14T09:00:00.000Z",
    };
    const insights = deriveHomeInsights(baseInput({
      sensors: [basement],
      latestMeasurements: { [basement.id]: { humidity: staleHumidity } },
      measurementHistory: { [basement.id]: { humidity: [staleHumidity] } },
      alerts: [resolved],
    }));

    expect(insights.map((item) => item.kind)).toEqual(["sensor-coverage"]);
    expect(insights[0]?.freshness.state).toBe("stale");
  });

  it("marks estimated one-point evidence as low confidence without calling it sustained", () => {
    const bathroom = sensor("bathroom", "Bathroom");
    const insight = deriveHomeInsights(baseInput({
      sensors: [bathroom],
      latestMeasurements: {
        [bathroom.id]: { humidity: sample(bathroom, "humidity", 68, 2, { quality: "estimated" }) },
      },
    }))[0]!;

    expect(insight.kind).toBe("humidity");
    expect(insight.title).toBe("Humidity is elevated in Bathroom");
    expect(insight.summary).toContain("not yet enough consistent recent history");
    expect(insight.confidence).toMatchObject({ level: "low", score: 0.55 });
  });

  it("provides a setup action when no sensor is enabled", () => {
    const disabled = sensor("disabled", "Living room", { enabled: false });
    const pulse = deriveHomePulse(baseInput({
      sensors: [disabled],
      latestMeasurements: { [disabled.id]: { temperature: sample(disabled, "temperature", 21, 1) } },
    }));

    expect(pulse.status).toBe("unknown");
    expect(pulse.coverage.enabledSensors).toBe(0);
    expect(pulse.insights[0]).toMatchObject({
      rank: 1,
      kind: "setup",
      severity: "info",
      target: { houseId: house.id },
      confidence: { level: "high" },
    });
  });

  it("uses the alert operator for advice and always keeps critical alerts above warnings", () => {
    const nursery = sensor("nursery", "Nursery");
    const office = sensor("office", "Office");
    const lowHumidityRule: AlertRule = {
      id: "low-humidity",
      name: "Low humidity",
      sensorId: nursery.id,
      metric: "humidity",
      operator: "lt",
      threshold: 30,
      durationSeconds: 600,
      severity: "critical",
      enabled: true,
      webhookEnabled: false,
      telegramEnabled: false,
    };
    const criticalAlert: AlertEvent = {
      id: "low-humidity-alert",
      ruleId: lowHumidityRule.id,
      sensorId: nursery.id,
      metric: "humidity",
      value: 25,
      threshold: 30,
      severity: "critical",
      startedAt: "2026-07-14T11:30:00.000Z",
      acknowledgedAt: "2026-07-14T11:35:00.000Z",
      resolvedAt: null,
    };
    const insights = deriveHomeInsights(baseInput({
      sensors: [nursery, office],
      latestMeasurements: {
        [nursery.id]: { humidity: sample(nursery, "humidity", 25, 3) },
        [office.id]: { co2: sample(office, "co2", 2_500, 3) },
      },
      alerts: [criticalAlert],
      alertRules: [lowHumidityRule],
      maxInsights: 2,
    }));

    expect(insights.map((item) => item.severity)).toEqual(["critical", "warning"]);
    expect(insights[0]?.id).toBe("active-alert:low-humidity-alert");
    expect(insights[0]?.action).toContain("follow the configured alert rule");
    expect(insights[0]?.action).not.toMatch(/extractor|dehumidifier/i);
  });

  it("rejects an invalid reference time instead of consulting the wall clock", () => {
    expect(() => deriveHomePulse(baseInput({ referenceTime: "not-a-time" }))).toThrow(RangeError);
  });
});
