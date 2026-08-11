import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import type { UseSpatialLayersResult } from "../useSpatialLayers";

const mocks = vi.hoisted(() => ({
  config: vi.fn(), inference: vi.fn(), startInference: vi.fn(), stopInference: vi.fn(), bindings: vi.fn(), calibrations: vi.fn(), sessions: vi.fn(), context: vi.fn(), truth: vi.fn(), createSession: vi.fn(),
}));

vi.mock("../api", () => ({ api: {
  houseSpatialLayerConfig: mocks.config,
  houseSpatialInferenceSession: mocks.inference,
  startHouseSpatialInferenceSession: mocks.startInference,
  stopHouseSpatialInferenceSession: mocks.stopInference,
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

const activeInference = {
  id: "inference-1",
  houseId: "house-1",
  status: "active" as const,
  startedAt: "2026-07-16T16:00:00.000Z",
  expiresAt: "2099-07-16T17:00:00.000Z",
  cadenceMinutes: 10,
  nextRunAt: "2099-07-16T16:10:00.000Z",
  lastScheduledAt: "2026-07-16T16:00:00.000Z",
  stoppedAt: null,
  createdBy: "owner-1",
  createdAt: "2026-07-16T16:00:00.000Z",
  updatedAt: "2026-07-16T16:00:00.000Z",
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
    mocks.inference.mockResolvedValue(null);
    mocks.startInference.mockResolvedValue(activeInference);
    mocks.stopInference.mockResolvedValue({ ...activeInference, status: "stopped", stoppedAt: "2026-07-16T16:30:00.000Z" });
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
    expect(mocks.sessions).toHaveBeenCalledWith("house-1", expect.any(AbortSignal));

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
    }), expect.any(AbortSignal)));
  });

  it("keeps inference off by default and starts and stops a bounded session", async () => {
    const sensor = createDemoState().sensors[0]!;
    const view = render(<I18nProvider><SpatialLayerLab houseId="house-1" sensors={[sensor]} layers={layerState()} /></I18nProvider>);
    const details = view.container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });

    await screen.findByText("Experimental spatial analysis");
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByLabelText("Run for")).toHaveValue("60");
    expect(screen.getByLabelText("Update every")).toHaveValue("10");

    fireEvent.click(screen.getByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(mocks.startInference).toHaveBeenCalledWith("house-1", {
      durationMinutes: 60,
      cadenceMinutes: 10,
    }, expect.any(AbortSignal)));
    expect((await screen.findAllByText("Running")).length).toBeGreaterThan(0);
    expect(screen.getByText("Stops at")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop analysis" }));
    await waitFor(() => expect(mocks.stopInference).toHaveBeenCalledWith("house-1", expect.any(AbortSignal)));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
  });

  it("does not let visibility revalidation supersede a pending start", async () => {
    const sensor = createDemoState().sensors[0]!;
    let resolveStart!: (value: typeof activeInference) => void;
    mocks.startInference.mockReturnValueOnce(new Promise<typeof activeInference>((resolve) => { resolveStart = resolve; }));
    const view = render(<I18nProvider><SpatialLayerLab houseId="house-1" sensors={[sensor]} layers={layerState()} /></I18nProvider>);
    const details = view.container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    await screen.findByText("Experimental spatial analysis");
    expect(mocks.inference).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(mocks.startInference).toHaveBeenCalledOnce());
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.inference).toHaveBeenCalledOnce();

    await act(async () => {
      resolveStart(activeInference);
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Stop analysis" })).toBeEnabled();
    expect((await screen.findAllByText("Running")).length).toBeGreaterThan(0);
  });

  it("does not let visibility revalidation supersede a pending stop", async () => {
    const sensor = createDemoState().sensors[0]!;
    const stoppedInference = { ...activeInference, status: "stopped" as const, stoppedAt: "2026-07-16T16:30:00.000Z" };
    let resolveStop!: (value: typeof stoppedInference) => void;
    mocks.inference.mockResolvedValue(activeInference);
    mocks.stopInference.mockReturnValueOnce(new Promise<typeof stoppedInference>((resolve) => { resolveStop = resolve; }));
    const view = render(<I18nProvider><SpatialLayerLab houseId="house-1" sensors={[sensor]} layers={layerState()} /></I18nProvider>);
    const details = view.container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    await screen.findByRole("button", { name: "Stop analysis" });
    expect(mocks.inference).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Stop analysis" }));
    await waitFor(() => expect(mocks.stopInference).toHaveBeenCalledOnce());
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.inference).toHaveBeenCalledOnce();

    await act(async () => {
      resolveStop(stoppedInference);
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Start analysis" })).toBeEnabled();
    expect((await screen.findAllByText("Stopped")).length).toBeGreaterThan(0);
  });

  it("revalidates the bounded session on reopen and visibility return without reloading all lab data", async () => {
    const sensor = createDemoState().sensors[0]!;
    const view = render(<I18nProvider><SpatialLayerLab houseId="house-1" sensors={[sensor]} layers={layerState()} /></I18nProvider>);
    const details = view.container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    await waitFor(() => expect(mocks.config).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.inference).toHaveBeenCalledOnce());

    await act(async () => {
      details.open = false;
      fireEvent(details, new Event("toggle"));
    });
    mocks.inference.mockResolvedValueOnce(activeInference);
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });

    await waitFor(() => expect(mocks.inference).toHaveBeenCalledTimes(2));
    expect(mocks.config).toHaveBeenCalledOnce();
    expect((await screen.findAllByText("Running")).length).toBeGreaterThan(0);

    mocks.inference.mockResolvedValueOnce(null);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(mocks.inference).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(mocks.config).toHaveBeenCalledOnce();
  });

  it("aborts and ignores an old Home load when the disclosure stays open", async () => {
    const sensor = createDemoState().sensors[0]!;
    let resolveOld!: (value: Awaited<ReturnType<typeof mocks.config>>) => void;
    let oldSignal: AbortSignal | undefined;
    const oldTopology = { scope: { kind: "house" as const, id: "house-1" }, frames: [], zones: [], connections: [], sensorBindings: [] };
    const newTopology = { scope: { kind: "house" as const, id: "house-2" }, frames: [], zones: [], connections: [], sensorBindings: [] };
    mocks.config.mockImplementation((targetHouseId: string, signal?: AbortSignal) => {
      if (targetHouseId === "house-1") {
        oldSignal = signal;
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return Promise.resolve({
        configuration: { version: 2, enabled: true, config: { marker: "new" }, topology: newTopology },
        assignments: [],
        topology: newTopology,
      });
    });

    const panel = (houseId: string) => <I18nProvider><SpatialLayerLab houseId={houseId} sensors={[sensor]} layers={layerState()} /></I18nProvider>;
    const view = render(panel("house-1"));
    const details = view.container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    await waitFor(() => expect(mocks.config).toHaveBeenCalledWith("house-1", expect.any(AbortSignal)));

    view.rerender(panel("house-2"));
    await waitFor(() => expect(mocks.config).toHaveBeenCalledWith("house-2", expect.any(AbortSignal)));
    await waitFor(() => expect(screen.getByLabelText("Versioned engine configuration (JSON)")).toHaveValue(JSON.stringify({ marker: "new" }, null, 2)));
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      resolveOld({
        configuration: { version: 1, enabled: true, config: { marker: "old" }, topology: oldTopology },
        assignments: [],
        topology: oldTopology,
      });
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Versioned engine configuration (JSON)")).toHaveValue(JSON.stringify({ marker: "new" }, null, 2));
  });

  it("does not strand the session controls when closed during a start request", async () => {
    const sensor = createDemoState().sensors[0]!;
    let resolveStart!: (value: typeof activeInference) => void;
    mocks.startInference.mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve; }));
    const view = render(<I18nProvider><SpatialLayerLab houseId="house-1" sensors={[sensor]} layers={layerState()} /></I18nProvider>);
    const details = view.container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    await screen.findByText("Experimental spatial analysis");

    fireEvent.click(screen.getByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(mocks.startInference).toHaveBeenCalledOnce());
    await act(async () => {
      details.open = false;
      fireEvent(details, new Event("toggle"));
      expect(mocks.startInference.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ aborted: true }));
      resolveStart(activeInference);
      await Promise.resolve();
    });
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });

    await waitFor(() => expect(mocks.inference).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Start analysis" })).toBeEnabled();
  });
});
