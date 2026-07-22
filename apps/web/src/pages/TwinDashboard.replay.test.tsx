import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MeasurementSample, Sensor } from "@climate-twin/contracts";
import type { ClimateState } from "../domain";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { observationTimeFields, TwinDashboard } from "./TwinDashboard";

function renderDashboard(state: ClimateState, dataMode: "demo" | "real" | "unknown" = "demo", readOnly = false, viewMode: "plan" | "isometric" = "plan") {
  const house = state.houses[0]!;
  const floor = house.floors[0]!;
  const sensor = state.sensors.find((item) => item.houseId === house.id && item.enabled)!;
  const props = {
    house, floor, houseId: house.id, floorId: floor.id,
    metric: "temperature" as const, units: "metric" as const, viewMode,
    selectedSensorId: sensor.id, saveState: "idle" as const, scenario: "normal" as const, dataMode, readOnly,
    onHouse: vi.fn(), onFloor: vi.fn(), onMetric: vi.fn(), onViewMode: vi.fn(),
    onSensorSelect: vi.fn(), onSensorMove: vi.fn(), onSensorUpdate: vi.fn(),
    onFloorChange: vi.fn(), onSaveLayout: vi.fn(), onLoadSeries: vi.fn(), onRunScenario: vi.fn(),
    onLoadReplaySeries: vi.fn(async (sensorId: string, metric: string, window: { from: string; to: string; bucketSeconds: number | null }) => {
      const samples = (state.measurementHistory[sensorId]?.[metric] ?? []).filter((sample) => {
        const timestamp = Date.parse(sample.timestamp);
        return timestamp >= Date.parse(window.from) && timestamp <= Date.parse(window.to);
      });
      return { samples, from: window.from, to: window.to, bucketSeconds: window.bucketSeconds, truncated: false };
    }),
    onOpenSensors: vi.fn(),
    onCreateObservation: vi.fn().mockResolvedValue(state.observations[0]!),
    onCreateStaticParameter: vi.fn().mockResolvedValue(state.staticParameters[0]!),
  };
  const view = render(<I18nProvider><TwinDashboard state={state} {...props} /></I18nProvider>);
  return {
    ...view,
    sensor,
    onFloor: props.onFloor,
    onMetric: props.onMetric,
    onSensorSelect: props.onSensorSelect,
    onLoadSeries: props.onLoadSeries,
    onLoadReplaySeries: props.onLoadReplaySeries,
    onFloorChange: props.onFloorChange,
    onSensorUpdate: props.onSensorUpdate,
    onCreateObservation: props.onCreateObservation,
    onOpenSensors: props.onOpenSensors,
    rerenderState(nextState: ClimateState) {
      view.rerender(<I18nProvider><TwinDashboard state={nextState} {...props} /></I18nProvider>);
    },
    rerenderHouse(nextState: ClimateState, nextHouseId: string) {
      const nextHouse = nextState.houses.find((candidate) => candidate.id === nextHouseId)!;
      const nextFloor = nextHouse.floors[0]!;
      view.rerender(<I18nProvider><TwinDashboard
        state={nextState}
        {...props}
        house={nextHouse}
        floor={nextFloor}
        houseId={nextHouse.id}
        floorId={nextFloor.id}
      /></I18nProvider>);
    },
  };
}

