import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Floor, ManualObservation, MeasurementDefinition, MeasurementSample, Sensor, UnitSystem } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { TwinDashboard } from "../pages/TwinDashboard";
import { BuildingScene } from "./BuildingScene";

function renderScene(options: {
  floors?: Floor[];
  sensors?: Sensor[];
  samples?: Record<string, MeasurementSample>;
  observations?: ManualObservation[];
  definition?: MeasurementDefinition;
  units?: UnitSystem;
} = {}) {
  const state = createDemoState();
  const house = { ...state.houses[0]!, floors: options.floors ?? state.houses[0]!.floors };
  const sensors = options.sensors ?? state.sensors.filter((sensor) => sensor.houseId === house.id);
  const definition = options.definition ?? definitionFor(state.measurementDefinitions, "temperature");
  const samples = options.samples ?? Object.fromEntries(sensors.flatMap((sensor) => {
    const sample = state.latestMeasurements[sensor.id]?.[definition.id];
    return sample ? [[sensor.id, sample]] : [];
  }));
  const onFloorSelect = vi.fn();
  const onSensorSelect = vi.fn();
  const view = render(
    <I18nProvider>
      <BuildingScene
        house={house} sensors={sensors} samples={samples}
        observations={options.observations ?? state.observations} definition={definition} units={options.units ?? "metric"}
        activeFloorId={house.floors[0]!.id} selectedSensorId={sensors.find((sensor) => sensor.enabled)?.id ?? null}
        onFloorSelect={onFloorSelect} onSensorSelect={onSensorSelect}
      />
    </I18nProvider>,
  );
  return { ...view, state, house, sensors, onFloorSelect, onSensorSelect };
}

