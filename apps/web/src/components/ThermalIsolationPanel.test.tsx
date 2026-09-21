import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SYSTEM_VERSION, type ThermalIsolationEntry, type ThermalIsolationResult } from "@climate-twin/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";

const mocks = vi.hoisted(() => ({
  result: null as ThermalIsolationResult | null,
  error: false,
  errorCode: null as string | null,
  errorStatus: null as number | null,
  errorDetail: null as string | null,
  run: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../useThermalIsolation", () => ({
  useThermalIsolation: () => ({
    result: mocks.result,
    loading: false,
    error: mocks.error,
    errorCode: mocks.errorCode,
    errorStatus: mocks.errorStatus,
    errorDetail: mocks.errorDetail,
    run: mocks.run,
    reset: mocks.reset,
  }),
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
    systemVersion: SYSTEM_VERSION,
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
    mocks.error = false;
    mocks.errorCode = null;
    mocks.errorStatus = null;
    mocks.errorDetail = null;
    mocks.run.mockClear();
  });

  it("shows the whole-home score, floor and room comparison, insights, and sensor evidence", async () => {
    const house = createDemoState().houses[0]!;
    render(<I18nProvider><ThermalIsolationPanel house={house} units="metric" dataMode="real" /></I18nProvider>);

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

  it("explains limited confidence without calling full scope coverage incomplete", () => {
    mocks.result = result();
    mocks.result.insights = [{
      code: "LIMITED_EVIDENCE",
      scopeIds: [mocks.result.entries[0]!.scope.id],
      value: 100,
      unit: "percent",
    }];
    const house = createDemoState().houses[0]!;

    render(<I18nProvider><ThermalIsolationPanel house={house} units="metric" dataMode="real" /></I18nProvider>);

    expect(screen.getByText("Model confidence is limited")).not.toBeNull();
    expect(screen.getByText("Every floor has a usable model. Treat comparisons as directional until confidence improves.")).not.toBeNull();
    expect(screen.queryByText(/Only 100%/)).toBeNull();
  });

  it("identifies an API runtime that does not support the comparison", () => {
    mocks.result = null;
    mocks.error = true;
    mocks.errorStatus = 404;
    const house = createDemoState().houses[0]!;

    render(<I18nProvider><ThermalIsolationPanel house={house} units="metric" dataMode="real" /></I18nProvider>);

    expect(screen.getByRole("alert")).toHaveTextContent("The thermal comparison is unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Update or restart Stugu");
    expect(screen.queryByText(/measurements are unchanged/i)).toBeNull();
  });

  it("states plainly when a real Home has too little recorded evidence", () => {
    const emptyResult = result();
    const houseEntry = emptyResult.entries[0]!;
    houseEntry.score = null;
    houseEntry.rating = null;
    houseEntry.eligibleSensorCount = 0;
    emptyResult.entries = [houseEntry];
    emptyResult.insights = [];
    mocks.result = emptyResult;
    const house = createDemoState().houses[0]!;

    render(<I18nProvider><ThermalIsolationPanel house={house} units="metric" dataMode="real" /></I18nProvider>);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("No thermal comparison is available yet");
    expect(status).toHaveTextContent("Open sensor evidence below");
    expect(screen.queryByText("Whole-Home isolation score")).toBeNull();
  });

  it("explains a short usable segment without claiming there are no recordings", () => {
    const limited = result();
    limited.entries[0]!.score = null;
    const evidence = limited.entries.find((entry) => entry.scope.type === "sensor")!;
    evidence.score = null;
    evidence.warnings = ["CALIBRATION_WINDOW_TOO_SHORT", "REQUIRES_24_HOURS"];
    evidence.quality.durationHours = 17.5;
    mocks.result = limited;
    render(<I18nProvider><ThermalIsolationPanel house={createDemoState().houses[0]!} units="metric" dataMode="real" /></I18nProvider>);
    expect(screen.getByText("Usable continuous evidence: 17.5 h")).toBeInTheDocument();
    expect(screen.getByText(/Gaps and excluded heat-pump periods can split/)).toBeInTheDocument();
    expect(screen.getByText(/Evidence period:/)).toBeInTheDocument();
  });

  it("labels a simulated result as a demo estimate", () => {
    const house = createDemoState().houses[0]!;

    render(<I18nProvider><ThermalIsolationPanel house={house} units="metric" dataMode="demo" /></I18nProvider>);

    expect(screen.getByRole("status")).toHaveTextContent("Demo estimate");
    expect(screen.getByRole("status")).toHaveTextContent("not an estimate of this Home");
  });

  it("does not offer a derived refresh to read-only viewers", () => {
    const house = createDemoState().houses[0]!;
    render(<I18nProvider><ThermalIsolationPanel
      house={house}
      units="metric"
      dataMode="real"
      canRefresh={false}
    /></I18nProvider>);

    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("shows a specific archive recovery message with technical details", () => {
    mocks.result = null;
    mocks.error = true;
    mocks.errorStatus = 503;
    mocks.errorCode = "TELEMETRY_ARCHIVE_REQUIRED";
    mocks.errorDetail = "Complete telemetry history is temporarily unavailable";
    const house = createDemoState().houses[0]!;

    render(<I18nProvider><ThermalIsolationPanel house={house} units="metric" dataMode="real" /></I18nProvider>);

    expect(screen.getByRole("alert")).toHaveTextContent("Historical temperature data is not ready");
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 503 · TELEMETRY_ARCHIVE_REQUIRED");
  });
});
