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

import { actionRun, analyticsPoint, analyticsSeries, climateSensor, definition, definitions, energySensor, from, hourlyPoints, house, maintenanceTask, opening, recoveryPoints, recoveryStart, response, to } from "./homePerformanceTestSupport.js";

describe("deriveHomePerformance", () => {
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