describe("BuildingScene", () => {
  it("renders every floor and enabled house sensor with meaningful 3D labels", () => {
    const state = createDemoState();
    const disabled = { ...state.sensors.at(-1)!, enabled: false };
    const sensors = [...state.sensors.slice(0, -1), disabled];
    const { container, house } = renderScene({ sensors });
    const floorControls = [...container.querySelectorAll<SVGGElement>(".building-floor[role=button]")];
    const sensorControls = [...container.querySelectorAll<SVGGElement>(".building-sensor[role=button]")];

    expect(floorControls).toHaveLength(house.floors.length);
    expect(sensorControls).toHaveLength(sensors.filter((sensor) => sensor.enabled).length);
    for (const floor of house.floors) {
      const control = floorControls.find((item) => item.getAttribute("aria-label")?.includes(floor.name));
      expect(control?.getAttribute("tabindex")).toBe("0");
    }
    for (const sensor of sensors.filter((item) => item.enabled)) {
      const floor = house.floors.find((item) => item.id === sensor.floorId)!;
      const control = sensorControls.find((item) => item.getAttribute("aria-label")?.includes(sensor.name));
      const label = control?.getAttribute("aria-label") ?? "";
      expect(control?.getAttribute("tabindex")).toBe("0");
      expect(label).toContain(floor.name);
      expect(label).toContain((sensor.z - floor.elevation).toFixed(1));
    }
    expect(sensorControls.some((item) => item.getAttribute("aria-label")?.includes(disabled.name))).toBe(false);
  });

  it("keeps empty floors structural and announces their configured elevation", () => {
    const state = createDemoState();
    const template = state.houses[0]!.floors[0]!;
    const lower: Floor = { ...template, id: "floor-lower-basement", name: "Lower basement", elevation: -3 };
    const basement: Floor = { ...template, id: "floor-basement", name: "Basement", elevation: -2.5 };
    const { container } = renderScene({ floors: [basement, lower], sensors: [], samples: {}, observations: [] });
    const basementControl = [...container.querySelectorAll<SVGGElement>(".building-floor")]
      .find((item) => item.getAttribute("aria-label")?.startsWith("Basement,"))!;

    expect(basementControl).not.toBeUndefined();
    expect(basementControl.getAttribute("aria-label")).toContain("-2.5");
    expect(basementControl.querySelector(".floor-surface")).not.toBeNull();
    expect(basementControl.querySelectorAll(".building-heat polygon")).toHaveLength(0);
  });

  it("preserves metre-scale vertical geometry for a large valid building", () => {
    const state = createDemoState();
    const floor: Floor = {
      ...state.houses[0]!.floors[0]!, id: "warehouse", name: "Tall warehouse",
      width: 120, height: 80, elevation: 0, walls: [], rooms: [],
    };
    const sensor: Sensor = {
      ...state.sensors[0]!, id: "sensor-roof", floorId: floor.id, name: "Roof sensor",
      x: 60, y: 40, z: 40,
    };
    const baseSample = state.latestMeasurements[state.sensors[0]!.id]!.temperature!;
    const sample: MeasurementSample = { ...baseSample, sensorId: sensor.id };
    const { container } = renderScene({ floors: [floor], sensors: [sensor], samples: { [sensor.id]: sample }, observations: [] });
    const tether = container.querySelector<SVGLineElement>(".building-sensor .sensor-tether");

    expect(Math.abs(Number(tether?.getAttribute("y2")))).toBeGreaterThan(200);
    expect(container.querySelector(".building-sensor")?.getAttribute("aria-label")).toContain("40.0 metres above the floor");
  });

  it("marks stale sensors as stale and avoids a fabricated heat legend", () => {
    const state = createDemoState();
    const samples = Object.fromEntries(state.sensors.map((sensor) => [sensor.id, {
      ...state.latestMeasurements[sensor.id]!.temperature!, quality: "stale" as const,
    }])) as Record<string, MeasurementSample>;
    const { container } = renderScene({ samples, observations: [] });
    const sensor = container.querySelector<SVGGElement>(".building-sensor");

    expect(container.querySelectorAll(".building-heat polygon")).toHaveLength(0);
    expect(container.querySelector(".building-legend")?.textContent).toContain("No data");
    expect(sensor?.classList.contains("stale")).toBe(true);
    expect(sensor?.getAttribute("aria-label")).toContain("No data");
    expect(sensor?.getAttribute("aria-label")).toContain("stale data");
  });

  it("activates floors and cross-floor sensors from the keyboard", () => {
    const { container, house, sensors, onFloorSelect, onSensorSelect } = renderScene();
    const upperFloor = [...house.floors].sort((a, b) => b.elevation - a.elevation)[0]!;
    const upperSensor = sensors.find((sensor) => sensor.floorId === upperFloor.id && sensor.enabled)!;
    const floorControl = [...container.querySelectorAll<SVGGElement>(".building-floor")]
      .find((item) => item.getAttribute("aria-label")?.includes(upperFloor.name))!;
    const sensorControl = [...container.querySelectorAll<SVGGElement>(".building-sensor")]
      .find((item) => item.getAttribute("aria-label")?.includes(upperSensor.name))!;

    floorControl.focus();
    fireEvent.keyDown(floorControl, { key: "Enter" });
    expect(onFloorSelect).toHaveBeenLastCalledWith(upperFloor.id);

    onFloorSelect.mockClear();
    sensorControl.focus();
    fireEvent.keyDown(sensorControl, { key: " " });
    expect(onFloorSelect).toHaveBeenCalledOnce();
    expect(onFloorSelect).toHaveBeenCalledWith(upperFloor.id);
    expect(onSensorSelect).toHaveBeenCalledOnce();
    expect(onSensorSelect).toHaveBeenCalledWith(upperSensor.id, upperFloor.id);
  });

  it("exposes observations from multiple floors with kind and severity", () => {
    const state = createDemoState();
    const upperFloor = state.houses[0]!.floors.find((floor) => floor.elevation > 0)!;
    const observations: ManualObservation[] = [
      state.observations[0]!,
      {
        ...state.observations[0]!, id: "observation-upper-leak", floorId: upperFloor.id,
        kind: "leak", severity: "critical", note: "Ceiling drip", x: 500, y: 250,
      },
    ];
    const { container } = renderScene({ observations });
    const labels = [...container.querySelectorAll<SVGGElement>(".building-observation[role=img]")]
      .map((item) => item.getAttribute("aria-label") ?? "");

    expect(labels).toHaveLength(2);
    expect(labels.some((label) => /Maintenance/i.test(label) && /Info/i.test(label) && /Ground floor/i.test(label))).toBe(true);
    expect(labels.some((label) => /Leak/i.test(label) && /Critical/i.test(label) && /Upper floor/i.test(label) && /Ceiling drip/i.test(label))).toBe(true);
  });

  it("labels vertical gradients only between adjacent elevation-sorted floors", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const upper = house.floors.find((floor) => floor.elevation > 0)!;
    const attic: Floor = { ...upper, id: "floor-attic", name: "Attic", elevation: 6 };
    const atticSensor: Sensor = {
      ...state.sensors.find((sensor) => sensor.floorId === upper.id)!, id: "sensor-attic", floorId: attic.id,
      name: "Attic sensor", room: "Attic", z: 7.4,
    };
    const sensors = [...state.sensors, atticSensor];
    const floorTemperatures = new Map([[house.floors[0]!.id, 19], [house.floors[1]!.id, 21], [attic.id, 23]]);
    const samples = Object.fromEntries(sensors.map((sensor) => [sensor.id, {
      ...state.latestMeasurements[state.sensors[0]!.id]!.temperature!, sensorId: sensor.id,
      value: floorTemperatures.get(sensor.floorId)!,
    }])) as Record<string, MeasurementSample>;
    const { container } = renderScene({ floors: [attic, ...house.floors], sensors, samples, observations: [] });
    const labels = [...container.querySelectorAll<SVGGElement>(".vertical-gradient[role=img]")]
      .map((item) => item.getAttribute("aria-label") ?? "");

    expect(labels).toHaveLength(2);
    expect(labels.every((label) => label.includes("2.0"))).toBe(true);
    expect(labels.some((label) => label.includes("Ground floor"))).toBe(true);
    expect(labels.some((label) => label.includes("Upper floor"))).toBe(true);
    expect(labels.some((label) => label.includes("4.0"))).toBe(false);
  });

  it("suppresses equal and stale vertical gradients", () => {
    const state = createDemoState();
    const equalSamples = Object.fromEntries(state.sensors.map((sensor) => [sensor.id, {
      ...state.latestMeasurements[sensor.id]!.temperature!, value: 21,
    }])) as Record<string, MeasurementSample>;
    const equal = renderScene({ samples: equalSamples, observations: [] });
    expect(equal.container.querySelectorAll(".vertical-gradient")).toHaveLength(0);
    equal.unmount();

    const staleUpperSamples = Object.fromEntries(state.sensors.map((sensor) => [sensor.id, {
      ...state.latestMeasurements[sensor.id]!.temperature!,
      quality: sensor.floorId === state.houses[0]!.floors[1]!.id ? "stale" as const : "good" as const,
    }])) as Record<string, MeasurementSample>;
    const stale = renderScene({ samples: staleUpperSamples, observations: [] });
    expect(stale.container.querySelectorAll(".vertical-gradient")).toHaveLength(0);
  });
});

