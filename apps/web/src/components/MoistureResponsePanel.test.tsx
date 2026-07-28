import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SYSTEM_VERSION, type MoistureResponseEntry, type MoistureResponseResult } from "@climate-twin/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";

const mocks = vi.hoisted(() => ({
  result: null as MoistureResponseResult | null,
  run: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../useMoistureResponse", () => ({
  useMoistureResponse: () => ({ result: mocks.result, loading: false, error: false, run: mocks.run, reset: mocks.reset }),
}));

import { MoistureResponsePanel } from "./MoistureResponsePanel";

function entry(
  type: MoistureResponseEntry["scope"]["type"],
  id: string,
  label: string,
  options: { parentId?: string; floorId?: string; sensorIds?: string[]; rank?: number } = {},
): MoistureResponseEntry {
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
    rank: options.rank ?? 1,
    childCoveragePct: 100,
    sensorCount: options.sensorIds?.length ?? 1,
    eligibleSensorCount: options.sensorIds?.length ?? 1,
    metrics: {
      responseTimeHours: 22,
      halfResponseHours: 15.2,
      outdoorCouplingPct: 64,
      medianIndoorVaporPressureHpa: 11.4,
      medianOutdoorVaporPressureHpa: 8.1,
      medianMoistureExcessHpa: 3.3,
      modelSkillPct: 48,
    },
    quality: {
      durationHours: 168,
      outdoorRangeHpa: 4.2,
      validationMaeHpa: 0.18,
      persistenceMaeHpa: 0.35,
    },
    warnings: ["SHORT_MOISTURE_EVIDENCE_WINDOW"],
  };
}

function responseResult(): MoistureResponseResult {
  const home = entry("house", "house:house-main", "My climate twin");
  const floor = entry("floor", "floor:floor-ground", "Ground floor", { parentId: home.scope.id, floorId: "floor-ground" });
  const room = entry("room", "room:floor-ground:living", "Living room", { parentId: floor.scope.id, floorId: "floor-ground" });
  const sensor = entry("sensor", "sensor:sensor-01", "Climate sensor", { parentId: room.scope.id, floorId: "floor-ground" });
  return {
    generatedAt: "2026-07-14T12:00:00.000Z",
    systemVersion: SYSTEM_VERSION,
    houseId: "house-main",
    from: "2026-07-07T12:00:00.000Z",
    to: "2026-07-14T12:00:00.000Z",
    entries: [home, floor, room, sensor],
    insights: [{ code: "STRONGEST_OUTDOOR_MOISTURE_COUPLING", scopeIds: [room.scope.id], value: 64, unit: "percent" }],
    methodology: {
      conversionMethod: "buck-vapor-pressure-v1",
      modelMethod: "first-order-moisture-response-v1",
      aggregationMethod: "median-child-metric-v1",
      interpretation: "Test",
      limitations: [],
    },
  };
}

describe("MoistureResponsePanel", () => {
  beforeEach(() => {
    mocks.result = responseResult();
    mocks.run.mockClear();
  });

  it("shows response, coupling, floor and room comparisons, and sensor evidence", async () => {
    const house = createDemoState().houses[0]!;
    render(<I18nProvider><MoistureResponsePanel house={house} /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Moisture response comparison" })).not.toBeNull();
    expect(screen.getByText("Whole-Home moisture response time")).not.toBeNull();
    expect(screen.getByRole("table", { name: "Moisture response comparison by floor and room" })).not.toBeNull();
    expect(screen.getByText("Strongest outdoor relationship")).not.toBeNull();
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("Show sensor-level evidence (1)"));
    expect(screen.getByText("Climate sensor")).not.toBeNull();
  });
});
