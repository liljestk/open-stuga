import { describe, expect, it } from "vitest";

import type {
  ManualObservation,
  OpeningStateObservation,
  OutdoorTemperatureSample,
  Sensor,
} from "@climate-twin/contracts";
import { HOME_PERFORMANCE_ALGORITHM_VERSION } from "@climate-twin/contracts";

import { deriveHomePerformance } from "../src/analytics/home-performance/derive.js";
import {
  exposureResult,
  recoveryEvidenceBySensor,
  type HomePerformanceInput,
} from "../src/analytics/home-performance/model.js";

import { actionRun, analyticsPoint, analyticsSeries, climateSensor, definitions, energySensor, from, hourlyPoints, house, maintenanceTask, opening, recoveryPoints, recoveryStart, response, to } from "./home-performance-test-support.js";

describe("deriveHomePerformance", () => {
  it("keeps actual comfort exposure but censors causal recovery evidence outside verified-off intervals", () => {
    const climate = response([
      analyticsSeries(climateSensor, "temperature", hourlyPoints(() => 21), "1h"),
    ], "1h");
    const recovery = response([
      analyticsSeries(climateSensor, "co2", recoveryPoints("co2"), "15m"),
    ], "15m");
    const input = {
      sensors: [climateSensor],
      climate,
      recoveryClimate: recovery,
      hvacPassiveIntervals: [],
    } as HomePerformanceInput;
    expect(exposureResult(input).observedHours).toBeGreaterThan(0);
    expect(recoveryEvidenceBySensor(input).has(climateSensor.id)).toBe(false);
  });

  it("keeps recovery points only inside half-open verified-off intervals without censoring exposure", () => {
    const intervalStart = recoveryStart + 15 * 60_000;
    const intervalEnd = recoveryStart + 45 * 60_000;
    const timestamps = [
      intervalStart,
      intervalStart + 15 * 60_000,
      intervalEnd,
      intervalEnd + 15 * 60_000,
    ].map((time) => new Date(time).toISOString());
    const climate = response([
      analyticsSeries(climateSensor, "temperature", hourlyPoints(() => 21), "1h"),
    ], "1h");
    const recovery = response([
      analyticsSeries(
        climateSensor,
        "co2",
        timestamps.map((timestamp, index) => analyticsPoint(timestamp, 1_200 - index * 100)),
        "15m",
      ),
    ], "15m");
    const input = {
      sensors: [climateSensor],
      climate,
      recoveryClimate: recovery,
      hvacPassiveIntervals: [{ fromMs: intervalStart, toMs: intervalEnd }],
    } as HomePerformanceInput;

    expect(exposureResult(input).observedHours).toBeGreaterThan(0);
    expect(recoveryEvidenceBySensor(input).get(climateSensor.id)?.co2.map((point) => point.timestamp))
      .toEqual(timestamps.slice(0, 2));
  });

  it("derives all six checks while preserving evidence boundaries", () => {
    const climate = response([
      analyticsSeries(climateSensor, "temperature", hourlyPoints((index) => index === 0 ? 16 : 21), "1h"),
      analyticsSeries(climateSensor, "humidity", hourlyPoints((index) => index === 1 ? 70 : 48), "1h"),
      analyticsSeries(climateSensor, "co2", hourlyPoints((index) => index === 2 ? 1_200 : 750), "1h"),
    ], "1h");
    const recovery = response([
      analyticsSeries(climateSensor, "temperature", recoveryPoints("temperature"), "15m"),
      analyticsSeries(climateSensor, "humidity", recoveryPoints("humidity"), "15m"),
      analyticsSeries(climateSensor, "co2", recoveryPoints("co2"), "15m"),
    ], "15m");
    const energy = response([
      analyticsSeries(energySensor, "energy", hourlyPoints(() => 1), "1h"),
    ], "1h");
    const outdoor: OutdoorTemperatureSample[] = hourlyPoints(() => 0).map((point) => ({
      houseId: house.id,
      locationKey: "home",
      timestamp: point.timestamp,
      temperatureC: point.value!,
      source: "fmi-observation",
      fetchedAt: point.timestamp,
      stationId: "station",
      stationName: "Station",
    }));
    const openings = [
      opening("closed-1", 7, "closed"),
      opening("open-1", 8, "open"),
      opening("heartbeat-1", 9, "open"),
      opening("closed-2", 29, "closed"),
      opening("open-2", 30, "open"),
    ];
    const observations: ManualObservation[] = [{
      id: "old-moisture",
      houseId: house.id,
      floorId: "ground",
      sensorId: climateSensor.id,
      kind: "condensation",
      severity: "warning",
      note: "Old",
      x: null,
      y: null,
      occurredAt: from,
      createdAt: from,
      status: "resolved",
      resolutionNote: "Dried",
      resolvedAt: "2026-01-10T00:00:00.000Z",
    }, {
      id: "new-moisture",
      houseId: house.id,
      floorId: "ground",
      sensorId: climateSensor.id,
      kind: "condensation",
      severity: "warning",
      note: "Again",
      x: null,
      y: null,
      occurredAt: "2026-01-20T00:00:00.000Z",
      createdAt: "2026-01-20T00:00:00.000Z",
      status: "open",
    }];

    const input = {
      house,
      sensors: [climateSensor, energySensor],
      definitions,
      climate,
      recoveryClimate: recovery,
      energy,
      outdoor,
      openings,
      actionRuns: [actionRun("successful", "verified", "task-1"), actionRun("unsuccessful", "not-improved", "task-2")],
      maintenanceTasks: [maintenanceTask("task-1"), maintenanceTask("task-2"), maintenanceTask("task-3")],
      observations,
      from,
      to,
      generatedAt: to,
    };
    const result = deriveHomePerformance(input);

    expect(result.exposure).toMatchObject({
      state: "ready",
      temperatureDegreeHours: 2,
      humidityOutsideGuideHours: 1,
      co2AboveGuideHours: 1,
    });
    expect(result.recovery).toMatchObject({ state: "ready", episodeCount: 2, medianHalfLifeMinutes: 30 });
    expect(result.openingEffectiveness).toMatchObject({
      state: "ready",
      evaluatedEvents: 2,
      effectiveEvents: 2,
      medianClearanceMinutes: 30,
      bestOpeningLabel: "Living-room window",
    });
    expect(result.energy).toMatchObject({
      state: "ready",
      energyKwh: 48,
      source: "heating-meter",
    });
    expect(result.energy.energyPerHeatingDegreeHour).toBeCloseTo(48 / (48 * 17), 3);
    expect(result.maintenance).toMatchObject({
      state: "ready",
      evaluatedActions: 2,
      improvedActions: 1,
      completedWithoutMeasurement: 1,
      recurringObservations: 1,
    });
    expect(result.sensorHealth).toMatchObject({
      state: "ready",
      monitoredSensors: 2,
      healthySensors: 2,
      coveragePercent: 100,
    });
    expect(result.status).toBe("ready");
    expect(result.provenance).toMatchObject({
      truthClass: "derived",
      algorithmVersion: HOME_PERFORMANCE_ALGORITHM_VERSION,
      sourceIds: expect.arrayContaining(["climate", "heater"]),
    });

    const bounded = deriveHomePerformance({ ...input, evidenceScopeTruncated: true });
    expect(bounded.status).toBe("limited");
    expect(bounded.limitations).toContain("evidence-scope-limited");
  });

  it("returns typed limitations instead of turning missing evidence into zero", () => {
    const result = deriveHomePerformance({
      house,
      sensors: [climateSensor],
      definitions,
      climate: null,
      recoveryClimate: null,
      energy: null,
      outdoor: [],
      openings: [],
      actionRuns: [],
      maintenanceTasks: [],
      observations: [],
      from,
      to,
      sensorScopeTruncated: true,
    });

    expect(result.status).toBe("unavailable");
    expect(result.exposure.guideRangePercent).toBeNull();
    expect(result.energy.energyKwh).toBeNull();
    expect(result.maintenance.improvementPercent).toBeNull();
    expect(result.limitations).toEqual(expect.arrayContaining([
      "sensor-scope-limited",
      "opening-history-missing",
      "maintenance-evidence-missing",
    ]));
  });

  it("requires overlapping duration and keeps sensor checks from appearing healthy", () => {
    const shortPoints = hourlyPoints(() => 21).slice(0, 8);
    const shortClimate = response([
      analyticsSeries(climateSensor, "temperature", shortPoints, "1h"),
      analyticsSeries(climateSensor, "humidity", shortPoints.map((point) => ({ ...point, value: 48 })), "1h"),
      analyticsSeries(climateSensor, "co2", shortPoints.map((point) => ({ ...point, value: 750 })), "1h"),
    ], "1h");
    const energy = response([
      analyticsSeries(energySensor, "energy", hourlyPoints(() => 1), "1h"),
    ], "1h");
    const twoOutdoorHours: OutdoorTemperatureSample[] = hourlyPoints(() => 0).slice(0, 2).map((point) => ({
      houseId: house.id,
      locationKey: "home",
      timestamp: point.timestamp,
      temperatureC: point.value!,
      source: "fmi-observation",
      fetchedAt: point.timestamp,
      stationId: "station",
      stationName: "Station",
    }));

    const limited = deriveHomePerformance({
      house,
      sensors: [climateSensor, energySensor],
      definitions,
      climate: shortClimate,
      recoveryClimate: null,
      energy,
      outdoor: twoOutdoorHours,
      openings: [],
      actionRuns: [],
      maintenanceTasks: [],
      observations: [],
      from,
      to,
    });
    expect(limited.exposure.state).toBe("limited");
    expect(limited.exposure.observedHours).toBe(8);
    expect(limited.energy.state).toBe("limited");
    expect(limited.energy.energyKwh).toBe(2);
    expect(limited.energy.energyPerHeatingDegreeHour).toBeNull();

    const flatline = deriveHomePerformance({
      house,
      sensors: [climateSensor],
      definitions,
      climate: response([
        analyticsSeries(climateSensor, "temperature", hourlyPoints(() => 21), "1h"),
      ], "1h"),
      recoveryClimate: null,
      energy: null,
      outdoor: [],
      openings: [],
      actionRuns: [],
      maintenanceTasks: [],
      observations: [],
      from,
      to,
    });
    expect(flatline.sensorHealth.state).toBe("limited");
    expect(flatline.sensorHealth.healthySensors).toBe(0);
    expect(flatline.sensorHealth.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ sensorId: climateSensor.id, code: "flatline" }),
    ]));
    expect(flatline.status).toBe("limited");

    const partialMetric = deriveHomePerformance({
      house,
      sensors: [climateSensor],
      definitions,
      climate: response([
        analyticsSeries(climateSensor, "temperature", hourlyPoints((index) => 20 + index * 0.02), "1h"),
        analyticsSeries(climateSensor, "humidity", hourlyPoints((index) => index < 24 ? 48 : null), "1h"),
      ], "1h"),
      recoveryClimate: null,
      energy: null,
      outdoor: [],
      openings: [],
      actionRuns: [],
      maintenanceTasks: [],
      observations: [],
      from,
      to,
    });
    expect(partialMetric.sensorHealth.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sensorId: climateSensor.id,
        code: "low-coverage",
        metric: "humidity",
        value: 50,
      }),
    ]));
    expect(partialMetric.sensorHealth.coveragePercent).toBe(75);
    expect(partialMetric.limitations).toContain("coverage-limited");
  });

  it("combines per-meter energy fallbacks and preserves measured zero usage", () => {
    const powerSensor: Sensor = {
      ...energySensor,
      id: "radiator",
      name: "Radiator meter",
    };
    const outdoor: OutdoorTemperatureSample[] = hourlyPoints(() => 0).map((point) => ({
      houseId: house.id,
      locationKey: "home",
      timestamp: point.timestamp,
      temperatureC: point.value!,
      source: "fmi-observation",
      fetchedAt: point.timestamp,
      stationId: "station",
      stationName: "Station",
    }));
    const input = {
      house,
      sensors: [energySensor, powerSensor],
      definitions,
      climate: null,
      recoveryClimate: null,
      outdoor,
      openings: [],
      actionRuns: [],
      maintenanceTasks: [],
      observations: [],
      from,
      to,
    };
    const mixed = deriveHomePerformance({
      ...input,
      energy: response([
        analyticsSeries(energySensor, "energy", hourlyPoints(() => 0), "1h"),
        analyticsSeries(powerSensor, "power", hourlyPoints(() => 1_000), "1h"),
      ], "1h"),
    });
    expect(mixed.energy).toMatchObject({
      state: "ready",
      energyKwh: 48,
      source: "heating-meter",
    });

    const zero = deriveHomePerformance({
      ...input,
      sensors: [energySensor],
      energy: response([
        analyticsSeries(energySensor, "energy", hourlyPoints(() => 0), "1h"),
      ], "1h"),
    });
    expect(zero.energy).toMatchObject({
      state: "ready",
      energyKwh: 0,
      energyPerHeatingDegreeHour: 0,
    });

    const perMeterFallback = deriveHomePerformance({
      ...input,
      sensors: [energySensor],
      energy: response([
        analyticsSeries(energySensor, "energy", hourlyPoints((index) => index < 24 ? 0 : null), "1h"),
        analyticsSeries(energySensor, "power", hourlyPoints(() => 1_000), "1h"),
      ], "1h"),
    });
    expect(perMeterFallback.energy).toMatchObject({
      state: "ready",
      energyKwh: 24,
      source: "heating-meter",
    });

    const incompleteMeter = deriveHomePerformance({
      ...input,
      energy: response([
        analyticsSeries(energySensor, "energy", hourlyPoints(() => 1), "1h"),
        analyticsSeries(powerSensor, "power", hourlyPoints((index) => index < 12 ? 1_000 : null), "1h"),
      ], "1h"),
    });
    expect(incompleteMeter.energy).toMatchObject({
      state: "limited",
      energyKwh: 24,
      source: "heating-meter",
    });
    expect(incompleteMeter.energy.energyPerHeatingDegreeHour).toBeNull();

    const lowCoverage = deriveHomePerformance({
      ...input,
      sensors: [energySensor],
      energy: response([
        analyticsSeries(energySensor, "energy", hourlyPoints(() => 1).map((point) => ({
          ...point,
          coverage: 0.5,
          qualityFlags: ["low_coverage"],
        })), "1h"),
      ], "1h"),
    });
    expect(lowCoverage.energy).toMatchObject({
      state: "unavailable",
      energyKwh: null,
      energyPerHeatingDegreeHour: null,
    });

    const unclassifiedSensor: Sensor = {
      ...energySensor,
      id: "utility-meter",
      name: "Utility meter",
      tags: [],
    };
    const unclassified = deriveHomePerformance({
      ...input,
      sensors: [unclassifiedSensor],
      energy: response([
        analyticsSeries(unclassifiedSensor, "energy", hourlyPoints(() => 1), "1h"),
      ], "1h"),
    });
    expect(unclassified.energy).toMatchObject({
      state: "limited",
      source: "unclassified-electricity",
    });
    expect(unclassified.limitations).toContain("unclassified-energy");

    const bidirectional = deriveHomePerformance({
      ...input,
      sensors: [powerSensor],
      energy: response([
        analyticsSeries(powerSensor, "power", hourlyPoints((index) => index % 2 === 0 ? 1_000 : -250), "1h"),
      ], "1h"),
    });
    expect(bidirectional.energy).toMatchObject({
      state: "unavailable",
      energyKwh: null,
      source: null,
    });
  });

  it("does not bridge one missing 15-minute bucket in recovery or opening evidence", () => {
    const indexes = [0, 1, 2, 3, 4, 6, 7, 8, 9];
    const points = (metric: "temperature" | "humidity" | "co2") => indexes.map((index) => {
      const value = metric === "temperature"
        ? 22
        : metric === "humidity"
          ? index < 4 ? 45 : index === 4 ? 70 : index === 6 ? 60 : index === 7 ? 52 : 45
          : index <= 4 ? 1_300 : index === 6 ? 1_100 : index === 7 ? 800 : 700;
      return analyticsPoint(new Date(recoveryStart + index * 15 * 60_000).toISOString(), value);
    });
    const result = deriveHomePerformance({
      house,
      sensors: [climateSensor],
      definitions,
      climate: null,
      recoveryClimate: response([
        analyticsSeries(climateSensor, "temperature", points("temperature"), "15m"),
        analyticsSeries(climateSensor, "humidity", points("humidity"), "15m"),
        analyticsSeries(climateSensor, "co2", points("co2"), "15m"),
      ], "15m"),
      energy: null,
      outdoor: [],
      openings: [opening("gap-closed", 3, "closed"), opening("gap-open", 4, "open")],
      actionRuns: [],
      maintenanceTasks: [],
      observations: [],
      from,
      to,
    });

    expect(result.recovery).toMatchObject({
      state: "unavailable",
      episodeCount: 0,
      medianHalfLifeMinutes: null,
    });
    expect(result.openingEffectiveness).toMatchObject({
      state: "limited",
      evaluatedEvents: 0,
      effectiveEvents: 0,
    });
  });

  it("does not carry a confirmed opening transition across an unknown contact state", () => {
    const recovery = response([
      analyticsSeries(climateSensor, "temperature", recoveryPoints("temperature"), "15m"),
      analyticsSeries(climateSensor, "humidity", recoveryPoints("humidity"), "15m"),
      analyticsSeries(climateSensor, "co2", recoveryPoints("co2"), "15m"),
    ], "15m");
    const input = {
      house,
      sensors: [climateSensor],
      definitions,
      climate: null,
      recoveryClimate: recovery,
      energy: null,
      outdoor: [],
      openings: [] as OpeningStateObservation[],
      actionRuns: [],
      maintenanceTasks: [],
      observations: [],
      from,
      to,
    };
    const result = deriveHomePerformance({
      ...input,
      openings: [
        opening("unknown-closed", 7, "closed"),
        opening("unknown-gap", 8, "unknown"),
        opening("unknown-open", 9, "open"),
      ],
    });

    expect(result.openingEffectiveness).toMatchObject({
      state: "unavailable",
      evaluatedEvents: 0,
      effectiveEvents: 0,
    });

    const expired = deriveHomePerformance({
      ...input,
      openings: [{
        ...opening("expired-closed", 7, "closed"),
        validUntil: new Date(recoveryStart + 8 * 15 * 60_000).toISOString(),
      }, opening("expired-open", 9, "open")],
    });
    expect(expired.openingEffectiveness).toMatchObject({
      state: "unavailable",
      evaluatedEvents: 0,
      effectiveEvents: 0,
    });
  });
});
