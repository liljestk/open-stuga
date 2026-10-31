import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { House, HouseWeather, UnitSystem } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider, type TranslationKey } from "../i18n";
import { en } from "../locales/catalogs/en";
import { fiOverrides } from "../locales/catalogs/fi-overrides";
import { fiSupplement } from "../locales/catalogs/fi-supplement";
import { svOverrides } from "../locales/catalogs/sv";
import { definitionFor } from "../measurements";
import { createOutdoorBoundaryContext } from "../outdoor/context";
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
    ...(response.observationStation
      ? { station: { name: response.observationStation.name, distanceKm: response.observationStation.distanceKm } }
      : {}),
  };
}

function sceneView(house: House, outdoor: OutdoorVisualizationState) {
  const state = createDemoState();
  const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id);
  const definition = definitionFor(state.measurementDefinitions, "temperature");
  const samples = Object.fromEntries(sensors.map((sensor) => [sensor.id, state.latestMeasurements[sensor.id]!.temperature!]));
  return render(
    <I18nProvider>
      <BuildingScene
        house={house} sensors={sensors} samples={samples} observations={[]} definition={definition} units="metric"
        activeFloorId={house.floors[0]!.id} selectedSensorId={sensors[0]!.id} outdoor={outdoor}
        onFloorSelect={vi.fn()} onSensorSelect={vi.fn()}
      />
    </I18nProvider>,
  );
}