describe("TwinDashboard full-page home view", () => {
  it.each([
    ["plan", "Plan"],
    ["isometric", "3D building"],
  ] as const)("expands and exits the %s view", (viewMode, activeViewLabel) => {
    renderDashboard(createDemoState(), "demo", false, viewMode);
    expect(screen.getByRole("button", { name: activeViewLabel }).getAttribute("aria-pressed")).toBe("true");

    const enterButton = screen.getByRole("button", { name: "View full page" });
    const panel = enterButton.closest(".twin-panel");
    fireEvent.click(enterButton);

    expect(panel?.classList.contains("is-full-page")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("button", { name: "Exit full page" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel?.classList.contains("is-full-page")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(screen.getByRole("button", { name: "View full page" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("TwinDashboard plug map layer", () => {
  it("shows compact plug stats on the 2D map and can hide the layer", () => {
    localStorage.removeItem("stuga-home-map-energy-devices-visible");
    const base = createDemoState();
    const floor = base.houses[0]!.floors[0]!;
    const plug: Sensor = {
      ...base.sensors[0]!, id: "plug-p110", floorId: floor.id, name: "Coffee plug", model: "P110", tpLinkDeviceId: "p110-1",
    };
    const power: MeasurementSample = { sensorId: plug.id, metric: "power", value: 840, canonicalUnit: "W", timestamp: new Date().toISOString(), source: "tp-link", quality: "good" };
    const energy: MeasurementSample = { ...power, metric: "energy", value: 2.5, canonicalUnit: "kWh" };
    const state: ClimateState = {
      ...base,
      sensors: [...base.sensors, plug],
      latestMeasurements: { ...base.latestMeasurements, [plug.id]: { power, energy } },
    };
    const view = renderDashboard(state);

    const marker = view.container.querySelector(".sensor-marker.energy-device");
    expect(marker?.textContent).toContain("840 W");
    expect(marker?.textContent).toContain("2.50 kWh");
    const layerButton = screen.getByRole("button", { name: "Plug sensors" });
    expect(layerButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(layerButton);
    expect(layerButton.getAttribute("aria-pressed")).toBe("false");
    expect(view.container.querySelector(".sensor-marker.energy-device")).toBeNull();
    view.unmount();
    localStorage.removeItem("stuga-home-map-energy-devices-visible");
  });
});

describe("observation time conversion", () => {
  it("converts property-local times across ordinary offsets and rejects gaps and exact folds", () => {
    expect(observationTimeFields("exact", "2026-07-15T12:00", "", "", "", "Europe/Helsinki"))
      .toMatchObject({ occurredAt: "2026-07-15T09:00:00.000Z" });
    expect(observationTimeFields("exact", "2026-07-15T12:00:37", "", "", "", "Europe/Helsinki"))
      .toMatchObject({ occurredAt: "2026-07-15T09:00:37.000Z" });
    expect(observationTimeFields("exact", "2026-07-15T12:00", "", "", "", "America/New_York"))
      .toMatchObject({ occurredAt: "2026-07-15T16:00:00.000Z" });
    expect(observationTimeFields("exact", "2026-03-29T03:30", "", "", "", "Europe/Helsinki")).toBeNull();
    expect(observationTimeFields("approximate", "2026-03-29T03:30", "", "", "", "Europe/Helsinki")).toBeNull();
    expect(observationTimeFields("exact", "2026-10-25T03:30", "", "", "", "Europe/Helsinki")).toBeNull();
    expect(observationTimeFields("approximate", "2026-10-25T03:30", "", "", "", "Europe/Helsinki")?.occurredAt)
      .toMatch(/^2026-10-25T0[01]:30:00\.000Z$/);
  });
});

describe("TwinDashboard observation capture", () => {
  it("preserves a date range, source, confidence, and conservative defaults in the saved payload", async () => {
    const view = renderDashboard(createDemoState());
    fireEvent.click(screen.getByText("Open analysis tools"));
    expect(screen.getByRole("heading", { name: "Test scenario" })).not.toBeNull();

    const precision = screen.getByLabelText("Time precision");
    expect(within(precision).getByRole("option", { name: "Exact time" })).not.toBeNull();
    expect(within(precision).getByRole("option", { name: "Approximate time" })).not.toBeNull();
    expect(within(precision).getByRole("option", { name: "Date only" })).not.toBeNull();
    expect(within(precision).getByRole("option", { name: "Date range" })).not.toBeNull();
    expect(within(precision).getByRole("option", { name: "Unknown time" })).not.toBeNull();
    expect((screen.getByLabelText("Source") as HTMLSelectElement).value).toBe("unknown");
    expect((screen.getByLabelText("Confidence") as HTMLSelectElement).value).toBe("uncertain");

    fireEvent.change(precision, { target: { value: "date-range" } });
    fireEvent.change(screen.getByLabelText("Valid from"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Valid to"), { target: { value: "2026-01-31" } });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "contractor" } });
    fireEvent.change(screen.getByLabelText("Confidence"), { target: { value: "awaiting-inspection" } });
    fireEvent.change(screen.getByLabelText("Source details"), { target: { value: "Roof inspection report" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Roof remained wet" } });
    fireEvent.click(screen.getByRole("button", { name: "Log observation" }));

    const map = screen.getByRole("group", { name: /Temperature map for/i });
    fireEvent.keyDown(map, { key: "Enter" });
    await waitFor(() => expect(view.onCreateObservation).toHaveBeenCalledOnce());
    const payload = view.onCreateObservation.mock.calls[0]![0];
    expect(payload).toMatchObject({
      timePrecision: "date-range",
      validFrom: "2026-01-01",
      validTo: "2026-01-31",
      source: "contractor",
      sourceDetail: "Roof inspection report",
      confidence: "awaiting-inspection",
      note: "Roof remained wet",
    });
    expect(payload).not.toHaveProperty("occurredAt");
  });

  it("hides scenario controls while the data environment is unconfirmed", () => {
    renderDashboard(createDemoState(), "unknown");
    fireEvent.click(screen.getByText("Open analysis tools"));
    expect(screen.queryByRole("heading", { name: "Test scenario" })).toBeNull();
  });

  it("resets house-local wall time and cancels placement when the house changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    try {
      const demo = createDemoState();
      const helsinki = demo.houses[0]!;
      const newYork = {
        ...helsinki,
        id: "house-new-york",
        name: "New York house",
        timezone: "America/New_York",
        floors: helsinki.floors.map((floor) => ({ ...floor, id: `ny-${floor.id}` })),
      };
      const state = { ...demo, houses: [helsinki, newYork] };
      const view = renderDashboard(state);
      fireEvent.click(screen.getByText("Open analysis tools"));
      const localTime = view.container.querySelector<HTMLInputElement>('.observation-form input[type="datetime-local"]')!;
      expect(localTime.value).toBe("2026-07-15T15:00");

      fireEvent.submit(view.container.querySelector(".observation-form")!);
      expect((view.container.querySelector(".observation-fields") as HTMLFieldSetElement).disabled).toBe(true);
      view.rerenderHouse(state, newYork.id);

      expect(view.container.querySelector<HTMLInputElement>('.observation-form input[type="datetime-local"]')!.value).toBe("2026-07-15T08:00");
      expect((view.container.querySelector(".observation-fields") as HTMLFieldSetElement).disabled).toBe(false);
      expect(view.onCreateObservation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TwinDashboard room geometry", () => {
  it("keeps room geometry edits separate and protects assigned rooms from removal", () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const room = floor.rooms.find((candidate) => state.sensors.some((sensor) => sensor.floorId === floor.id && sensor.room === candidate.name))!;
    const view = renderDashboard(state);

    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: `Room: ${room.name}` }));
    const roomName = screen.getByLabelText("Name");
    fireEvent.focus(roomName);
    fireEvent.change(roomName, { target: { value: "Renamed room geometry" } });
    fireEvent.blur(roomName, { target: { value: "Renamed room geometry" } });

    expect(view.onFloorChange).toHaveBeenCalled();
    expect(view.onSensorUpdate).not.toHaveBeenCalled();

    const changesBeforeDelete = view.onFloorChange.mock.calls.length;
    fireEvent.click(screen.getByText("Editor options", { selector: "summary" }));
    const deleteRoom = screen.getByRole("button", { name: "Delete room" });
    expect((deleteRoom as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(deleteRoom);
    expect(view.onFloorChange.mock.calls.length).toBe(changesBeforeDelete);
    expect(view.onSensorUpdate).not.toHaveBeenCalled();
  });
});

describe("TwinDashboard progressive disclosure", () => {
  it("keeps Guest dashboards observational", () => {
    renderDashboard(createDemoState(), "demo", true);
    expect(screen.queryByRole("button", { name: "Edit layout" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finish setup" })).toBeNull();

    fireEvent.click(screen.getByText("Open analysis tools"));
    expect(screen.queryByRole("heading", { name: "Test scenario" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Log observation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add context" })).toBeNull();
  });

  it("leads with Home Pulse and keeps optional Home utilities closed", () => {
    const view = renderDashboard(createDemoState());
    const decisionLayer = view.container.querySelector(".decision-layer")!;
    const liveView = view.container.querySelector(".twin-panel")!;
    const secondary = view.container.querySelector(".home-secondary-grid")!;

    expect(decisionLayer.compareDocumentPosition(liveView) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(liveView.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const observation = view.container.querySelector<HTMLDetailsElement>(".observation-composer.collapsible");
    const operations = view.container.querySelector<HTMLDetailsElement>(".home-operations-disclosure")!;
    expect(observation).toBeNull();
    expect(operations.open).toBe(false);
    expect(within(operations).queryByRole("button", { name: "View all activity" })).toBeNull();

    fireEvent.click(within(operations).getByText("Activity and maintenance overview", { selector: "strong" }));
    expect(operations.open).toBe(true);
    expect(within(operations).getByRole("heading", { name: "Recent activity" })).not.toBeNull();
    expect(within(operations).getByRole("heading", { name: "Upcoming maintenance" })).not.toBeNull();
  });

  it("keeps no-data recovery in Home Pulse and removes duplicate home-level controls", () => {
    const demo = createDemoState();
    const state: ClimateState = { ...demo, latestMeasurements: {}, measurementHistory: {}, alerts: [] };
    const view = renderDashboard(state);

    expect(screen.getByRole("region", { name: "A few things need attention" })).toBeTruthy();
    expect(view.container.querySelector(".moisture-coach")).toBeNull();
    expect(view.container.querySelector(".home-status-zone")).toBeNull();
    expect(view.container.querySelector(".room-comfort-section")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Finish setup" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(view.onOpenSensors).toHaveBeenCalledWith(demo.houses[0]!.id);

    expect(screen.queryByLabelText("House")).toBeNull();
    const floorPicker = screen.getByLabelText("Floor");
    expect(floorPicker.closest("header")).toBeNull();
    expect(floorPicker.closest(".twin-toolbar")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Manage homes" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Edit layout" })).toHaveLength(1);
  });

  it("labels the alert-only summary independently from the broader Home Pulse", () => {
    const view = renderDashboard(createDemoState());
    expect(view.container.querySelector('[data-summary-scope="threshold-alerts"] small')?.textContent).toBe("Open events");
  });
});

describe("TwinDashboard replay timing", () => {
  it("loads an arbitrary house-local recording window at the selected resolution", async () => {
    const demo = createDemoState();
    const view = renderDashboard(demo);
    const historyWindow = screen.getByRole("form", { name: "History window" });

    fireEvent.change(within(historyWindow).getByLabelText("From"), { target: { value: "2024-02-10T00:00" } });
    fireEvent.change(within(historyWindow).getByLabelText("To"), { target: { value: "2024-02-11T00:00" } });
    fireEvent.change(within(historyWindow).getByLabelText("Resolution"), { target: { value: "300" } });
    fireEvent.click(within(historyWindow).getByRole("button", { name: "Load recording" }));

    await waitFor(() => expect(view.onLoadReplaySeries).toHaveBeenCalled());
    const requestedWindows = view.onLoadReplaySeries.mock.calls.map(([, , window]) => window);
    expect(requestedWindows.length).toBeGreaterThan(demo.sensors.filter((sensor) => sensor.enabled).length);
    expect(requestedWindows).toEqual(expect.arrayContaining([{
      from: "2024-02-09T22:00:00.000Z",
      to: "2024-02-10T22:00:00.000Z",
      bucketSeconds: 300,
    }]));
    await waitFor(() => expect(within(historyWindow).getByText("0 samples loaded")).not.toBeNull());
    expect(screen.getByRole("heading", { name: "History & Events" })).not.toBeNull();
  });

  it("preloads climate history and seeks a detected event in its metric, floor, and sensor context", async () => {
    const demo = createDemoState();
    const selectedSensor = demo.sensors.find((sensor) => sensor.id === "sensor-living")!;
    const eventSensor = demo.sensors.find((sensor) => sensor.id === "sensor-bathroom")!;
    const temperatureSeed = demo.measurementHistory[selectedSensor.id]!.temperature![0]!;
    const humiditySeed = demo.measurementHistory[eventSensor.id]!.humidity![0]!;
    const fiveMinutes = 5 * 60_000;
    const origin = Math.floor((Date.now() - 2 * 60 * 60_000) / fiveMinutes) * fiveMinutes;
    const plateau = (seed: typeof humiditySeed, fromMinute: number, toMinute: number, value: number) => (
      Array.from({ length: (toMinute - fromMinute) / 5 + 1 }, (_, index) => ({
        ...seed,
        timestamp: new Date(origin + (fromMinute + index * 5) * 60_000).toISOString(),
        value,
      }))
    );
    const eventTimestamp = origin + 45 * 60_000;
    const state: ClimateState = {
      ...demo,
      measurementHistory: {
        [selectedSensor.id]: { temperature: plateau(temperatureSeed, 0, 100, 21) },
        [eventSensor.id]: {
          humidity: [
            ...plateau(humiditySeed, 0, 40, 66),
            ...plateau(humiditySeed, 45, 100, 52),
          ],
        },
      },
    };
    const view = renderDashboard(state);
    const expectedClimateLoads = demo.sensors
      .filter((sensor) => sensor.houseId === demo.houses[0]!.id && sensor.enabled)
      .flatMap((sensor) => ["temperature", "humidity"].map((metric) => `${sensor.id}:${metric}`));
    await waitFor(() => {
      const loaded = new Set(view.onLoadSeries.mock.calls.map(([sensorId, metric]) => `${sensorId}:${metric}`));
      expect([...loaded]).toEqual(expect.arrayContaining(expectedClimateLoads));
    });

    const events = screen.getByLabelText("Auto-tagged events");
    fireEvent.click(within(events).getByRole("button", { name: /Humidity fell 14 percentage points in Bathroom/ }));

    await waitFor(() => expect(Number((screen.getByRole("slider", { name: "Replay time" }) as HTMLInputElement).value)).toBe(eventTimestamp));
    expect(view.onMetric).toHaveBeenLastCalledWith("humidity");
    expect(view.onFloor).toHaveBeenLastCalledWith(eventSensor.floorId);
    expect(view.onSensorSelect).toHaveBeenLastCalledWith(eventSensor.id);
    expect(within(screen.getByLabelText("Auto-tagged events")).getByRole("button", { name: /Humidity fell 14 percentage points in Bathroom/ }).getAttribute("aria-current")).toBe("time");
  });

  it("starts first play at the beginning and advances at the selected minutes-per-second rate", () => {
    vi.useFakeTimers();
    const view = renderDashboard(createDemoState());
    try {
      const tools = view.container.querySelector(".home-tools-disclosure")!;
      const historyEvents = view.container.querySelector(".history-events-workspace")!;
      let slider = screen.getByRole("slider", { name: /Replay time/ }) as HTMLInputElement;
      expect(historyEvents.contains(screen.getByRole("region", { name: "Replay" }))).toBe(true);
      expect(tools.contains(screen.getByRole("region", { name: "Replay" }))).toBe(false);
      const minimum = Number(slider.min);
      expect(Number(slider.value)).toBe(Number(slider.max));

      fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
      slider = screen.getByRole("slider", { name: /Replay time/ }) as HTMLInputElement;
      expect(screen.getByRole("button", { name: "Pause replay" })).not.toBeNull();
      expect(screen.getByRole("button", { name: "Return to live" })).not.toBeNull();
      expect(historyEvents.contains(screen.getByRole("region", { name: "Replay" }))).toBe(true);
      expect(tools.contains(screen.getByRole("region", { name: "Replay" }))).toBe(false);
      expect(Number(slider.value)).toBe(minimum);

      act(() => vi.advanceTimersByTime(1_000));
      expect(Number(slider.value)).toBe(minimum + 4 * 60_000);

      const speed = screen.getByLabelText("Replay speed") as HTMLSelectElement;
      expect(within(speed).getByRole("option", { name: "4 minutes per second" })).not.toBeNull();
      fireEvent.change(speed, { target: { value: "12" } });
      act(() => vi.advanceTimersByTime(1_000));
      expect(Number(slider.value)).toBe(minimum + 16 * 60_000);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("keeps a first play request pending until history is available", () => {
    vi.useFakeTimers();
    const demo = createDemoState();
    const emptyState: ClimateState = { ...demo, measurementHistory: {} };
    const view = renderDashboard(emptyState);
    try {
      let slider = screen.getByRole("slider", { name: /Replay time/ }) as HTMLInputElement;
      fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
      slider = screen.getByRole("slider", { name: /Replay time/ }) as HTMLInputElement;
      const pendingTimestamp = Number(slider.value);

      expect(screen.getByRole("button", { name: "Play replay" })).not.toBeNull();
      act(() => vi.advanceTimersByTime(1_000));
      expect(Number(slider.value)).toBe(pendingTimestamp);

      const history = demo.measurementHistory[view.sensor.id]!.temperature!;
      const loadedState: ClimateState = {
        ...emptyState,
        measurementHistory: { [view.sensor.id]: { temperature: history } },
      };
      view.rerenderState(loadedState);

      const minimum = Number(slider.min);
      expect(screen.getByRole("button", { name: "Pause replay" })).not.toBeNull();
      expect(Number(slider.value)).toBe(minimum);
      act(() => vi.advanceTimersByTime(1_000));
      expect(Number(slider.value)).toBe(minimum + 4 * 60_000);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
