import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import type { UseSpatialLayersResult } from "../useSpatialLayers";

const mocks = vi.hoisted(() => ({
  config: vi.fn(), bindings: vi.fn(), calibrations: vi.fn(), sessions: vi.fn(), context: vi.fn(), truth: vi.fn(), createSession: vi.fn(),
}));

vi.mock("../api", () => ({ api: {
  houseSpatialLayerConfig: mocks.config,
  houseSpatialLayerBindings: mocks.bindings,
  houseSpatialLayerCalibrations: mocks.calibrations,
  houseSpatialLayerCalibrationSessions: mocks.sessions,
  houseSpatialLayerContextEvents: mocks.context,
  houseSpatialLayerGroundTruth: mocks.truth,
  createHouseSpatialLayerCalibrationSession: mocks.createSession,
} }));

import { SpatialLayerLab } from "./SpatialLayerLab";

const runningBaseline = {
  id: "baseline-1",
  houseId: "house-1",
  kind: "empty-house-baseline" as const,
  status: "running" as const,
  startAt: "2026-07-16T16:00:00.000Z",
  endAt: null,
  intervention: {},
  notes: "House is empty",
};

function layerState(): UseSpatialLayersResult {
  return {
    available: true,
    loading: false,
    refreshing: false,
    historyLoading: false,
    error: null,
    streamState: "idle",
    engines: [{ id: "scalar", version: "1", title: "Climate", maturity: "stable", supportedScopes: ["house"], requiredMetrics: [], layerIds: ["climate.temperature"] }],
    health: [{ engineId: "scalar", state: "healthy" }],
    topology: null,
    snapshots: [],
    history: [],
    selectedLayerIds: ["climate.temperature"],
    staleLayerIds: [],
    setLayerSelected: vi.fn(),
    refresh: vi.fn(async () => undefined),
  };
}

describe("SpatialLayerLab guided calibration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const topology = { scope: { kind: "house" as const, id: "house-1" }, frames: [], zones: [], connections: [], sensorBindings: [] };
    mocks.config.mockResolvedValue({ configuration: { version: 1, enabled: true, config: {}, topology }, assignments: [], topology });
    mocks.bindings.mockResolvedValue([]);
    mocks.calibrations.mockResolvedValue([]);
    mocks.sessions.mockResolvedValue([runningBaseline]);
    mocks.context.mockResolvedValue([]);
    mocks.truth.mockResolvedValue([]);
    mocks.createSession.mockResolvedValue({
      session: { ...runningBaseline, id: "controlled-1", kind: "controlled-propagation", status: "completed", startAt: "2026-07-16T17:00:00.000Z", endAt: "2026-07-16T17:30:00.000Z" },
      calibrations: [],
    });
  });

  it("loads learning state and records a guided controlled-propagation session", async () => {
    const sensor = createDemoState().sensors[0]!;
    const view = render(<I18nProvider><SpatialLayerLab houseId="house-1" sensors={[sensor]} layers={layerState()} /></I18nProvider>);
    const details = view.container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });

    await screen.findByText("Guided calibration sessions");
    expect(screen.getAllByText("Learning baseline").length).toBeGreaterThan(0);
    expect(mocks.sessions).toHaveBeenCalledWith("house-1");

    fireEvent.change(screen.getByLabelText("Session type"), { target: { value: "controlled-propagation" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "completed" } });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-07-16T20:00" } });
    fireEvent.change(screen.getByLabelText("End (required when completed)"), { target: { value: "2026-07-16T20:30" } });
    fireEvent.change(screen.getByLabelText("Known intervention"), { target: { value: "Opened the kitchen door" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Observed a humidity pulse" } });
    fireEvent.click(screen.getByRole("button", { name: "Record session" }));

    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith("house-1", expect.objectContaining({
      kind: "controlled-propagation",
      status: "completed",
      intervention: { description: "Opened the kitchen door" },
      notes: "Observed a humidity pulse",
    })));
  });
});