describe("TwinDashboard whole-building replay", () => {
  it("reports unavailable summary values instead of fabricated zeroes", () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const floor = house.floors[0]!;
    const state = { ...demo, latestMeasurements: {}, measurementHistory: {} };
    render(
      <I18nProvider>
        <TwinDashboard
          state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
          metric="temperature" units="metric" viewMode="isometric" selectedSensorId={demo.sensors[0]!.id}
          saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
          onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onSensorUpdate={vi.fn()}
          onFloorChange={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
          onCreateObservation={vi.fn().mockResolvedValue(demo.observations[0]!)}
          onCreateStaticParameter={vi.fn().mockResolvedValue(demo.staticParameters[0]!)}
        />
      </I18nProvider>,
    );

    const region = screen.getByRole("region", { name: "Climate map" });
    expect(within(region).getAllByText("No data yet")).toHaveLength(2);
    expect(region.textContent).toContain(`0 of ${demo.sensors.length}`);
  });

  it("loads every enabled house sensor exactly once in isometric mode", async () => {
    const user = userEvent.setup();
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const floor = house.floors[0]!;
    const disabled = { ...demo.sensors.at(-1)!, enabled: false };
    const otherHouse: Sensor = {
      ...demo.sensors[0]!, id: "sensor-other-house", houseId: "house-other", name: "Other house sensor",
    };
    const state = { ...demo, sensors: [...demo.sensors.slice(0, -1), disabled, otherHouse] };
    const enabledHouseSensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled);
    const selectedSensor = enabledHouseSensors[0]!;
    const onLoadSeries = vi.fn();
    render(
      <I18nProvider>
        <TwinDashboard
          state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
          metric="temperature" units="metric" viewMode="isometric" selectedSensorId={selectedSensor.id}
          saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
          onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
          onSensorUpdate={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={onLoadSeries} onRunScenario={vi.fn()}
          onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
          onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Play replay" }));
    await waitFor(() => expect(onLoadSeries).toHaveBeenCalledTimes(enabledHouseSensors.length));
    expect(onLoadSeries.mock.calls.map(([sensorId]) => sensorId).sort()).toEqual(enabledHouseSensors.map((sensor) => sensor.id).sort());
    expect(onLoadSeries.mock.calls.filter(([sensorId]) => sensorId === selectedSensor.id)).toHaveLength(1);
    expect(onLoadSeries.mock.calls.every(([, metric, range, forecastSupported]) => (
      metric === "temperature" && range === "24h" && forecastSupported === true
    ))).toBe(true);
  });

  it("clamps an active replay when asynchronously loaded history changes its bounds", async () => {
    const user = userEvent.setup();
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const floor = house.floors[0]!;
    const selectedSensor = demo.sensors[0]!;
    const stateWithoutHistory = { ...demo, measurementHistory: {} };
    const commonProps = {
      house, floor, houseId: house.id, floorId: floor.id, metric: "temperature" as const,
      units: "metric" as const, viewMode: "isometric" as const, selectedSensorId: selectedSensor.id,
      saveState: "idle" as const, scenario: "normal" as const, onHouse: vi.fn(), onFloor: vi.fn(),
      onMetric: vi.fn(), onViewMode: vi.fn(), onSensorSelect: vi.fn(), onSensorMove: vi.fn(),
      onSensorUpdate: vi.fn(), onFloorChange: vi.fn(), onSaveLayout: vi.fn(), onLoadSeries: vi.fn(),
      onRunScenario: vi.fn(), onCreateObservation: vi.fn().mockResolvedValue(demo.observations[0]!),
      onCreateStaticParameter: vi.fn().mockResolvedValue(demo.staticParameters[0]!),
    };
    const view = render(<I18nProvider><TwinDashboard state={stateWithoutHistory} {...commonProps} /></I18nProvider>);
    await user.click(screen.getByRole("button", { name: "Play replay" }));

    const oldSample = {
      ...demo.latestMeasurements[selectedSensor.id]!.temperature!,
      timestamp: "2020-01-01T10:00:00.000Z",
    };
    const loadedState = {
      ...stateWithoutHistory,
      measurementHistory: { [selectedSensor.id]: { temperature: [oldSample] } },
    };
    view.rerender(<I18nProvider><TwinDashboard state={loadedState} {...commonProps} /></I18nProvider>);

    const slider = screen.getByRole("slider", { name: /Replay time/ }) as HTMLInputElement;
    await waitFor(() => expect(Number(slider.value)).toBeLessThanOrEqual(Number(slider.max)));
    expect(Number(slider.value)).toBeGreaterThanOrEqual(Number(slider.min));
  });

  it("applies an edit-only floor and relative mounting-height placement", async () => {
    const user = userEvent.setup();
    const demo = createDemoState();
    const originalHouse = demo.houses[0]!;
    const ground = originalHouse.floors[0]!;
    const targetFloor: Floor = { ...originalHouse.floors[1]!, width: 100, height: 80, elevation: 3 };
    const house = { ...originalHouse, floors: [ground, targetFloor] };
    const state = { ...demo, houses: [house] };
    const selectedSensor = state.sensors.find((sensor) => sensor.floorId === ground.id)!;
    const onSensorUpdate = vi.fn();
    const onFloor = vi.fn();
    render(
      <I18nProvider>
        <TwinDashboard
          state={state} house={house} floor={ground} houseId={house.id} floorId={ground.id}
          metric="temperature" units="metric" viewMode="plan" selectedSensorId={selectedSensor.id}
          saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={onFloor} onMetric={vi.fn()}
          onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onSensorUpdate={onSensorUpdate}
          onFloorChange={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
          onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
          onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
        />
      </I18nProvider>,
    );

    expect(screen.queryByLabelText("Sensor floor")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit layout" }));
    await user.selectOptions(screen.getByLabelText("Sensor floor"), targetFloor.id);
    const mountingHeight = screen.getByLabelText(/^Mounting height/) as HTMLInputElement;
    await user.clear(mountingHeight);
    await user.type(mountingHeight, "2.2");
    await user.click(screen.getByRole("button", { name: "Apply placement" }));

    expect(onSensorUpdate).toHaveBeenCalledOnce();
    const [sensorId, patch] = onSensorUpdate.mock.calls[0]!;
    expect(sensorId).toBe(selectedSensor.id);
    expect(patch).toMatchObject({ floorId: targetFloor.id, x: targetFloor.width, y: targetFloor.height });
    expect(patch.z).toBeCloseTo(targetFloor.elevation + 2.2, 5);
    expect(onFloor).toHaveBeenCalledWith(targetFloor.id);
  });
});