function floorView(
  house: House,
  outdoor: OutdoorVisualizationState,
  units: UnitSystem = "metric",
  editing = false,
  display: { mapAnimationsEnabled?: boolean; outdoorExtrasVisible?: boolean } = {},
) {
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
        outdoor={outdoor} {...display} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
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

  it("shows outdoor conditions and highlights the windward edge without drawing over the plan", () => {
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
    const shell = view.container.querySelector<SVGGElement>(".outdoor-shell");
    const windwardEdge = shell?.querySelector<SVGPathElement>(".outdoor-shell-windward-edge");
    expect(shell?.getAttribute("aria-label")).toMatch(/Outdoor shell.*Temperature 3 °C.*Relative humidity 82%.*Wind speed 4 m\/s.*Windward edge left/i);
    expect(windwardEdge?.dataset.windwardEdge).toBe("left");
    expect(windwardEdge?.getAttribute("d")).toMatch(/^M-.*L/);
    expect(windwardEdge?.dataset.windFromDegrees).toBe("270");
    expect(shell?.querySelector(".outdoor-shell-border")?.getAttribute("x")).toBe("-64");
    expect(shell?.querySelector(".outdoor-temperature-chip")?.textContent).toContain("3 °C");
    expect(shell?.querySelector(".outdoor-humidity-chip")?.textContent).toContain("82%");
    expect(shell?.querySelector(".outdoor-temperature-chip rect")?.getAttribute("width")).toBe("164");
    expect(shell?.querySelector(".outdoor-temperature-chip rect")?.getAttribute("height")).toBe("54");
    expect(view.container.querySelectorAll(".outdoor-edge-labels text")).toHaveLength(4);
    expect(Number(view.container.querySelector('[data-plan-edge="top"]')?.getAttribute("y"))).toBeLessThan(0);
    expect(Number(view.container.querySelector('[data-plan-edge="right"]')?.getAttribute("x"))).toBeGreaterThan(1000);
    expect(view.container.querySelector(".floor-plan")?.getAttribute("viewBox")).toMatch(/^-\d+ -\d+ /);
    expect(view.container.querySelector(".floor-outdoor-wind")).toBeNull();
    const mapLayout = view.container.querySelector(".floor-plan-layout");
    const weatherCard = mapLayout?.querySelector(".outdoor-context-card");
    const planStage = mapLayout?.querySelector(".plan-stage");
    expect(weatherCard?.parentElement).toBe(mapLayout);
    expect(planStage?.parentElement).toBe(mapLayout);
    expect(weatherCard?.nextElementSibling).toBe(planStage);
  });

  it("animates observed exterior wind while keeping the border and details independently controllable", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const animated = floorView(house, outdoorState(house, weather(house, 225)));

    expect(animated.container.querySelector(".outdoor-wind-contact-dot")).not.toBeNull();
    expect(animated.container.querySelectorAll(".outdoor-wind-streak")).toHaveLength(10);
    expect(animated.container.querySelector(".outdoor-wind-label")?.textContent).toMatch(/Wind from SW 225/);
    animated.unmount();

    const still = floorView(house, outdoorState(house, weather(house, 225)), "metric", false, {
      mapAnimationsEnabled: false,
      outdoorExtrasVisible: true,
    });
    expect(still.container.querySelector(".outdoor-wind-streak")).toBeNull();
    expect(still.container.querySelector(".outdoor-shell-windward-edge")).not.toBeNull();
    expect(still.container.querySelector(".outdoor-wind-contact-dot")).not.toBeNull();
    expect(still.container.querySelector(".outdoor-wind-label")).not.toBeNull();
    still.unmount();

    const minimal = floorView(house, outdoorState(house, weather(house, 225)), "metric", false, {
      mapAnimationsEnabled: false,
      outdoorExtrasVisible: false,
    });
    expect(minimal.container.querySelector(".outdoor-wind-label")).toBeNull();
    expect(minimal.container.querySelector(".outdoor-temperature-chip")).toBeNull();
    expect(minimal.container.querySelector(".outdoor-edge-labels")).toBeNull();
    expect(minimal.container.querySelector(".outdoor-shell-windward-edge")).not.toBeNull();
    expect(minimal.container.querySelector(".outdoor-wind-contact-dot")).not.toBeNull();
  });

  it("does not animate stale or calm wind observations", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const staleWeather = { ...weather(house, 225), stale: true };
    const stale = floorView(house, outdoorState(house, staleWeather));
    expect(stale.container.querySelector(".outdoor-wind-streak")).toBeNull();
    expect(stale.container.querySelector(".outdoor-shell-windward-edge")).not.toBeNull();
    stale.unmount();

    const windyWeather = weather(house, 225);
    const calmWeather = { ...windyWeather, current: { ...windyWeather.current!, windSpeedMps: .1 } };
    const calm = floorView(house, outdoorState(house, calmWeather));
    expect(calm.container.querySelector(".outdoor-wind-streak")).toBeNull();
    expect(calm.container.querySelector(".outdoor-wind-contact-dot")).not.toBeNull();
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

  it("marks the top shell edge for the oblique 331-degree case without an arrow", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const view = floorView(house, outdoorState(house, weather(house, 331)));
    const indicator = view.container.querySelector<SVGPathElement>(".outdoor-shell-windward-edge")!;

    expect(indicator.dataset.windwardEdge).toBe("top");
    expect(indicator.getAttribute("d")).toMatch(/^M.*L/);
    expect(indicator.dataset.planWindFromDegrees).toBe("331");
    expect(view.container.querySelector(".floor-outdoor-wind")).toBeNull();
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
    expect(screen.getByText("4 m/s · W · 270°")).not.toBeNull();
    expect(localStorage.getItem("climate-twin-outdoor-panel")).toBe("collapsed");
    expect(first.container.querySelector(".outdoor-shell-windward-edge")).not.toBeNull();
    // The layout styles place this chip beside the plan's zoom controls; both must sit in the same plan layout.
    const plan = first.container.querySelector(".floor-plan-layout")!;
    expect(plan.querySelector(":scope > .outdoor-context-card.collapsed")).not.toBeNull();
    expect(plan.querySelector(".plan-zoom-controls")?.contains(screen.getByRole("button", { name: "Zoom in" }))).toBe(true);

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
    expect(screen.getByText(/Set home orientation.*windward plan edge/i)).not.toBeNull();
    expect(first.container.querySelector(".outdoor-shell-windward-edge")).toBeNull();
    expect(first.container.querySelectorAll(".outdoor-edge-labels text")).toHaveLength(0);
    first.unmount();

    const oriented = { ...house, orientationDegrees: 0 };
    const second = floorView(oriented, outdoorState(oriented, weather(oriented, null)));
    expect(screen.getByText("4 m/s")).not.toBeNull();
    expect(screen.getByText(/Wind direction is unavailable/)).not.toBeNull();
    expect(second.container.querySelector(".outdoor-shell-windward-edge")).toBeNull();
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

  it("shows recorded outdoor values and their windward edge during replay", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const outdoor = { ...outdoorState(house), replayActive: true };
    const view = floorView(house, outdoor);
    expect(screen.getByText("Outside then")).not.toBeNull();
    expect(screen.getAllByText("3 °C")).toHaveLength(2);
    expect(view.container.querySelector(".outdoor-shell-windward-edge")).not.toBeNull();
  });

  it("projects the same windward boundary into the rotatable 3D world", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const state = createDemoState();
    const house: House = {
      ...state.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const view = sceneView(house, outdoorState(house));
    const shell = view.container.querySelector<SVGGElement>(".building-outdoor-shell")!;
    const chips = view.container.querySelector<SVGGElement>(".building-outdoor-shell-labels")!;
    const windwardEdge = shell.querySelector<SVGLineElement>(".building-outdoor-windward-edge")!;
    expect(shell.getAttribute("aria-label")).toMatch(/Outdoor shell.*Temperature 3 °C.*Relative humidity 82%.*Wind speed 4 m\/s.*Windward edge left/i);
    expect(chips.querySelector(".building-temperature-chip")?.textContent).toContain("3 °C");
    expect(chips.querySelector(".building-humidity-chip")?.textContent).toContain("82%");
    expect(chips.querySelector(".building-temperature-chip rect")?.getAttribute("width")).toBe("148");
    expect(chips.querySelector(".building-temperature-chip rect")?.getAttribute("height")).toBe("52");
    expect(shell.querySelectorAll(".building-outdoor-shell-edge")).toHaveLength(4);
    expect(windwardEdge.dataset.windwardEdge).toBe("left");
    const mapLayout = view.container.querySelector(".building-map-layout");
    const weatherCard = mapLayout?.querySelector(".outdoor-context-card");
    const viewport = mapLayout?.querySelector(".building-viewport");
    expect(weatherCard?.parentElement).toBe(mapLayout);
    expect(viewport?.parentElement).toBe(mapLayout);
    expect(weatherCard?.nextElementSibling).toBe(viewport);
    const shellBefore = shell.querySelector(".building-outdoor-shell-top")!.getAttribute("points");
    const before = [windwardEdge.getAttribute("x1"), windwardEdge.getAttribute("y1"), windwardEdge.getAttribute("x2"), windwardEdge.getAttribute("y2")];
    fireEvent.click(screen.getByRole("button", { name: "Rotate view right" }));
    const rotatedEdge = view.container.querySelector<SVGLineElement>(".building-outdoor-windward-edge")!;
    const after = [rotatedEdge.getAttribute("x1"), rotatedEdge.getAttribute("y1"), rotatedEdge.getAttribute("x2"), rotatedEdge.getAttribute("y2")];
    const shellAfter = view.container.querySelector(".building-outdoor-shell-top")!.getAttribute("points");
    expect(after).not.toBe(before);
    expect(shellAfter).not.toBe(shellBefore);
    expect(view.container.querySelector(".building-outdoor-wind")).toBeNull();
  });

  it("maps oblique wind to the correct highlighted shell edge", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0,
    };
    const response = weather(house, 60);
    const view = floorView(house, outdoorState(house, response));
    const indicator = view.container.querySelector<SVGPathElement>(".outdoor-shell-windward-edge")!;
    expect(indicator.dataset.windwardEdge).toBe("right");
    expect(indicator.getAttribute("d")).toMatch(/^M.*L/);
    expect(indicator.dataset.planWindFromDegrees).toBe("60");
    expect(view.container.querySelector(".floor-outdoor-wind")).toBeNull();
  });

  it("draws a 250-degree wind bearing independently of the west 280-degree facade label", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = {
      ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 10,
    };
    const view = floorView(house, outdoorState(house, weather(house, 250)));
    const indicator = view.container.querySelector<SVGPathElement>(".outdoor-shell-windward-edge")!;

    expect(indicator.dataset.windFromDegrees).toBe("250");
    expect(indicator.dataset.planWindFromDegrees).toBe("240");
    expect(indicator.dataset.windwardEdge).toBe("left");
    expect(view.container.querySelector('[data-plan-edge="left"]')?.textContent).toContain("280°");
    expect(indicator.getAttribute("d")).toMatch(/^M.*L/);
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

  it("paints the 3D shell's chips after the building, side by side", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = { ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0 };
    const view = sceneView(house, outdoorState(house));
    const labels = view.container.querySelector<SVGGElement>(".building-outdoor-shell-labels")!;

    // SVG paints in document order, so a building layer after the chips would draw over them.
    for (const layer of [".building-floors", ".building-roofs", ".building-sensors", ".building-heat-pumps"]) {
      expect(view.container.querySelector(layer)!.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING, layer).toBeTruthy();
    }
    expect(view.container.querySelector(".building-outdoor-shell .outdoor-shell-chip")).toBeNull();
    expect(labels.getAttribute("aria-hidden")).toBe("true");
    const chips = [...labels.querySelectorAll<SVGGElement>(".outdoor-shell-chip")].map((chip) => ({
      x: Number(/translate\(([-\d.]+)/u.exec(chip.getAttribute("transform") ?? "")?.[1] ?? 0),
      width: Number(chip.querySelector("rect")!.getAttribute("width")),
    }));
    expect(chips).toHaveLength(3);
    chips.slice(1).forEach((chip, index) => expect(chip.x).toBeGreaterThan(chips[index]!.x + chips[index]!.width));
  });

  it("names no weather provider on the shell chips of an Open-Meteo home", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const demo = createDemoState();
    const house: House = { ...demo.houses[0]!, location: { latitude: 60.17, longitude: 24.94 }, orientationDegrees: 0 };
    const openMeteo: HouseWeather = {
      ...weather(house), provider: "open-meteo", attribution: "Weather data by Open-Meteo.com (CC BY 4.0)", observationStation: null,
    };
    const scene = sceneView(house, outdoorState(house, openMeteo));
    const labels = scene.container.querySelector(".building-outdoor-shell-labels")!;
    expect([...labels.querySelectorAll(".outdoor-shell-chip-label")].map((label) => label.textContent))
      .toEqual(["Outdoor shell", "Outdoor temperature", "Outdoor humidity"]);
    expect(scene.container.querySelector(".building-outdoor-shell")!.getAttribute("aria-label")).not.toMatch(/FMI/);
    scene.unmount();

    const plan = floorView(house, outdoorState(house, openMeteo));
    const shell = plan.container.querySelector(".outdoor-shell")!;
    expect(`${shell.getAttribute("aria-label")} ${shell.textContent}`).not.toMatch(/FMI/);
    expect(shell.querySelector(".outdoor-temperature-chip")?.textContent).toContain("Outdoor temperature");
  });

  it("keeps the shell chip labels provider-neutral in every locale", () => {
    const catalogs: Record<string, Partial<Record<TranslationKey, string>>> = { en, fi: { ...fiOverrides, ...fiSupplement }, sv: svOverrides };
    const keys = ["outdoor.shellLabel", "outdoor.shellTemperature", "outdoor.shellHumidity", "outdoor.shellWind"] as const;
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const key of keys) expect(catalog[key], `${locale}.${key}`).not.toMatch(/FMI|Open-Meteo/i);
    }
  });
});
