import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HouseWeather, MeasurementSample, OutdoorTemperatureSample, Sensor } from "@climate-twin/contracts";
import { api } from "../api";
import type { ClimateState } from "../domain";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { TwinDashboard } from "./TwinDashboard";
import { observationTimeFields } from "../observationTime";

function renderDashboard(
  state: ClimateState,
  dataMode: "demo" | "real" | "unknown" = "demo",
  readOnly = false,
  viewMode: "plan" | "isometric" = "plan",
  selectedSensorId?: string,
) {
  const house = state.houses[0]!;
  const floor = house.floors[0]!;
  const sensor = state.sensors.find((item) => item.id === selectedSensorId)
    ?? state.sensors.find((item) => item.houseId === house.id && item.enabled)!;
  const props = {
    house, floor, houseId: house.id, floorId: floor.id,
    metric: "temperature" as const, units: "metric" as const, viewMode,
    selectedSensorId: sensor.id, saveState: "idle" as const, scenario: "normal" as const, dataMode, readOnly,
    onHouse: vi.fn(), onFloor: vi.fn(), onMetric: vi.fn(), onViewMode: vi.fn(),
    onSensorSelect: vi.fn(), onSensorMove: vi.fn(), onSensorUpdate: vi.fn(),
    onFloorChange: vi.fn(), onSaveLayout: vi.fn(), onLoadSeries: vi.fn(), onRunScenario: vi.fn(),
    onLoadReplaySeries: vi.fn(async (sensorId: string, metric: string, window: { from: string; to: string; bucketSeconds: number | null }, _signal?: AbortSignal) => {
      const samples = (state.measurementHistory[sensorId]?.[metric] ?? []).filter((sample) => {
        const timestamp = Date.parse(sample.timestamp);
        return timestamp >= Date.parse(window.from) && timestamp <= Date.parse(window.to);
      });
      return { samples, from: window.from, to: window.to, bucketSeconds: window.bucketSeconds, truncated: false };
    }),
    onOpenSensors: vi.fn(),
    onOpenConnections: vi.fn(),
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
    onOpenConnections: props.onOpenConnections,
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

function openViewOptions() {
  const details = document.querySelector<HTMLDetailsElement>(".twin-view-options")!;
  if (!details.open) fireEvent.click(details.querySelector("summary")!);
  return details;
}

describe("TwinDashboard full-page home view", () => {
  it.each([
    ["plan", "Plan"],
    ["isometric", "3D building"],
  ] as const)("expands and exits the %s view", async (viewMode, activeViewLabel) => {
    renderDashboard(createDemoState(), "demo", false, viewMode);
    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    expect((await screen.findByRole("button", { name: activeViewLabel })).getAttribute("aria-pressed")).toBe("true");

    openViewOptions();
    const enterButton = screen.getByRole("button", { name: "View full page" });
    const panel = enterButton.closest(".twin-panel");
    const disclosure = enterButton.closest("details")!;
    const disclosureSummary = disclosure.querySelector<HTMLElement>("summary")!;
    fireEvent.click(enterButton);

    expect(panel?.classList.contains("is-full-page")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("button", { name: "Exit full page" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(enterButton, { key: "Escape" });
    expect(disclosure.open).toBe(false);
    expect(panel?.classList.contains("is-full-page")).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel?.classList.contains("is-full-page")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(screen.getByRole("button", { name: "View full page" }).getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(disclosureSummary));
  });
});

describe("TwinDashboard plug map layer", () => {
  it("shows compact plug stats on the 2D map and can hide the layer", async () => {
    localStorage.removeItem("stugu-home-map-energy-devices-visible");
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
    const view = renderDashboard(state, "demo", false, "plan", plug.id);
    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    openViewOptions();

    const marker = await waitFor(() => {
      const candidate = view.container.querySelector(".sensor-marker.energy-device");
      expect(candidate).not.toBeNull();
      return candidate;
    });
    expect(marker?.textContent).toContain("840 W");
    expect(marker?.textContent).toContain("2.50 kWh");
    const inspector = await waitFor(() => {
      const candidate = view.container.querySelector<HTMLElement>(".sensor-inspector");
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    expect(within(inspector).queryByText("Temperature")).toBeNull();
    expect(within(inspector).getByText("Power")).not.toBeNull();
    expect(within(inspector).getByText("Electricity consumption")).not.toBeNull();
    const layerButton = screen.getByRole("button", { name: "Plug sensors" });
    expect(layerButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(layerButton);
    expect(layerButton.getAttribute("aria-pressed")).toBe("false");
    expect(view.container.querySelector(".sensor-marker.energy-device")).toBeNull();
    view.unmount();
    localStorage.removeItem("stugu-home-map-energy-devices-visible");
  });
});

describe("TwinDashboard climate-sensor map layer", () => {
  it("hides only the markers in 2D and 3D while keeping the climate visualizations", async () => {
    const preferenceKey = "stugu-home-map-climate-sensors-visible";
    localStorage.removeItem(preferenceKey);

    const plan = renderDashboard(createDemoState(), "demo", false, "plan");
    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    openViewOptions();
    await waitFor(() => {
      expect(plan.container.querySelector(".sensor-marker:not(.energy-device)")).not.toBeNull();
      expect(plan.container.querySelector(".heat-cloud-lobe")).not.toBeNull();
    });

    const planLayerButton = screen.getByRole("button", { name: "Climate sensors" });
    fireEvent.click(planLayerButton);
    expect(planLayerButton.getAttribute("aria-pressed")).toBe("false");
    expect(plan.container.querySelector(".sensor-marker:not(.energy-device)")).toBeNull();
    expect(plan.container.querySelector(".heat-cloud-lobe")).not.toBeNull();
    await waitFor(() => expect(localStorage.getItem(preferenceKey)).toBe("false"));
    plan.unmount();

    const building = renderDashboard(createDemoState(), "demo", false, "isometric");
    const buildingLiveViewButton = screen.queryByRole("button", { name: "Open live home view" });
    if (buildingLiveViewButton) fireEvent.click(buildingLiveViewButton);
    openViewOptions();
    const buildingLayerButton = await screen.findByRole("button", { name: "Climate sensors" });
    expect(buildingLayerButton.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => {
      expect(building.container.querySelector(".building-sensor:not(.energy-device)")).toBeNull();
      expect(building.container.querySelector(".building-volume-cloud")).not.toBeNull();
    });

    fireEvent.click(buildingLayerButton);
    expect(buildingLayerButton.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(building.container.querySelector(".building-sensor:not(.energy-device)")).not.toBeNull());
    building.unmount();
    localStorage.removeItem(preferenceKey);
  });
});

describe("TwinDashboard opening-status layer", () => {
  it("toggles and persists the 3D opening labels without removing opening controls", async () => {
    const preferenceKey = "stugu-home-map-opening-state-labels-visible";
    localStorage.removeItem(preferenceKey);
    const demo = createDemoState();
    const floor = demo.houses[0]!.floors[0]!;
    const house = {
      ...demo.houses[0]!,
      floors: [{
        ...floor,
        planElements: [
          ...(floor.planElements ?? []),
          { id: "status-door", kind: "door" as const, wallId: floor.walls[0]!.id, position: { x: 220, y: 45 }, rotationDegrees: 0, state: "closed" as const },
        ],
      }, ...demo.houses[0]!.floors.slice(1)],
    };
    const state = { ...demo, houses: [house, ...demo.houses.slice(1)] };

    const first = renderDashboard(state, "demo", false, "isometric");
    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    openViewOptions();
    const layerButton = await screen.findByRole("button", { name: "Opening status" });
    expect(first.container.querySelector(".building-opening-state-badge")).not.toBeNull();
    expect(first.container.querySelector(".building-plan-element.opening-control")).not.toBeNull();

    fireEvent.click(layerButton);
    expect(layerButton.getAttribute("aria-pressed")).toBe("false");
    expect(first.container.querySelector(".building-opening-state-badge")).toBeNull();
    expect(first.container.querySelector(".building-plan-element.opening-control")).not.toBeNull();
    await waitFor(() => expect(localStorage.getItem(preferenceKey)).toBe("false"));
    first.unmount();

    const second = renderDashboard(state, "demo", false, "isometric");
    const liveViewButton = screen.queryByRole("button", { name: "Open live home view" });
    if (liveViewButton) fireEvent.click(liveViewButton);
    openViewOptions();
    expect((await screen.findByRole("button", { name: "Opening status" })).getAttribute("aria-pressed")).toBe("false");
    expect(second.container.querySelector(".building-opening-state-badge")).toBeNull();
    second.unmount();
    localStorage.removeItem(preferenceKey);
  });
});

describe("TwinDashboard wind display controls", () => {
  it("toggles and persists motion separately from outdoor UI extras", async () => {
    const animationKey = "stugu-home-map-animations-enabled";
    const extrasKey = "stugu-home-map-outdoor-extras-visible";
    localStorage.removeItem(animationKey);
    localStorage.removeItem(extrasKey);
    const demo = createDemoState();
    const house = {
      ...demo.houses[0]!,
      location: { latitude: 60.17, longitude: 24.94 },
      orientationDegrees: 0,
    };
    const state: ClimateState = { ...demo, houses: [house] };
    const response: HouseWeather = {
      houseId: house.id,
      location: house.location,
      provider: "fmi",
      attribution: "FMI open data",
      fetchedAt: "2026-07-31T07:05:00.000Z",
      forecastIssuedAt: null,
      stale: false,
      current: {
        timestamp: "2026-07-31T07:00:00.000Z",
        temperatureC: 12,
        relativeHumidityPercent: 78,
        windDirectionDegrees: 225,
        windSpeedMps: 4,
      },
      observationStation: null,
      forecast: [],
      warnings: [],
      unavailable: [],
    };
    const weather = vi.spyOn(api, "houseWeather").mockResolvedValue(response);

    try {
      const first = renderDashboard(state);
      fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
      openViewOptions();
      const animationButton = await screen.findByRole("button", { name: "Animations" });
      const detailsButton = screen.getByRole("button", { name: "Wind details" });
      await waitFor(() => expect(first.container.querySelector(".outdoor-wind-streak")).not.toBeNull());

      fireEvent.click(animationButton);
      expect(animationButton.getAttribute("aria-pressed")).toBe("false");
      expect(first.container.querySelector(".outdoor-wind-streak")).toBeNull();
      expect(first.container.querySelector(".outdoor-shell-windward-edge")).not.toBeNull();
      expect(first.container.querySelector(".outdoor-wind-label")).not.toBeNull();
      await waitFor(() => expect(localStorage.getItem(animationKey)).toBe("false"));

      fireEvent.click(detailsButton);
      expect(detailsButton.getAttribute("aria-pressed")).toBe("false");
      expect(first.container.querySelector(".outdoor-wind-label")).toBeNull();
      expect(first.container.querySelector(".outdoor-temperature-chip")).toBeNull();
      expect(first.container.querySelector(".outdoor-wind-contact-dot")).not.toBeNull();
      await waitFor(() => expect(localStorage.getItem(extrasKey)).toBe("false"));
      first.unmount();

      const second = renderDashboard(state);
      const secondLiveViewButton = screen.queryByRole("button", { name: "Open live home view" });
      if (secondLiveViewButton) fireEvent.click(secondLiveViewButton);
      openViewOptions();
      expect((await screen.findByRole("button", { name: "Animations" })).getAttribute("aria-pressed")).toBe("false");
      expect(screen.getByRole("button", { name: "Wind details" }).getAttribute("aria-pressed")).toBe("false");
      second.unmount();
    } finally {
      weather.mockRestore();
      localStorage.removeItem(animationKey);
      localStorage.removeItem(extrasKey);
    }
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
    expect(await screen.findByRole("heading", { name: "Test scenario" })).not.toBeNull();

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

    const map = await screen.findByRole("group", { name: /Temperature map for/i });
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
      expect(screen.getByRole("heading", { name: "Test scenario" })).not.toBeNull();
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
  it("keeps room geometry edits separate and protects assigned rooms from removal", async () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const room = floor.rooms.find((candidate) => state.sensors.some((sensor) => sensor.floorId === floor.id && sensor.room === candidate.name))!;
    const view = renderDashboard(state);

    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    openViewOptions();
    fireEvent.click(await screen.findByRole("button", { name: "Edit layout" }));
    fireEvent.pointerDown(await screen.findByRole("button", { name: `Room: ${room.name}` }));
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
  it("keeps core navigation visible and moves display controls behind View options", () => {
    const view = renderDashboard(createDemoState());
    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));

    const toolbar = view.container.querySelector<HTMLElement>(".twin-toolbar")!;
    const options = toolbar.querySelector<HTMLDetailsElement>(".twin-view-options")!;
    const optionsSummary = options.querySelector<HTMLElement>("summary")!;
    expect(options.open).toBe(false);
    expect(within(toolbar).getByRole("button", { name: "Plan" })).not.toBeNull();
    expect(within(toolbar).getByRole("button", { name: "3D building" })).not.toBeNull();
    expect(within(toolbar).getByRole("button", { name: "Hide live home view" })).not.toBeNull();
    expect(options.contains(within(toolbar).getByRole("button", { name: "Climate sensors" }))).toBe(true);

    fireEvent.click(optionsSummary);
    expect(options.open).toBe(true);
    expect(within(toolbar).getByRole("button", { name: "Climate sensors" })).not.toBeNull();
    expect(within(toolbar).getByRole("button", { name: "View full page" })).not.toBeNull();
    expect(within(toolbar).getByRole("button", { name: "Edit layout" })).not.toBeNull();

    fireEvent.keyDown(options, { key: "Escape" });
    expect(options.open).toBe(false);
    expect(document.activeElement).toBe(optionsSummary);
  });

  it("keeps Guest dashboards observational", () => {
    renderDashboard(createDemoState(), "demo", true);
    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    openViewOptions();
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
    const currentState = view.container.querySelector(".home-now")!;
    const explore = view.container.querySelector<HTMLDetailsElement>(".home-explore-disclosure")!;

    expect(decisionLayer.compareDocumentPosition(currentState) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(currentState.compareDocumentPosition(explore) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(view.container.querySelector(".twin-panel")).toBeNull();
    expect(screen.getByRole("button", { name: "Open live home view" }).getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector(".home-live-launcher")).toBeNull();
    expect(view.container.querySelector(".home-quick-links")).toBeNull();
    expect(explore.open).toBe(false);
    expect(currentState.querySelectorAll(".primary-button")).toHaveLength(1);

    const observation = view.container.querySelector<HTMLDetailsElement>(".observation-composer.collapsible");
    const operations = view.container.querySelector<HTMLDetailsElement>(".home-operations-disclosure")!;
    const history = view.container.querySelector(".history-events-workspace")!;
    const tools = view.container.querySelector(".home-tools-disclosure")!;
    expect(observation).toBeNull();
    expect(explore.contains(operations)).toBe(true);
    expect(explore.contains(history)).toBe(true);
    expect(explore.contains(tools)).toBe(true);
    expect(operations.open).toBe(false);
    expect(within(operations).queryByRole("button", { name: "View all activity" })).toBeNull();

    fireEvent.click(within(explore).getByText("Explore this home", { selector: "strong" }));
    expect(explore.open).toBe(true);
    fireEvent.click(within(operations).getByText("Activity and maintenance overview", { selector: "strong" }));
    expect(operations.open).toBe(true);
    expect(within(operations).getByRole("heading", { name: "Recent activity" })).not.toBeNull();
    expect(within(operations).getByRole("heading", { name: "Upcoming maintenance" })).not.toBeNull();
  });

  it("reveals the hidden live map when a room is selected from the decision view", () => {
    const view = renderDashboard(createDemoState());
    expect(view.container.querySelector(".twin-panel")).toBeNull();

    fireEvent.click(screen.getByText("Explore this home", { selector: "strong" }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Open .+\. Status:/ })[0]!);

    expect(view.container.querySelector("#home-live-map.twin-panel")).not.toBeNull();
    expect(view.onSensorSelect).toHaveBeenLastCalledWith(null);
  });

  it("keeps no-data recovery in Home Pulse and removes duplicate home-level controls", () => {
    const demo = createDemoState();
    const state: ClimateState = { ...demo, latestMeasurements: {}, measurementHistory: {}, alerts: [] };
    const view = renderDashboard(state);

    expect(screen.getByRole("region", { name: "Waiting for a reliable pulse" })).toBeTruthy();
    expect(view.container.querySelector(".moisture-coach")).toBeNull();
    expect(view.container.querySelector(".home-status-zone")).toBeNull();
    expect(view.container.querySelector(".room-comfort-section")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Check connections" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check connections" }));
    expect(view.onOpenConnections).toHaveBeenCalledWith(demo.houses[0]!.id);

    expect(screen.queryByLabelText("House")).toBeNull();
    fireEvent.click(screen.getByText("Explore this home", { selector: "strong" }));
    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    openViewOptions();
    const floorPicker = screen.getByLabelText("Floor");
    expect(floorPicker.closest("header")).toBeNull();
    expect(floorPicker.closest(".twin-toolbar")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Manage homes" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Edit layout" })).toHaveLength(1);
  });

  it("keeps alert status in Home Pulse instead of duplicating it in the current reading", () => {
    const view = renderDashboard(createDemoState());
    expect(view.container.querySelector('[data-summary-scope="threshold-alerts"]')).toBeNull();
    expect(view.container.querySelector(".home-pulse")).not.toBeNull();
  });
});

describe("TwinDashboard replay timing", () => {
  it("loads an arbitrary house-local recording window at the selected resolution", async () => {
    const demo = createDemoState();
    const view = renderDashboard(demo);
    fireEvent.click(screen.getByRole("button", { name: "Open history and replay" }));
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
    expect(screen.getByRole("heading", { name: "History & events" })).not.toBeNull();
  });

  it("loads every enabled measurement plus recorded external weather into replay", async () => {
    const demo = createDemoState();
    const house = {
      ...demo.houses[0]!,
      location: { latitude: 60.17, longitude: 24.94 },
      orientationDegrees: 0,
    };
    const state: ClimateState = { ...demo, houses: [house] };
    const weatherSample: OutdoorTemperatureSample = {
      houseId: house.id,
      locationKey: "test-location",
      timestamp: "2024-02-10T10:00:00.000Z",
      temperatureC: 5,
      source: "fmi-observation",
      fetchedAt: "2024-02-10T10:05:00.000Z",
      stationId: "test-station",
      stationName: "Test station",
      conditions: {
        timestamp: "2024-02-10T10:00:00.000Z",
        temperatureC: 5,
        relativeHumidityPercent: 83,
        pressureHpa: 1_008,
        windDirectionDegrees: 270,
        windSpeedMps: 6,
      },
    };
    const liveWeather = vi.spyOn(api, "houseWeather").mockRejectedValue(new Error("Live weather is not used by replay"));
    const outdoorHistory = vi.spyOn(api, "outdoorTemperatureHistory").mockImplementation(async (_houseId, from, to) => ({
      samples: Date.parse(from) <= Date.parse(weatherSample.timestamp) && Date.parse(to) >= Date.parse(weatherSample.timestamp)
        ? [weatherSample]
        : [],
      from,
      to,
      truncated: false,
    }));
    const view = renderDashboard(state);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open history and replay" }));
      const historyWindow = screen.getByRole("form", { name: "History window" });
      fireEvent.change(within(historyWindow).getByLabelText("From"), { target: { value: "2024-02-10T00:00" } });
      fireEvent.change(within(historyWindow).getByLabelText("To"), { target: { value: "2024-02-11T00:00" } });
      fireEvent.click(within(historyWindow).getByRole("button", { name: "Load recording" }));

      await waitFor(() => expect(outdoorHistory).toHaveBeenCalledWith(
        house.id,
        "2024-02-09T22:00:00.000Z",
        "2024-02-10T22:00:00.000Z",
        20_000,
        expect.any(AbortSignal),
      ));
      const expectedPairs = state.sensors
        .filter((sensor) => sensor.houseId === house.id && sensor.enabled)
        .flatMap((sensor) => state.measurementDefinitions.map((definition) => `${sensor.id}:${definition.id}`));
      await waitFor(() => {
        const requestedPairs = new Set(view.onLoadReplaySeries.mock.calls.map(([sensorId, metric]) => `${sensorId}:${metric}`));
        expect([...requestedPairs]).toEqual(expect.arrayContaining(expectedPairs));
      });
      expect(within(historyWindow).getByText("1 sample loaded")).not.toBeNull();

      fireEvent.change(screen.getByRole("slider", { name: "Replay time" }), {
        target: { value: String(Date.parse(weatherSample.timestamp)) },
      });
      expect(await screen.findByText("Outside then")).not.toBeNull();
      expect(screen.getAllByText("5 °C")).toHaveLength(2);
      expect(screen.getAllByText("83%").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("6 m/s")).not.toBeNull();
      expect(view.container.querySelector(".outdoor-shell-windward-edge")).not.toBeNull();
    } finally {
      view.unmount();
      outdoorHistory.mockRestore();
      liveWeather.mockRestore();
    }
  });

  it("aborts superseded replay-window fanout and the active fanout on unmount", async () => {
    const demo = createDemoState();
    const house = { ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 } };
    const state: ClimateState = { ...demo, houses: [house] };
    const outdoorHistory = vi.spyOn(api, "outdoorTemperatureHistory")
      .mockImplementation(() => new Promise(() => {}));
    const view = renderDashboard(state);
    view.onLoadReplaySeries.mockImplementation(() => new Promise(() => {}));

    fireEvent.click(screen.getByRole("button", { name: "Open history and replay" }));
    const historyWindow = screen.getByRole("form", { name: "History window" });
    fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
    expect(await screen.findByText("Loading outdoor conditions…")).not.toBeNull();
    expect(view.container.querySelector(".outdoor-context-card .spin")).not.toBeNull();
    fireEvent.change(within(historyWindow).getByLabelText("From"), { target: { value: "2024-02-10T00:00" } });
    fireEvent.change(within(historyWindow).getByLabelText("To"), { target: { value: "2024-02-11T00:00" } });

    act(() => {
      historyWindow.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      historyWindow.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(new Set(view.onLoadReplaySeries.mock.calls.map((call) => call[3])).size).toBe(2));
    const historySignals = [...new Set(view.onLoadReplaySeries.mock.calls.map((call) => call[3] as AbortSignal))];
    expect(historySignals[0]?.aborted).toBe(true);
    expect(historySignals[1]?.aborted).toBe(false);
    const customOutdoorSignals = outdoorHistory.mock.calls
      .filter(([, from]) => from === "2024-02-09T22:00:00.000Z")
      .map((call) => call[4] as AbortSignal);
    expect(customOutdoorSignals).toHaveLength(2);
    expect(customOutdoorSignals[0]?.aborted).toBe(true);
    expect(customOutdoorSignals[1]?.aborted).toBe(false);

    view.unmount();
    expect(historySignals[1]?.aborted).toBe(true);
    expect(customOutdoorSignals[1]?.aborted).toBe(true);
  });

  it("clears replay outdoor loading when a recording request genuinely fails", async () => {
    const demo = createDemoState();
    const house = { ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 } };
    const state: ClimateState = { ...demo, houses: [house] };
    vi.spyOn(api, "outdoorTemperatureHistory").mockImplementation(() => new Promise(() => {}));
    localStorage.setItem("climate-twin-outdoor-panel", "expanded");
    const view = renderDashboard(state);
    view.onLoadReplaySeries.mockRejectedValue(new Error("Recording unavailable"));

    fireEvent.click(screen.getByRole("button", { name: "Open history and replay" }));
    const historyWindow = screen.getByRole("form", { name: "History window" });
    fireEvent.change(within(historyWindow).getByLabelText("From"), { target: { value: "2024-02-10T00:00" } });
    fireEvent.change(within(historyWindow).getByLabelText("To"), { target: { value: "2024-02-11T00:00" } });
    fireEvent.click(within(historyWindow).getByRole("button", { name: "Load recording" }));

    expect(await screen.findByText("Recording unavailable")).not.toBeNull();
    expect(screen.queryByText("Loading outdoor conditions…")).toBeNull();
    expect(view.container.querySelector(".outdoor-context-card .spin")).toBeNull();

    view.unmount();
    localStorage.removeItem("climate-twin-outdoor-panel");
  });

  it("loads broad climate history only when replay is opened and seeks a detected event in context", async () => {
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
    const expectedReplayLoads = demo.sensors
      .filter((sensor) => sensor.houseId === demo.houses[0]!.id && sensor.enabled)
      .flatMap((sensor) => demo.measurementDefinitions.map((definition) => `${sensor.id}:${definition.id}`));
    await waitFor(() => expect(view.onLoadSeries).toHaveBeenCalledWith(
      selectedSensor.id,
      "temperature",
      "24h",
      true,
      expect.any(AbortSignal),
    ));
    expect(new Set(view.onLoadSeries.mock.calls.map(([sensorId, metric]) => `${sensorId}:${metric}`)))
      .toEqual(new Set([`${selectedSensor.id}:temperature`]));
    expect(view.onLoadSeries).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open history and replay" }));
    await waitFor(() => {
      const loaded = new Set(view.onLoadSeries.mock.calls.map(([sensorId, metric]) => `${sensorId}:${metric}`));
      expect(loaded).toEqual(new Set(expectedReplayLoads));
    });
    expect(view.onLoadSeries).toHaveBeenCalledTimes(expectedReplayLoads.length);
    const events = screen.getByLabelText("Auto-tagged events");
    fireEvent.click(within(events).getByRole("button", { name: /Humidity fell 14 percentage points in Bathroom/ }));

    await waitFor(() => expect(Number((screen.getByRole("slider", { name: "Replay time" }) as HTMLInputElement).value)).toBe(eventTimestamp));
    expect(view.onMetric).toHaveBeenLastCalledWith("humidity");
    expect(view.onFloor).toHaveBeenLastCalledWith(eventSensor.floorId);
    expect(view.onSensorSelect).toHaveBeenLastCalledWith(eventSensor.id);
    expect(within(screen.getByLabelText("Auto-tagged events")).getByRole("button", { name: /Humidity fell 14 percentage points in Bathroom/ }).getAttribute("aria-current")).toBe("time");
  });

  it("cancels obsolete dashboard history loads when the range changes and on unmount", async () => {
    const view = renderDashboard(createDemoState());
    await waitFor(() => expect(view.onLoadSeries).toHaveBeenCalledWith(
      view.sensor.id,
      "temperature",
      "24h",
      true,
      expect.any(AbortSignal),
    ));
    const initialSignal = view.onLoadSeries.mock.calls.find(([, metric, range]) => (
      metric === "temperature" && range === "24h"
    ))?.[4] as AbortSignal;
    expect(initialSignal.aborted).toBe(false);

    fireEvent.click(screen.getByText("Explore this home", { selector: "strong" }));
    fireEvent.click(screen.getByText("Open analysis tools"));
    const comparisonRange = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(".comparison-range");
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.click(within(comparisonRange).getByRole("button", { name: "7 days" }));

    await waitFor(() => expect(view.onLoadSeries).toHaveBeenCalledWith(
      view.sensor.id,
      "temperature",
      "7d",
      true,
      expect.any(AbortSignal),
    ));
    expect(initialSignal.aborted).toBe(true);
    const replacementSignal = view.onLoadSeries.mock.calls.find(([, metric, range]) => (
      metric === "temperature" && range === "7d"
    ))?.[4] as AbortSignal;
    expect(replacementSignal.aborted).toBe(false);

    view.unmount();
    expect(replacementSignal.aborted).toBe(true);
  });

  it("starts first play at the beginning and advances at the selected minutes-per-second rate", () => {
    vi.useFakeTimers();
    const view = renderDashboard(createDemoState());
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open history and replay" }));
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
      openViewOptions();
      expect(screen.queryByRole("button", { name: "Edit layout" })).toBeNull();
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
      fireEvent.click(screen.getByRole("button", { name: "Open history and replay" }));
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
