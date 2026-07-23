import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ThermalIsolationEntry, ThermalIsolationResult } from "@climate-twin/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";

const mocks = vi.hoisted(() => ({
  result: null as ThermalIsolationResult | null,
  run: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../useThermalIsolation", () => ({
  useThermalIsolation: () => ({ result: mocks.result, loading: false, error: false, run: mocks.run, reset: mocks.reset }),
}));

import { ThermalIsolationPanel } from "./ThermalIsolationPanel";

function entry(
  type: ThermalIsolationEntry["scope"]["type"],
  id: string,
  label: string,
  score: number,
  options: { parentId?: string; floorId?: string; sensorIds?: string[]; rank?: number } = {},
): ThermalIsolationEntry {
  return {
    scope: {
      type,
      id,
      label,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.floorId ? { floorId: options.floorId } : {}),
      sensorIds: options.sensorIds ?? ["sensor-01"],
    },
    calibrationStatus: "provisional",
    confidence: "medium",
    rating: score >= 55 ? "high" : "moderate",
    score,
    rank: options.rank ?? 1,
    comparedWithHousePoints: 0,
    childCoveragePct: 100,
    sensorCount: options.sensorIds?.length ?? 1,
    eligibleSensorCount: options.sensorIds?.length ?? 1,
    metrics: {
      effectiveTimeConstantHours: 48,
      halfResponseHours: 33.3,
      retainedAfter24HoursPct: score,
      outdoorResponseAfter24HoursPct: 100 - score,
      modelSkillPct: 44,
      typicalTemperatureSpreadC: type === "sensor" ? null : 0.5,
      p90TemperatureSpreadC: type === "sensor" ? null : 0.9,
    },
    quality: {
      durationHours: 168,
      outdoorRangeC: 12,
      validationMaeC: 0.22,
      persistenceMaeC: 0.4,
      scoreLow: score - 5,
      scoreHigh: score + 5,
    },
    warnings: ["SHORT_CALIBRATION_WINDOW"],
  };
}

function result(): ThermalIsolationResult {
  const house = entry("house", "house:house-main", "My climate twin", 61, { sensorIds: ["sensor-01"] });
  const floor = entry("floor", "floor:floor-ground", "Ground floor", 61, { parentId: house.scope.id, floorId: "floor-ground", sensorIds: ["sensor-01"] });
  const room = entry("room", "room:floor-ground:living", "Living room", 61, { parentId: floor.scope.id, floorId: "floor-ground", sensorIds: ["sensor-01"], rank: 1 });
  const sensor = entry("sensor", "sensor:sensor-01", "Window sensor", 61, { parentId: room.scope.id, floorId: "floor-ground", sensorIds: ["sensor-01"] });
  return {
    generatedAt: "2026-07-14T12:00:00.000Z",
    systemVersion: "0.6.0",
    houseId: "house-main",
    from: "2026-07-07T12:00:00.000Z",
    to: "2026-07-14T12:00:00.000Z",
    entries: [house, floor, room, sensor],
    insights: [{ code: "LOWEST_BUFFERING_ROOM", scopeIds: [room.scope.id], value: 61, unit: "score-points" }],
    methodology: {
      scoreMethod: "modeled-24h-retention-v1",
      aggregationMethod: "median-child-score-v1",
      interpretation: "Higher means slower response.",
      limitations: [],
    },
  };
}

describe("ThermalIsolationPanel", () => {
  beforeEach(() => {
    mocks.result = result();
    mocks.run.mockClear();
  });

  it("shows the whole-home score, floor and room comparison, insights, and sensor evidence", async () => {
    const house = createDemoState().houses[0]!;
    render(<I18nProvider><ThermalIsolationPanel house={house} units="metric" /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Thermal isolation comparison" })).not.toBeNull();
    expect(screen.getByText("Whole-Home isolation score")).not.toBeNull();
    expect(screen.getByText("Ground floor")).not.toBeNull();
    expect(screen.getAllByText("Living room").length).toBeGreaterThan(0);
    expect(screen.getByText("Fastest-reacting room")).not.toBeNull();
    expect(screen.getByRole("table", { name: "Thermal isolation comparison by floor and room" })).not.toBeNull();
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("Show sensor-level evidence (1)"));
    expect(screen.getByText("Window sensor")).not.toBeNull();
  });
});
