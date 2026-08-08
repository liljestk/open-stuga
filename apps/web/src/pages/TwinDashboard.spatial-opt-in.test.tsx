import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { SPATIAL_LAYER_POLL_MS } from "../useSpatialLayers";
import { TwinDashboard } from "./TwinDashboard";

afterEach(() => vi.restoreAllMocks());

function spatialRequests() {
  const engines = vi.spyOn(api, "spatialLayerEngines").mockResolvedValue([{
    id: "climate-scalars",
    version: "1",
    maturity: "experimental",
    supportedScopes: ["house"],
    requiredMetrics: ["temperature"],
    layerIds: ["climate.temperature"],
    enabled: true,
    defaultEnabled: true,
  }]);
  const current = vi.spyOn(api, "houseSpatialLayersCurrent").mockResolvedValue({
    snapshots: [],
    topology: null,
    health: [],
  });
  const health = vi.spyOn(api, "houseSpatialLayersHealth").mockResolvedValue([]);
  const configuration = vi.spyOn(api, "houseSpatialLayerConfig").mockResolvedValue({
    configuration: { version: 1, enabled: true, config: {} },
    assignments: [],
  });
  const inference = vi.spyOn(api, "houseSpatialInferenceSession").mockResolvedValue({
    id: "session-active",
    houseId: "house-main",
    status: "active",
    startedAt: "2026-08-08T09:00:00.000Z",
    expiresAt: "2099-08-08T10:00:00.000Z",
    cadenceMinutes: 10,
    nextRunAt: "2099-08-08T09:10:00.000Z",
    lastScheduledAt: null,
    stoppedAt: null,
    createdBy: "owner",
    createdAt: "2026-08-08T09:00:00.000Z",
    updatedAt: "2026-08-08T09:00:00.000Z",
  });
  const stopInference = vi.spyOn(api, "stopHouseSpatialInferenceSession").mockResolvedValue(null);
  vi.spyOn(api, "houseSpatialLayerBindings").mockResolvedValue([]);
  vi.spyOn(api, "houseSpatialLayerCalibrations").mockResolvedValue([]);
  vi.spyOn(api, "houseSpatialLayerCalibrationSessions").mockResolvedValue([]);
  vi.spyOn(api, "houseSpatialLayerContextEvents").mockResolvedValue([]);
  vi.spyOn(api, "houseSpatialLayerGroundTruth").mockResolvedValue([]);
  return { engines, current, health, configuration, inference, stopInference };
}

function renderDashboard() {
  const state = createDemoState();
  const house = state.houses[0]!;
  const floor = house.floors[0]!;
  const sensor = state.sensors.find((candidate) => candidate.houseId === house.id && candidate.enabled)!;
  return render(<I18nProvider><TwinDashboard
    state={state}
    house={house}
    floor={floor}
    houseId={house.id}
    floorId={floor.id}
    metric="temperature"
    units="metric"
    viewMode="plan"
    selectedSensorId={sensor.id}
    saveState="idle"
    scenario="normal"
    dataMode="demo"
    onHouse={vi.fn()}
    onFloor={vi.fn()}
    onMetric={vi.fn()}
    onViewMode={vi.fn()}
    onSensorSelect={vi.fn()}
    onSensorMove={vi.fn()}
    onSensorUpdate={vi.fn().mockResolvedValue(sensor)}
    onFloorChange={vi.fn()}
    onSaveLayout={vi.fn()}
    onLoadSeries={vi.fn()}
    onRunScenario={vi.fn()}
    onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
    onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
  /></I18nProvider>);
}

describe("TwinDashboard spatial research opt-in", () => {
  it("keeps ordinary Home workflows dormant and bounds reads to the nested lab disclosure", async () => {
    localStorage.setItem("climate-twin-locale", "en");
    const requests = spatialRequests();
    const intervals = vi.spyOn(window, "setInterval");
    const clearedIntervals = vi.spyOn(window, "clearInterval");
    const view = renderDashboard();

    expect(requests.engines).not.toHaveBeenCalled();
    expect(requests.current).not.toHaveBeenCalled();
    expect(requests.health).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    fireEvent.click(screen.getByText("Explore this home", { selector: "strong" }));
    fireEvent.click(screen.getByRole("button", { name: "Open history and replay" }));
    fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
    fireEvent.click(screen.getByText("Open analysis tools"));

    expect(requests.engines).not.toHaveBeenCalled();
    expect(requests.current).not.toHaveBeenCalled();
    expect(requests.health).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Return to live" }));

    const labTitle = await screen.findByText("Environmental layer lab", { selector: "strong" });
    fireEvent.click(labTitle);
    await waitFor(() => expect(requests.current).toHaveBeenCalledOnce());
    await waitFor(() => expect(requests.configuration).toHaveBeenCalledOnce());
    expect(requests.engines).toHaveBeenCalledOnce();
    expect(requests.health).not.toHaveBeenCalled();
    expect(requests.inference).toHaveBeenCalledOnce();

    let timerIndex = -1;
    intervals.mock.calls.forEach(([, delay], index) => {
      if (delay === SPATIAL_LAYER_POLL_MS) timerIndex = index;
    });
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    const spatialTimer = intervals.mock.results[timerIndex]?.value;
    fireEvent.click(labTitle);
    await waitFor(() => expect(clearedIntervals).toHaveBeenCalledWith(spatialTimer));
    expect(requests.stopInference).not.toHaveBeenCalled();

    view.unmount();
    localStorage.removeItem("climate-twin-locale");
  });
});
