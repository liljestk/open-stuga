import { describe, expect, it } from "vitest";
import type {
  ActionRun,
  AnalyticsPoint,
  AnalyticsQueryResponse,
  AnalyticsSeries,
  House,
  MaintenanceTask,
  ManualObservation,
  MeasurementDefinition,
  OpeningStateObservation,
  OutdoorTemperatureSample,
  Sensor,
} from "@climate-twin/contracts";
import { deriveHomePerformance } from "./homePerformance";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-31T00:00:00.000Z";
const recoveryStart = Date.parse("2026-01-25T00:00:00.000Z");

function definition(id: string, unit: string, interpolationDelta: number): MeasurementDefinition {
  return {
    id,
    labels: { en: id },
    unit,
    dimension: id,
    allowedUnits: [unit],
    kind: id === "energy" ? "cumulative_counter" : id === "power" ? "rate" : "gauge",
    defaultAggregation: id === "energy" ? "delta" : id === "power" ? "time_weighted_mean" : "mean",
    genericHistoryEnabled: true,
    genericStatsEnabled: true,
    precision: id === "temperature" ? 1 : 0,
    validMin: null,
    validMax: null,
    displayMin: null,
    displayMax: null,
    interpolationDelta,
    colorScale: "sequential",
    builtin: true,
    enabled: true,
    spatialInterpolation: false,
    forecastSupported: false,
  };
}

const definitions = [
  definition("temperature", "°C", 0.35),
  definition("humidity", "%", 3),
  definition("co2", "ppm", 50),
  definition("energy", "kWh", 1),
  definition("power", "W", 100),
];

const house: House = {
  id: "home",
  propertyId: "property",
  name: "Home",
  timezone: "Europe/Helsinki",
  floors: [{
    id: "ground",
    name: "Ground floor",
    width: 10,
    height: 8,
    elevation: 0,
    ceilingHeight: 2.6,
    walls: [{ id: "outside", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
    rooms: [{ id: "living", name: "Living room", points: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 },
    ] }],
    planElements: [{
      id: "window",
      kind: "window",
      wallId: "outside",
      position: { x: 5, y: 0 },
      rotationDegrees: 0,
      label: "Living-room window",
    }],
  }],
  createdAt: from,
  updatedAt: from,
};

const climateSensor: Sensor = {
  id: "climate",
  houseId: house.id,
  floorId: "ground",
  roomId: "living",
  room: "Living room",
  name: "Living sensor",
  model: "T315",
  x: 5,
  y: 2,
  z: 1.2,
  tags: [],
  enabled: true,
};

const energySensor: Sensor = {
  ...climateSensor,
  id: "heater",
  roomId: null,
  room: "Utility",
  name: "Heat-pump meter",
  model: "P110",
  tags: ["heat-pump"],
};

function analyticsPoint(timestamp: string, value: number | null): AnalyticsPoint {
  return {
    timestamp,
    value,
    minimum: value,
    maximum: value,
    sampleCount: value === null ? 0 : 1,
    coverage: value === null ? 0 : 1,
    qualityFlags: value === null ? ["missing"] : [],
  };
}

function analyticsSeries(
  sensor: Sensor,
  metric: string,
  points: AnalyticsPoint[],
  resolution: "15m" | "1h",
): AnalyticsSeries {
  const present = points.flatMap((point) => point.value === null ? [] : [point.value]);
  return {
    entityId: sensor.id,
    entityLabel: sensor.name,
    measurementId: metric,
    canonicalUnit: definitions.find((item) => item.id === metric)?.unit ?? "",
    truthClass: "derived",
    aggregation: metric === "energy" ? "delta" : metric === "power" ? "time_weighted_mean" : "mean",
    resolution,
    points,
    summary: {
      entityId: sensor.id,
      measurementId: metric,
      canonicalUnit: definitions.find((item) => item.id === metric)?.unit ?? "",
      count: present.length,
      coverage: present.length === 0 ? 0 : present.length / points.length,
      minimum: present.length ? Math.min(...present) : null,
      maximum: present.length ? Math.max(...present) : null,
      mean: present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null,
      median: present[0] ?? null,
      standardDeviation: null,
      medianAbsoluteDeviation: null,
      p05: present[0] ?? null,
      p95: present.at(-1) ?? null,
    },
    provenance: {
      algorithmKey: "test",
      algorithmVersion: "1",
      generatedAt: to,
      inputStart: from,
      inputEnd: to,
      sourceIds: [sensor.id],
      archiveState: "merged",
    },
  };
}

function response(series: AnalyticsSeries[], resolution: "15m" | "1h"): AnalyticsQueryResponse {
  return {
    apiVersion: "1.0",
    requestId: "test",
    dataMode: "live",
    resolvedRange: { start: from, end: to, timezone: house.timezone },
    resolution,
    series,
    summaries: series.map((item) => item.summary),
    quality: {
      coverage: 1,
      seriesCount: series.length,
      sampleCount: series.reduce((sum, item) => sum + item.summary.count, 0),
      excludedSampleCount: 0,
      includedQualities: ["good", "estimated"],
      lowCoverageSeries: 0,
    },
    provenance: series.map((item) => item.provenance),
    warnings: [],
    generatedAt: to,
    cache: { hit: false, keyVersion: "analytics-query-v1" },
  };
}

