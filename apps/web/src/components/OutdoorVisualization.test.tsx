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

function floorView(house: House, outdoor: OutdoorVisualizationState, units: UnitSystem = "metric") {
  const state = createDemoState();
  const floor = house.floors[0]!;
  const sensors = state.sensors.filter((sensor) => sensor.floorId === floor.id);
  const definition = definitionFor(state.measurementDefinitions, "temperature");
  const samples = Object.fromEntries(sensors.map((sensor) => [sensor.id, state.latestMeasurements[sensor.id]!.temperature!]));
  return render(
    <I18nProvider>
      <FloorPlan
        floor={floor} sensors={sensors} samples={samples} observations={[]} definition={definition} units={units}
        viewMode="plan" selectedSensorId={sensors[0]!.id} editing={false} observationPlacement={false}
        outdoor={outdoor} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("outdoor boundary visualization", () => {
  it("shows FMI temperature, humidity, wind, gust, provenance, compass labels, and an incoming west-edge arrow", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const view = floorView(house, outdoorState(house));

    expect(screen.getByRole("complementary", { name: /Outside now.*Temperature 3 °C.*Relative humidity 82%/ })).not.toBeNull();
    expect(screen.getByText("3 °C")).not.toBeNull();
    expect(screen.getByText("82%")).not.toBeNull();
    expect(screen.getByText("4 m/s")).not.toBeNull();
    expect(screen.getByText("Gust 7 m/s")).not.toBeNull();
    expect(screen.getByText(/Finnish Meteorological Institute/)).not.toBeNull();
    expect(screen.getByText(/Helsinki Kaisaniemi.*0.7 km/)).not.toBeNull();
    const arrow = view.container.querySelector<SVGGElement>(".floor-outdoor-wind");
    expect(arrow?.dataset.windwardEdge).toBe("left");
    expect(arrow?.getAttribute("aria-label")).toMatch(/Outdoor wind from W.*left edge.*not simulated indoor airflow/i);
    expect(view.container.querySelectorAll(".outdoor-edge-labels text")).toHaveLength(4);
    expect(view.container.querySelector(".flow-layer .outdoor-wind-path")).toBeNull();
  });

  it("keeps values visible but suppresses wall-relative geometry when orientation or wind direction is unknown", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = { ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 } };
    const first = floorView(house, outdoorState(house));
    expect(screen.getByText("3 °C")).not.toBeNull();
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
    expect(screen.getByText("37.4 °F")).not.toBeNull();
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
    expect(arrow.dataset.windwardEdge).toBe("left");
    expect(Number(arrow.dataset.sourceX)).toBeLessThan(Number(arrow.dataset.targetX));
    const before = arrow.querySelector("path")!.getAttribute("d");
    fireEvent.click(screen.getByRole("button", { name: "Rotate view right" }));
    const after = view.container.querySelector(".building-outdoor-wind path")!.getAttribute("d");
    expect(after).not.toBe(before);
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
