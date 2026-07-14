import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { House, HouseWeather, UnitSystem } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { createOutdoorBoundaryContext } from "../outdoorContext";
import type { OutdoorVisualizationState } from "./OutdoorConditionsBadge";
import { FloorPlan } from "./FloorPlan";
import { BuildingScene } from "./BuildingScene";

function weather(house: House, windDirectionDegrees: number | null = 270): HouseWeather {
  return {
    houseId: house.id,
    location: house.location!,
    provider: "fmi",
    attribution: "Finnish Meteorological Institute open data · CC BY 4.0",
    fetchedAt: "2026-07-14T09:35:00.000Z",
    forecastIssuedAt: null,
    stale: false,
    current: {
      timestamp: "2026-07-14T09:30:00.000Z",
      temperatureC: 3,
      relativeHumidityPercent: 82,
      windSpeedMps: 4,
      windGustMps: 7,
      ...(windDirectionDegrees === null ? {} : { windDirectionDegrees }),
    },
    observationStation: { id: "101004", name: "Helsinki Kaisaniemi", latitude: 60.175, longitude: 24.944, distanceKm: .7 },
    forecast: [], warnings: [], unavailable: [],
  };
}

function outdoorState(house: House, response = weather(house)): OutdoorVisualizationState {
  return {
    context: createOutdoorBoundaryContext(house, response),
    loading: false,
    unavailable: false,
    refreshFailed: false,
    hasLocation: true,
    replayActive: false,
    timeZone: house.timezone,
    ...(house.orientationDegrees === undefined ? {} : { orientationDegrees: house.orientationDegrees }),
    attribution: response.attribution,
    station: { name: response.observationStation!.name, distanceKm: response.observationStation!.distanceKm },
  };
}