function hourlyPoints(transform: (index: number) => number | null): AnalyticsPoint[] {
  return Array.from({ length: 48 }, (_, index) => analyticsPoint(
    new Date(Date.parse(from) + index * 3_600_000).toISOString(),
    transform(index),
  ));
}

function recoveryPoints(metric: "temperature" | "humidity" | "co2"): AnalyticsPoint[] {
  return Array.from({ length: 48 }, (_, index) => {
    let value = metric === "temperature" ? 22 : metric === "humidity" ? 45 : 750;
    if (metric === "humidity") {
      if (index === 8 || index === 30) value = 70;
      if (index === 9 || index === 31) value = 60;
      if (index === 10 || index === 32) value = 52;
    }
    if (metric === "co2") {
      if (index === 7 || index === 29) value = 1_300;
      if (index === 8 || index === 30) value = 1_300;
      if (index === 9 || index === 31) value = 1_100;
      if (index === 10 || index === 32) value = 900;
      if (index === 11 || index === 33) value = 700;
    }
    return analyticsPoint(new Date(recoveryStart + index * 15 * 60_000).toISOString(), value);
  });
}

function opening(id: string, index: number, state: "open" | "closed" | "unknown"): OpeningStateObservation {
  return {
    id,
    houseId: house.id,
    floorId: "ground",
    elementId: "window",
    state,
    source: "tapo",
    observedAt: new Date(recoveryStart + index * 15 * 60_000).toISOString(),
  };
}

function actionRun(id: string, status: "verified" | "not-improved", taskId: string): ActionRun {
  return {
    id,
    playbookId: "playbook",
    alertEventId: null,
    maintenanceTaskId: taskId,
    sensorId: climateSensor.id,
    metric: "humidity",
    status,
    startedAt: from,
    actionCompletedAt: from,
    verifyAfter: from,
    verificationDeadline: to,
    baselineValue: 70,
    baselineTimestamp: from,
    resultValue: status === "verified" ? 50 : 68,
    resultTimestamp: to,
    improvement: status === "verified" ? 20 : 2,
    sampleCount: 4,
    operatorNote: null,
    verificationNote: "Measured",
    createdAt: from,
    updatedAt: to,
  };
}

function maintenanceTask(id: string): MaintenanceTask {
  return {
    id,
    propertyId: house.propertyId,
    houseId: house.id,
    floorId: "ground",
    title: id,
    description: null,
    basis: "condition-based",
    basisDetail: null,
    priority: "normal",
    plannedFor: null,
    dueBy: null,
    observationIds: [],
    status: "verified",
    completionNote: "Done",
    completedAt: to,
    verificationNote: "Checked",
    verifiedAt: to,
    revision: 3,
    createdAt: from,
    updatedAt: to,
  };
}

describe("deriveHomePerformance", () => {
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
    expect(result.energy.energyPerHeatingDegreeHour).toBeCloseTo(48 / (48 * 18), 3);
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
      algorithmVersion: "home-performance-v1.0.0",
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

  it("rejects sparse recovery episodes and evidence outside the reporting window", () => {
    const sparsePoints = (metric: "temperature" | "humidity") => Array.from({ length: 10 }, (_, index) => {
      const shiftedIndex = index < 4 ? index : index + 8;
      const value = metric === "temperature"
        ? 22
        : index === 4
          ? 70
          : index === 5
            ? 60
            : index === 6
              ? 50
              : 45;
      return analyticsPoint(new Date(recoveryStart + shiftedIndex * 15 * 60_000).toISOString(), value);
    });
    const sparseCo2 = [
      analyticsPoint(new Date(recoveryStart).toISOString(), 1_300),
      analyticsPoint(new Date(recoveryStart + 2 * 3_600_000).toISOString(), 1_100),
      analyticsPoint(new Date(recoveryStart + 2 * 3_600_000 + 15 * 60_000).toISOString(), 800),
    ];
    const oldRun = {
      ...actionRun("old-run", "verified", "old-task"),
      resultTimestamp: "2025-12-01T00:00:00.000Z",
      updatedAt: "2025-12-01T00:00:00.000Z",
    };
    const oldTask = {
      ...maintenanceTask("old-task"),
      completedAt: "2025-12-01T00:00:00.000Z",
      verifiedAt: "2025-12-01T00:00:00.000Z",
      updatedAt: "2025-12-01T00:00:00.000Z",
    };
    const result = deriveHomePerformance({
      house,
      sensors: [climateSensor],
      definitions,
      climate: null,
      recoveryClimate: response([
        analyticsSeries(climateSensor, "temperature", sparsePoints("temperature"), "15m"),
        analyticsSeries(climateSensor, "humidity", sparsePoints("humidity"), "15m"),
        analyticsSeries(climateSensor, "co2", sparseCo2, "15m"),
      ], "15m"),
      energy: null,
      outdoor: [],
      openings: [opening("seed-closed", 3, "closed"), opening("sparse-open", 4, "open")],
      actionRuns: [oldRun],
      maintenanceTasks: [oldTask],
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
    expect(result.maintenance).toMatchObject({
      state: "unavailable",
      evaluatedActions: 0,
      completedWithoutMeasurement: 0,
    });
  });
});
