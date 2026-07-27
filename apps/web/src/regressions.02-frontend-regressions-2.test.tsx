import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import { describe, expect, it, vi } from "vitest";

import { useState, type ReactNode } from "react";

import type { Floor, MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";

import { globalStyles as styles } from "./test/styleSources";

import i18nSource from "./i18n.tsx?raw";

import { AppShell } from "./components/AppShell";

import { defaultPlanElementWidth, FloorPlan, floorGridSize, snapPointToGrid } from "./components/FloorPlan";

import { TrendChart } from "./components/TrendChart";

import { createDemoState, type ClimateState } from "./domain";

import { I18nProvider } from "./i18n";

import { definitionFor } from "./measurements";

import { AlertsPage } from "./pages/AlertsPage";

import { TwinDashboard } from "./pages/TwinDashboard";

import { ControlledFloorPlan, contrastRatio, declarationsFor, openFloorAddTools, openFloorEditorOptions, resolveVariable, samplesFor, withI18n } from "./regressionsTestSupport";

describe("frontend regressions", () => {
  it("places wall-aligned openings and grid-aligned fireplace and vent symbols", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const floor: Floor = {
      id: "symbols", name: "Symbols", type: "ground", width: 1000, height: 640, elevation: 0,
      walls: [{ id: "center-wall", from: { x: 0, y: 320 }, to: { x: 1000, y: 320 } }],
      rooms: [], planElements: [],
    };
    const onChange = vi.fn();
    render(withI18n(<ControlledFloorPlan initialFloor={floor} definition={definition} onChange={onChange} />));

    await openFloorAddTools(user);
    const elementPicker = screen.getByRole("combobox", { name: "Element" });
    expect(within(elementPicker).getByRole("option", { name: "Door" })).not.toBeNull();
    expect(within(elementPicker).getByRole("option", { name: "Window" })).not.toBeNull();
    expect(within(elementPicker).getByRole("option", { name: "Fireplace" })).not.toBeNull();
    expect(within(elementPicker).getByRole("option", { name: "Vent" })).not.toBeNull();
    await openFloorEditorOptions(user);
    expect(screen.getByText("Add", { selector: "summary" }).closest("details")?.open).toBe(false);
    await user.selectOptions(screen.getByRole("combobox", { name: "Grid size" }), "coarse");

    await openFloorAddTools(user);
    expect(screen.getByText("Editor options", { selector: "summary" }).closest("details")?.open).toBe(false);
    await user.click(screen.getByRole("button", { name: "Place element" }));
    const map = screen.getByRole("group", { name: /Editing Symbols/i });
    map.focus();
    await user.keyboard("{Enter}");
    let changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements).toHaveLength(1);
    expect(changed.planElements![0]).toMatchObject({ kind: "door", wallId: "center-wall", position: { y: 320 }, rotationDegrees: 0 });
    expect(changed.planElements![0]!.width).toBe(defaultPlanElementWidth(floor, "door"));
    expect(changed.planElements![0]!.height).toBe(2.1);

    const widthInput = await screen.findByRole("spinbutton", { name: "Width" });
    expect(widthInput.getAttribute("min")).not.toBeNull();
    expect(widthInput.getAttribute("max")).not.toBeNull();
    fireEvent.change(widthInput, { target: { value: "80" } });
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements![0]!.width).toBe(80);

    const heightInput = await screen.findByRole("spinbutton", { name: "Height" });
    expect(heightInput.getAttribute("max")).toBe("2.8");
    fireEvent.change(heightInput, { target: { value: "2.3" } });
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements![0]!.height).toBe(2.3);

    await user.click(await screen.findByRole("button", { name: "Flip side" }));
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements![0]!.rotationDegrees).toBe(180);

    await user.click(screen.getByRole("button", { name: "Wall 1" }));
    await user.keyboard("{Delete}");
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.walls).toHaveLength(0);
    expect(changed.planElements).toHaveLength(0);

    const undo = screen.getByRole("button", { name: "Undo" });
    await waitFor(() => expect(document.activeElement).toBe(undo));
    expect(undo.getAttribute("aria-keyshortcuts")).toContain("Control+Z");
    await user.click(undo);
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.walls).toHaveLength(1);
    expect(changed.planElements).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Door 1, Closed" }));
    await openFloorEditorOptions(user);
    await user.click(screen.getByRole("button", { name: "Delete element" }));

    await openFloorAddTools(user);
    const fireplacePicker = screen.getByRole("combobox", { name: "Element" });
    await user.selectOptions(fireplacePicker, "fireplace");
    await user.click(screen.getByRole("button", { name: "Place element" }));
    map.focus();
    await user.keyboard("{Enter}");
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    const fireplace = changed.planElements!.at(-1)!;
    expect(fireplace.kind).toBe("fireplace");
    const gridSize = floorGridSize(floor);
    expect(fireplace.position.x / gridSize).toBeCloseTo(Math.round(fireplace.position.x / gridSize), 8);
    expect(fireplace.position.y / gridSize).toBeCloseTo(Math.round(fireplace.position.y / gridSize), 8);

    const fireplaceControl = screen.getByRole("button", { name: "Fireplace 1" });
    await waitFor(() => expect(document.activeElement).toBe(fireplaceControl));
    expect(fireplaceControl.getAttribute("aria-keyshortcuts")).toContain("Shift+R");
    expect((screen.getByRole("combobox", { name: "Rotation" }) as HTMLSelectElement).value).toBe("0");
    await user.click(screen.getByRole("button", { name: "Rotate right 90°" }));
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements!.at(-1)!.rotationDegrees).toBe(90);
    await waitFor(() => expect(fireplaceControl.getAttribute("transform")).toContain("rotate(90)"));
    await user.click(screen.getByRole("button", { name: "Rotate left 90°" }));
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements!.at(-1)!.rotationDegrees).toBe(0);
    fireplaceControl.focus();
    await user.keyboard("r");
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements!.at(-1)!.rotationDegrees).toBe(90);
    await user.keyboard("{Shift>}r{/Shift}");
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements!.at(-1)!.rotationDegrees).toBe(0);

    await openFloorAddTools(user);
    const ventPicker = screen.getByRole("combobox", { name: "Element" });
    await user.selectOptions(ventPicker, "vent");
    expect((ventPicker as HTMLSelectElement).value).toBe("vent");
    await user.click(screen.getByRole("button", { name: "Place element" }));
    map.focus();
    await user.keyboard("{Enter}");
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    const vent = changed.planElements!.at(-1)!;
    expect(vent).toMatchObject({ kind: "vent", rotationDegrees: 0 });
    const ventControl = screen.getByRole("button", { name: "Vent 2, Open" });
    await waitFor(() => expect(document.activeElement).toBe(ventControl));
    await user.click(screen.getByRole("button", { name: "Rotate right 90°" }));
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements!.at(-1)!.rotationDegrees).toBe(90);
    await waitFor(() => expect(ventControl.getAttribute("transform")).toContain("rotate(90)"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Rotation" }), "270");
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.planElements!.at(-1)!.rotationDegrees).toBe(270);
  });

  it("explains when a wall is too short for a door", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const floor: Floor = {
      id: "short-wall", name: "Short wall", width: 1000, height: 640, elevation: 0,
      walls: [{ id: "short", from: { x: 480, y: 320 }, to: { x: 520, y: 320 } }],
      rooms: [], planElements: [],
    };
    const onChange = vi.fn();
    render(withI18n(<ControlledFloorPlan initialFloor={floor} definition={definition} onChange={onChange} />));

    await openFloorAddTools(user);
    await user.click(screen.getByRole("button", { name: "Place element" }));
    const map = screen.getByRole("group", { name: /Editing Short wall/i });
    map.focus();
    await user.keyboard("{Enter}");

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/wall is too short.*reduce the width/i);
  });

  it("merges wall undo into the latest floor and supports Ctrl+Z", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const initialFloor: Floor = {
      id: "granular-undo", name: "Original name", width: 1000, height: 640, elevation: 0,
      walls: [{ id: "wall", from: { x: 0, y: 320 }, to: { x: 1000, y: 320 } }],
      rooms: [],
      planElements: [
        { id: "door", kind: "door", wallId: "wall", position: { x: 500, y: 320 }, rotationDegrees: 0, width: 62.5 },
        { id: "vent", kind: "vent", position: { x: 200, y: 200 }, rotationDegrees: 0, width: 40 },
      ],
    };
    const onChange = vi.fn();

    function ConcurrentFloorPlan() {
      const [floor, setFloor] = useState(initialFloor);
      return <>
        <button type="button" onClick={() => setFloor((current) => ({
          ...current,
          name: "Externally renamed",
          rooms: [...current.rooms, { id: "external-room", name: "External room", kind: "other", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }],
        }))}>External floor change</button>
        <FloorPlan
          floor={floor} sensors={[]} samples={{}} observations={[]} definition={definition} units="metric"
          viewMode="plan" selectedSensorId={null} editing observationPlacement={false}
          onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={(next) => { setFloor(next); onChange(next); }}
          onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
        />
      </>;
    }

    render(withI18n(<ConcurrentFloorPlan />));
    const wall = screen.getByRole("button", { name: "Wall 1" });
    wall.focus();
    await user.keyboard("{Delete}");
    let changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.walls).toHaveLength(0);
    expect(changed.planElements?.map((element) => element.id)).toEqual(["vent"]);

    await user.click(screen.getByRole("button", { name: "External floor change" }));
    await user.keyboard("{Control>}z{/Control}");
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.name).toBe("Externally renamed");
    expect(changed.rooms.map((room) => room.id)).toContain("external-room");
    expect(changed.walls.map((item) => item.id)).toContain("wall");
    expect(changed.planElements?.map((element) => element.id)).toEqual(["door", "vent"]);
  });

  it("snaps keyboard sensor movement to the same visible grid", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const sensor = { ...state.sensors.find((item) => item.floorId === floor.id)!, x: 242, y: 213 };
    const onSensorMove = vi.fn();
    render(withI18n(
      <FloorPlan
        floor={floor} sensors={[sensor]} samples={{}} observations={[]} definition={definition} units="metric"
        viewMode="plan" selectedSensorId={sensor.id} editing observationPlacement={false}
        onSensorSelect={vi.fn()} onSensorMove={onSensorMove} onFloorChange={vi.fn()}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />,
    ));

    const marker = screen.getByRole("button", { name: new RegExp(`^${sensor.name},`) });
    marker.focus();
    await user.keyboard("{ArrowRight}");
    const gridSize = floorGridSize(floor);
    const expected = snapPointToGrid({ x: sensor.x + gridSize, y: sensor.y }, floor, gridSize);
    expect(onSensorMove).toHaveBeenCalledWith(sensor.id, expected);
  });

  it("rejects unsafe or oversized floor-plan uploads before reading them", () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const onFloorChange = vi.fn();
    render(withI18n(
      <FloorPlan
        floor={floor} sensors={[]} samples={{}} observations={[]} definition={definition} units="metric"
        viewMode="plan" selectedSensorId={null} editing observationPlacement={false}
        onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={onFloorChange}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />,
    ));
    fireEvent.click(screen.getByText("Editor options", { selector: "summary" }));
    const input = screen.getByLabelText("Upload floor plan");

    fireEvent.change(input, { target: { files: [new File(["<svg/>"] , "plan.svg", { type: "image/svg+xml" })] } });
    expect(screen.getByRole("alert").textContent).toMatch(/valid PNG, JPG or WEBP/i);

    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "plan.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(screen.getByRole("alert").textContent).toMatch(/10 MiB or smaller/i);
    expect(onFloorChange).not.toHaveBeenCalled();
  });

  it("summarizes the trend without point tab stops and discloses exact data", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const sensor = state.sensors[0]!;
    const floor = state.houses[0]!.floors.find((item) => item.id === sensor.floorId)!;
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const view = render(withI18n(
      <>
        <TrendChart
          sensor={sensor} history={state.measurementHistory[sensor.id]?.temperature ?? []}
          forecast={state.measurementForecasts[sensor.id]?.temperature ?? []}
          definition={definition} units="metric" range="24h" onRange={vi.fn()}
        />
        <FloorPlan
          floor={floor} sensors={[sensor]} samples={samplesFor(state, definition, [sensor])} observations={[]}
          definition={definition} units="metric" viewMode="plan" selectedSensorId={sensor.id} editing={false}
          observationPlacement={false} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
          onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
        />
      </>,
    ));

    const chart = screen.getByRole("group", { name: /Temperature history and forecast for/i });
    expect(chart.tagName.toLowerCase()).toBe("svg");
    expect(screen.queryByRole("img", { name: /Temperature history and forecast for/i })).toBeNull();
    expect(view.container.querySelectorAll(".chart-points [tabindex]")).toHaveLength(0);
    expect(screen.queryByRole("table")).toBeNull();
    await user.click(screen.getByText("Show exact data", { selector: "summary" }));
    expect(screen.getByRole("table", { name: /Temperature history and forecast for/i })).not.toBeNull();
    expect(view.container.querySelector(".floor-plan-wrap [aria-live]")).toBeNull();
  });

  it("keeps CO2 in ppm under imperial display and localizes registry labels in the selector and inspector", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const sensor = state.sensors.find((item) => item.houseId === house.id && item.floorId === floor.id)!;
    const co2Sample = state.latestMeasurements[sensor.id]!.co2!;
    const dashboard = (units: "metric" | "imperial") => (
      <TwinDashboard
        state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
        metric="co2" units={units} viewMode="plan" selectedSensorId={sensor.id}
        saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
        onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onSensorUpdate={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
        onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
        onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
      />
    );

    localStorage.setItem("climate-twin-locale", "en");
    const view = render(withI18n(dashboard("metric")));
    await user.click(screen.getByRole("button", { name: "Open live home view" }));
    const metricPicker = await screen.findByRole("combobox", { name: "Metric" });
    expect(within(metricPicker).getByRole("option", { name: /Carbon dioxide.*ppm/ })).not.toBeNull();
    let measurements = await screen.findByRole("list", { name: "Available measurements" });
    let co2Item = within(measurements).getByText("Carbon dioxide").closest("[role=listitem]") as HTMLElement;
    expect(within(co2Item).getByText(`${co2Sample.value.toFixed(0)} ppm`)).not.toBeNull();

    view.rerender(withI18n(dashboard("imperial")));
    measurements = await screen.findByRole("list", { name: "Available measurements" });
    co2Item = within(measurements).getByText("Carbon dioxide").closest("[role=listitem]") as HTMLElement;
    expect(within(co2Item).getByText(`${co2Sample.value.toFixed(0)} ppm`)).not.toBeNull();
    expect(co2Item.textContent).not.toMatch(/[Â°%]/);
    view.unmount();

    localStorage.setItem("climate-twin-locale", "fi");
    render(withI18n(dashboard("imperial")));
    await user.click(screen.getByRole("button", { name: "Avaa kodin reaaliaikainen näkymä" }));
    const finnishPicker = await screen.findByRole("combobox", { name: "Mittari" });
    expect(within(finnishPicker).getByRole("option", { name: /Hiilidioksidi.*ppm/ })).not.toBeNull();
    const finnishMeasurements = await screen.findByRole("list", { name: "Saatavilla olevat mittaukset" });
    expect(within(finnishMeasurements).getByText("Hiilidioksidi")).not.toBeNull();
  });

  it("renders custom non-spatial measurements at sensor markers without a heat field or legend", () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.floorId === floor.id).slice(0, 2);
    const definition: MeasurementDefinition = {
      id: "voc_index", labels: { en: "VOC index", fi: "VOC-indeksi" }, unit: "index", precision: 0,
      validMin: 0, validMax: 500, displayMin: 0, displayMax: 500, interpolationDelta: 10,
      colorScale: "sequential", builtin: false, enabled: true,
      spatialInterpolation: false, forecastSupported: false,
    };
    const samples = Object.fromEntries(sensors.map((sensor, index) => [sensor.id, {
      sensorId: sensor.id, metric: definition.id, value: 80 + index * 40, canonicalUnit: definition.unit,
      timestamp: "2026-07-14T08:00:00.000Z", source: "mock" as const, quality: "good" as const,
    }])) as Record<string, MeasurementSample>;
    const view = render(withI18n(
      <FloorPlan
        floor={floor} sensors={sensors} samples={samples} observations={[]} definition={definition} units="imperial"
        viewMode="plan" selectedSensorId={sensors[0]!.id} editing={false} observationPlacement={false}
        referenceTimeMs={Date.parse("2026-07-14T08:00:00.000Z")}
        onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />,
    ));

    expect(view.container.querySelectorAll(".sensor-marker")).toHaveLength(sensors.length);
    expect(view.container.querySelectorAll(".heat-field rect")).toHaveLength(0);
    expect(view.container.querySelector(".heat-legend")).toBeNull();
    expect(screen.getByRole("group", { name: /VOC index map for/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /VOC index, 80 index/i })).not.toBeNull();
  });

  it("explains unsupported forecasts without rendering a predicted line or confidence band", () => {
    const state = createDemoState();
    const sensor = state.sensors[0]!;
    const definition: MeasurementDefinition = {
      id: "voc_index", labels: { en: "VOC index", fi: "VOC-indeksi" }, unit: "index", precision: 0,
      validMin: 0, validMax: 500, displayMin: 0, displayMax: 500, interpolationDelta: 10,
      colorScale: "sequential", builtin: false, enabled: true,
      spatialInterpolation: false, forecastSupported: false,
    };
    const timestamp = new Date().toISOString();
    const view = render(withI18n(
      <TrendChart
        sensor={sensor}
        history={[{ sensorId: sensor.id, metric: definition.id, value: 82, canonicalUnit: definition.unit, timestamp, source: "mock", quality: "good" }]}
        forecast={[{ sensorId: sensor.id, metric: definition.id, value: 95, low: 80, high: 110, timestamp }]}
        definition={definition} units="metric" range="24h" onRange={vi.fn()}
      />,
    ));

    expect(screen.getByText("Forecasts are not available for VOC index.")).not.toBeNull();
    expect(view.container.querySelector(".chart-line.predicted")).toBeNull();
    expect(view.container.querySelector(".confidence-area")).toBeNull();
    expect(view.container.querySelector(".chart-legend .predicted")).toBeNull();
  });

  it("loads durable airflow-driver history once per enabled house sensor when replay starts", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const houseSensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled);
    const onLoadSeries = vi.fn();
    render(withI18n(
      <TwinDashboard
        state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
        metric="temperature" units="metric" viewMode="plan" selectedSensorId={houseSensors[0]!.id}
        saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
        onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onSensorUpdate={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={onLoadSeries} onRunScenario={vi.fn()}
        onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
        onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
      />,
    ));

    await user.click(screen.getByRole("button", { name: "Open history and replay" }));
    await user.click(screen.getByRole("button", { name: "Play replay" }));
    await waitFor(() => {
      expect(new Set(onLoadSeries.mock.calls.map(([sensorId]) => sensorId))).toEqual(new Set(houseSensors.map((sensor) => sensor.id)));
    });
    const loadedPairs = new Set(onLoadSeries.mock.calls.map(([sensorId, loadedMetric]) => `${sensorId}:${loadedMetric}`));
    expect(loadedPairs.size).toBe(houseSensors.length * 3);
    for (const metric of ["temperature", "humidity", "co2"]) {
      expect(new Set(onLoadSeries.mock.calls.filter(([, loadedMetric]) => loadedMetric === metric).map(([sensorId]) => sensorId)))
        .toEqual(new Set(houseSensors.map((sensor) => sensor.id)));
    }
  });

  it.each(["warning", "critical"])("keeps dark-mode %s badge contrast at WCAG AA", (severity) => {
    const darkMedia = "@media (prefers-color-scheme: dark)";
    const baseEnd = styles.indexOf(darkMedia);
    const darkStart = styles.indexOf("{", baseEnd) + 1;
    const darkEnd = styles.lastIndexOf("}");
    const baseCss = styles.slice(0, baseEnd);
    const darkCss = styles.slice(darkStart, darkEnd);
    const variables = {
      ...declarationsFor(baseCss, ":root"),
      ...declarationsFor(darkCss, ":root"),
    };
    const badge = {
      ...declarationsFor(baseCss, `.status-badge.${severity}`),
      ...declarationsFor(darkCss, `.status-badge.${severity}`),
    };
    const foreground = resolveVariable(badge.color, variables);
    const background = resolveVariable(badge.background ?? badge["background-color"], variables);
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