function floorView(house: House, outdoor: OutdoorVisualizationState, units: UnitSystem = "metric", editing = false) {
  const state = createDemoState();
  const floor = house.floors[0]!;
  const sensors = state.sensors.filter((sensor) => sensor.floorId === floor.id);
  const definition = definitionFor(state.measurementDefinitions, "temperature");
  const samples = Object.fromEntries(sensors.map((sensor) => [sensor.id, state.latestMeasurements[sensor.id]!.temperature!]));
  return render(
    <I18nProvider>
      <FloorPlan
        floor={floor} sensors={sensors} samples={samples} observations={[]} definition={definition} units={units}
        viewMode="plan" selectedSensorId={sensors[0]!.id} editing={editing} observationPlacement={false}
        outdoor={outdoor} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("outdoor boundary visualization", () => {
  it("uses a focused geometry view without outdoor or climate overlays while editing", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const view = floorView(house, outdoorState(house), "metric", true);

    expect(screen.queryByRole("complementary", { name: /Outside now/ })).toBeNull();
    expect(screen.queryByText("3 °C")).toBeNull();
    expect(view.container.querySelector(".floor-outdoor-wind")).toBeNull();
    expect(view.container.querySelector(".outdoor-edge-labels")).toBeNull();
    expect(view.container.querySelector(".heat-clouds")).toBeNull();
    expect(view.container.querySelector(".flow-layer")).toBeNull();
    expect(view.container.querySelector(".observations-layer")).toBeNull();
    expect(view.container.querySelector(".heat-legend")).toBeNull();
    expect(view.container.querySelector(".flow-legend")).toBeNull();
    expect(view.container.querySelector('[data-testid="floor-snap-grid"]')).not.toBeNull();
    expect(view.container.querySelectorAll(".wall-segment").length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll(".sensor-marker").length).toBeGreaterThan(0);
    expect(screen.getByRole("toolbar", { name: "Floor-plan editing tools" })).not.toBeNull();
    expect(screen.getByRole("group", { name: /Editing Ground floor/ })).not.toBeNull();
  });

  it("shows FMI temperature, humidity, wind, gust, provenance, compass labels, and an incoming west-edge arrow", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const view = floorView(house, outdoorState(house));

    expect(screen.getByRole("complementary", { name: /Outside now.*Temperature 3 °C.*Relative humidity 82%/ })).not.toBeNull();
    expect(screen.getAllByText("3 °C")).toHaveLength(2);
    expect(screen.getAllByText("82%")).toHaveLength(2);
    expect(screen.getByText("4 m/s")).not.toBeNull();
    expect(screen.getByText("Gust 7 m/s")).not.toBeNull();
    expect(screen.getByText(/Finnish Meteorological Institute/)).not.toBeNull();
    expect(screen.getByText(/Helsinki Kaisaniemi.*0.7 km/)).not.toBeNull();
    const arrow = view.container.querySelector<SVGGElement>(".floor-outdoor-wind");
    expect(arrow?.dataset.windwardEdge).toBe("left");
    expect(arrow?.getAttribute("aria-label")).toMatch(/Outdoor wind from W.*left edge.*not simulated indoor airflow/i);
    const shell = view.container.querySelector<SVGGElement>(".outdoor-shell");
    expect(shell?.getAttribute("aria-label")).toMatch(/FMI outdoor shell.*Temperature 3 °C.*Relative humidity 82%.*Wind speed 4 m\/s/i);
    expect(shell?.querySelector(".outdoor-shell-border")?.getAttribute("x")).toBe("-64");
    expect(shell?.querySelector(".outdoor-temperature-chip")?.textContent).toContain("3 °C");
    expect(shell?.querySelector(".outdoor-humidity-chip")?.textContent).toContain("82%");
    expect(shell?.querySelector(".outdoor-temperature-chip rect")?.getAttribute("width")).toBe("164");
    expect(shell?.querySelector(".outdoor-temperature-chip rect")?.getAttribute("height")).toBe("54");
    expect(arrow?.querySelector(".outdoor-wind-label")?.textContent).toMatch(/FMI wind.*4 m\/s.*W 270°/i);
    expect(view.container.querySelectorAll(".outdoor-edge-labels text")).toHaveLength(4);
    expect(Number(view.container.querySelector('[data-plan-edge="top"]')?.getAttribute("y"))).toBeLessThan(0);
    expect(Number(view.container.querySelector('[data-plan-edge="right"]')?.getAttribute("x"))).toBeGreaterThan(1000);
    expect(Number(arrow?.querySelector("circle")?.getAttribute("cx"))).toBeLessThan(0);
    expect(view.container.querySelector(".floor-plan")?.getAttribute("viewBox")).toMatch(/^-\d+ -\d+ /);
    expect(view.container.querySelector(".flow-layer .outdoor-wind-path")).toBeNull();
  });

  it("applies the shared indoor comparison colors to the outdoor shell and condition values", () => {
    localStorage.setItem("climate-twin-locale", "en");
    localStorage.setItem("climate-twin-outdoor-panel", "expanded");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const coloredOutdoor: OutdoorVisualizationState = {
      ...outdoorState(house),
      conditionColors: { temperature: "rgb(33 102 172)", humidity: "rgb(18 61 117)" },
    };
    const view = floorView(house, coloredOutdoor);
    const shell = view.container.querySelector<SVGGElement>(".outdoor-shell")!;
    const temperatureChip = shell.querySelector<SVGGElement>(".outdoor-temperature-chip")!;
    const humidityChip = shell.querySelector<SVGGElement>(".outdoor-humidity-chip")!;
    const temperatureBadge = view.container.querySelector<HTMLElement>(".outdoor-temperature-condition")!;
    const humidityBadge = view.container.querySelector<HTMLElement>(".outdoor-humidity-condition")!;

    expect(shell.classList.contains("compared")).toBe(true);
    expect(shell.style.getPropertyValue("--outdoor-active-color")).toBe("rgb(33 102 172)");
    expect(temperatureChip.style.getPropertyValue("--outdoor-condition-color")).toBe("rgb(33 102 172)");
    expect(humidityChip.style.getPropertyValue("--outdoor-condition-color")).toBe("rgb(18 61 117)");
    expect(temperatureBadge.style.getPropertyValue("--outdoor-condition-color")).toBe("rgb(33 102 172)");
    expect(humidityBadge.style.getPropertyValue("--outdoor-condition-color")).toBe("rgb(18 61 117)");
  });

  it("collapses outdoor details to a persistent, recoverable chip", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const first = floorView(house, outdoorState(house));

    fireEvent.click(screen.getByRole("button", { name: "Hide Outside now details" }));
    expect(screen.getAllByText("3 °C")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Show Outside now details" }).getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("climate-twin-outdoor-panel")).toBe("collapsed");
    expect(first.container.querySelector(".floor-outdoor-wind")).not.toBeNull();

    first.unmount();
    floorView(house, outdoorState(house));
    expect(screen.getAllByText("3 °C")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show Outside now details" }));
    expect(screen.getAllByText("3 °C")).toHaveLength(2);
    expect(localStorage.getItem("climate-twin-outdoor-panel")).toBe("expanded");
  });

  it("keeps values visible but suppresses wall-relative geometry when orientation or wind direction is unknown", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = { ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 } };
    const first = floorView(house, outdoorState(house));
    expect(screen.getAllByText("3 °C")).toHaveLength(2);
    expect(screen.getByText(/Set house orientation.*windward plan edge/i)).not.toBeNull();
    expect(first.container.querySelector(".floor-outdoor-wind")).toBeNull();
    expect(first.container.querySelectorAll(".outdoor-edge-labels text")).toHaveLength(0);
    first.unmount();

    const oriented = { ...house, orientationDegrees: 0 };
    const second = floorView(oriented, outdoorState(oriented, weather(oriented, null)));
    expect(screen.getByText("4 m/s")).not.toBeNull();
    expect(screen.getByText(/Wind direction is unavailable/)).not.toBeNull();
    expect(second.container.querySelector(".floor-outdoor-wind")).toBeNull();
  });

  it("converts outdoor temperature, wind, gust, and station distance for imperial display", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    floorView(house, outdoorState(house), "imperial");
    expect(screen.getAllByText("37.4 °F")).toHaveLength(2);
    expect(screen.getByText("8.9 mph")).not.toBeNull();
    expect(screen.getByText("Gust 15.7 mph")).not.toBeNull();
    expect(screen.getByText(/Helsinki Kaisaniemi.*0.4 mi/)).not.toBeNull();
  });

  it("shows no live values or directional arrow during replay", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const outdoor = { ...outdoorState(house), replayActive: true };
    const view = floorView(house, outdoor);
    expect(screen.getByText(/Live outdoor context is hidden during historical replay/)).not.toBeNull();
    expect(screen.queryByText("3 °C")).toBeNull();
    expect(view.container.querySelector(".floor-outdoor-wind")).toBeNull();
  });

  it("projects the same windward boundary into the rotatable 3D world", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const state = createDemoState();
    const house: House = {
      ...state.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id);
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const samples = Object.fromEntries(sensors.map((sensor) => [sensor.id, state.latestMeasurements[sensor.id]!.temperature!]));
    const view = render(
      <I18nProvider>
        <BuildingScene
          house={house} sensors={sensors} samples={samples} observations={[]} definition={definition} units="metric"
          activeFloorId={house.floors[0]!.id} selectedSensorId={sensors[0]!.id} outdoor={outdoorState(house)}
          onFloorSelect={vi.fn()} onSensorSelect={vi.fn()}
        />
      </I18nProvider>,
    );
    const arrow = view.container.querySelector<SVGGElement>(".building-outdoor-wind")!;
    const shell = view.container.querySelector<SVGGElement>(".building-outdoor-shell")!;
    expect(shell.getAttribute("aria-label")).toMatch(/FMI outdoor shell.*Temperature 3 °C.*Relative humidity 82%.*Wind speed 4 m\/s/i);
    expect(shell.querySelector(".building-temperature-chip")?.textContent).toContain("3 °C");
    expect(shell.querySelector(".building-humidity-chip")?.textContent).toContain("82%");
    expect(shell.querySelector(".building-temperature-chip rect")?.getAttribute("width")).toBe("136");
    expect(shell.querySelector(".building-temperature-chip rect")?.getAttribute("height")).toBe("52");
    expect(shell.querySelectorAll(".building-outdoor-shell-edge")).toHaveLength(4);
    expect(arrow.dataset.windwardEdge).toBe("left");
    expect(Number(arrow.dataset.sourceX)).toBeLessThan(Number(arrow.dataset.targetX));
    expect(arrow.querySelector(".building-outdoor-wind-label")?.textContent).toMatch(/FMI wind.*4 m\/s.*W 270°/i);
    const shellBefore = shell.querySelector(".building-outdoor-shell-top")!.getAttribute("points");
    const before = arrow.querySelector("path")!.getAttribute("d");
    fireEvent.click(screen.getByRole("button", { name: "Rotate view right" }));
    const after = view.container.querySelector(".building-outdoor-wind path")!.getAttribute("d");
    const shellAfter = view.container.querySelector(".building-outdoor-shell-top")!.getAttribute("points");
    expect(after).not.toBe(before);
    expect(shellAfter).not.toBe(shellBefore);
    expect(view.container.querySelector(".building-volume-flows .outdoor-wind-path")).toBeNull();
  });

  it("keeps an oblique wind vector aligned on a rectangular plan", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const response = weather(house, 60);
    const view = floorView(house, outdoorState(house, response));
    const arrow = view.container.querySelector<SVGGElement>(".floor-outdoor-wind")!;
    const path = arrow.querySelector("path")!.getAttribute("d")!;
    const values = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const [sourceX, sourceY, targetX, targetY] = values;
    expect(arrow.dataset.windwardEdge).toBe("right");
    expect(sourceX).toBeGreaterThan(targetX!);
    expect(sourceY).toBeLessThan(targetY!);
    expect(Math.abs((targetX! - sourceX!) / (targetY! - sourceY!))).toBeCloseTo(Math.tan(Math.PI / 3), 5);
  });

  it("announces a retained observation when a refresh fails", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    floorView(house, { ...outdoorState(house), refreshFailed: true });
    expect(screen.getByText("Refresh failed; showing the last received observation.")).not.toBeNull();
  });
});
