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

export const from = "2026-01-01T00:00:00.000Z";

export const to = "2026-01-31T00:00:00.000Z";

export const recoveryStart = Date.parse("2026-01-25T00:00:00.000Z");

export function definition(id: string, unit: string, interpolationDelta: number): MeasurementDefinition {
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

export const definitions = [
  definition("temperature", "°C", 0.35),
  definition("humidity", "%", 3),
  definition("co2", "ppm", 50),
  definition("energy", "kWh", 1),
  definition("power", "W", 100),
];

export const house: House = {
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

export const climateSensor: Sensor = {
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

export const energySensor: Sensor = {
  ...climateSensor,
  id: "heater",
  roomId: null,
  room: "Utility",
  name: "Heat-pump meter",
  model: "P110",
  tags: ["heat-pump"],
};

export function analyticsPoint(timestamp: string, value: number | null): AnalyticsPoint {
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

export function analyticsSeries(
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

export function response(series: AnalyticsSeries[], resolution: "15m" | "1h"): AnalyticsQueryResponse {
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

export function hourlyPoints(transform: (index: number) => number | null): AnalyticsPoint[] {
  return Array.from({ length: 48 }, (_, index) => analyticsPoint(
    new Date(Date.parse(from) + index * 3_600_000).toISOString(),
    transform(index),
  ));
}

export function recoveryPoints(metric: "temperature" | "humidity" | "co2"): AnalyticsPoint[] {
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

export function opening(id: string, index: number, state: "open" | "closed" | "unknown"): OpeningStateObservation {
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

export function actionRun(id: string, status: "verified" | "not-improved", taskId: string): ActionRun {
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

export function maintenanceTask(id: string): MaintenanceTask {
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
