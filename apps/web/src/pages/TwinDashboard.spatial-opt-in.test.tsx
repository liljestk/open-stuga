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
  const bindings = vi.spyOn(api, "houseSpatialLayerBindings").mockResolvedValue([]);
  const calibrations = vi.spyOn(api, "houseSpatialLayerCalibrations").mockResolvedValue([]);
  const calibrationSessions = vi.spyOn(api, "houseSpatialLayerCalibrationSessions").mockResolvedValue([]);
  const contextEvents = vi.spyOn(api, "houseSpatialLayerContextEvents").mockResolvedValue([]);
  const groundTruth = vi.spyOn(api, "houseSpatialLayerGroundTruth").mockResolvedValue([]);
  return {
    engines, current, health, configuration, inference, stopInference,
    bindings, calibrations, calibrationSessions, contextEvents, groundTruth,
  };
}

function specialistRequests(requests: ReturnType<typeof spatialRequests>) {
  return [
    requests.configuration,
    requests.inference,
    requests.bindings,
    requests.calibrations,
    requests.calibrationSessions,
    requests.contextEvents,
    requests.groundTruth,
  ];
}

function dashboard(state = createDemoState(), house = state.houses[0]!) {
  const floor = house.floors[0]!;
  const sensor = state.sensors.find((candidate) => candidate.houseId === house.id && candidate.enabled)!;
  return <I18nProvider><TwinDashboard
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
  /></I18nProvider>;
}

function renderDashboard() {
  return render(dashboard());
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
    specialistRequests(requests).forEach((request) => expect(request).toHaveBeenCalledOnce());
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

  it("requires a fresh opt-in after navigating A to B to A", async () => {
    localStorage.setItem("climate-twin-locale", "en");
    const requests = spatialRequests();
    const state = createDemoState();
    const houseA = state.houses[0]!;
    const houseB = { ...houseA, id: "house-second", name: "Birch House" };
    const stateWithBoth = {
      ...state,
      houses: [houseA, houseB],
      sensors: [
        ...state.sensors,
        ...state.sensors.map((sensor) => ({
          ...sensor,
          id: `second-${sensor.id}`,
          houseId: houseB.id,
        })),
      ],
    };
    const view = render(dashboard(stateWithBoth, houseA));

    fireEvent.click(screen.getByText("Open analysis tools"));
    fireEvent.click(await screen.findByText("Environmental layer lab", { selector: "strong" }));
    await waitFor(() => expect(requests.current).toHaveBeenCalledOnce());
    await waitFor(() => specialistRequests(requests).forEach((request) => expect(request).toHaveBeenCalledOnce()));
    expect(requests.current).toHaveBeenLastCalledWith(houseA.id, [], expect.any(AbortSignal));
    specialistRequests(requests).forEach((request) => {
      expect(request).toHaveBeenLastCalledWith(houseA.id, expect.any(AbortSignal));
    });

    view.rerender(dashboard(stateWithBoth, houseB));
    expect(requests.current).toHaveBeenCalledOnce();
    specialistRequests(requests).forEach((request) => expect(request).toHaveBeenCalledOnce());

    view.rerender(dashboard(stateWithBoth, houseA));
    expect(requests.current).toHaveBeenCalledOnce();
    specialistRequests(requests).forEach((request) => expect(request).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByText("Environmental layer lab", { selector: "strong" }));
    await waitFor(() => expect(requests.current).toHaveBeenCalledTimes(2));
    await waitFor(() => specialistRequests(requests).forEach((request) => expect(request).toHaveBeenCalledTimes(2)));
    expect(requests.current.mock.calls.map(([houseId]) => houseId)).toEqual([houseA.id, houseA.id]);
    specialistRequests(requests).forEach((request) => {
      expect(request.mock.calls.map(([houseId]) => houseId)).toEqual([houseA.id, houseA.id]);
    });

    view.unmount();
    localStorage.removeItem("climate-twin-locale");
  });

  it("aborts specialist work for editing and stays dormant until a fresh opt-in", async () => {
    localStorage.setItem("climate-twin-locale", "en");
    const requests = spatialRequests();
    const createContext = vi.spyOn(api, "createHouseSpatialLayerContextEvent");
    let revalidationSignal: AbortSignal | undefined;
    let mutationSignal: AbortSignal | undefined;
    const rejectOnAbort = <T,>(signal: AbortSignal): Promise<T> => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const view = renderDashboard();

    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    const viewOptions = view.container.querySelector<HTMLDetailsElement>(".twin-view-options")!;
    fireEvent.click(viewOptions.querySelector("summary")!);
    fireEvent.click(screen.getByText("Open analysis tools"));
    fireEvent.click(await screen.findByText("Environmental layer lab", { selector: "strong" }));
    await waitFor(() => specialistRequests(requests).forEach((request) => expect(request).toHaveBeenCalledOnce()));

    // Calls start before the loaded state installs its visibility listener.
    await screen.findByRole("button", { name: "Stop analysis" });
    requests.inference.mockImplementationOnce((_houseId, signal) => {
      revalidationSignal = signal;
      return rejectOnAbort(signal!);
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(requests.inference).toHaveBeenCalledTimes(2));

    createContext.mockImplementationOnce((_houseId, _event, signal) => {
      mutationSignal = signal;
      return rejectOnAbort(signal!);
    });
    const contextButton = screen.getByRole("button", { name: "Record context" });
    fireEvent.submit(contextButton.closest("form")!);
    await waitFor(() => expect(createContext).toHaveBeenCalledOnce());

    const overviewCount = requests.current.mock.calls.length;
    const specialistCounts = specialistRequests(requests).map((request) => request.mock.calls.length);
    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));

    await waitFor(() => {
      expect(revalidationSignal?.aborted).toBe(true);
      expect(mutationSignal?.aborted).toBe(true);
    });
    expect(screen.queryByText("Environmental layer lab", { selector: "strong" })).toBeNull();

    fireEvent.click(view.container.querySelector<HTMLButtonElement>(".toolbar-edit-actions .secondary-button")!);
    await screen.findByText("Environmental layer lab", { selector: "strong" });
    expect(requests.current).toHaveBeenCalledTimes(overviewCount);
    specialistRequests(requests).forEach((request, index) => {
      expect(request).toHaveBeenCalledTimes(specialistCounts[index]!);
    });

    fireEvent.click(screen.getByText("Environmental layer lab", { selector: "strong" }));
    await waitFor(() => expect(requests.current).toHaveBeenCalledTimes(overviewCount + 1));
    await waitFor(() => specialistRequests(requests).forEach((request, index) => {
      expect(request).toHaveBeenCalledTimes(specialistCounts[index]! + 1);
    }));

    view.unmount();
    localStorage.removeItem("climate-twin-locale");
  });
});
