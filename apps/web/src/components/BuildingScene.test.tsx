import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConfiguredOpeningState, Floor, ManualObservation, MeasurementDefinition, MeasurementSample, OpeningStateObservation, Sensor, UnitSystem } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { TwinDashboard } from "../pages/TwinDashboard";
import { api } from "../api";
import { BuildingScene } from "./BuildingScene";

function renderScene(options: {
  floors?: Floor[];
  sensors?: Sensor[];
  samples?: Record<string, MeasurementSample>;
  observations?: ManualObservation[];
  definition?: MeasurementDefinition;
  units?: UnitSystem;
  editing?: boolean;
  sensorMeasurements?: Record<string, Record<string, MeasurementSample>>;
  energyDevicesVisible?: boolean;
  referenceTimeMs?: number;
  openingStateObservations?: OpeningStateObservation[];
  pendingOpeningStateKeys?: ReadonlySet<string>;
  onOpeningStateChange?: (floorId: string, elementId: string, state: ConfiguredOpeningState) => void;
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
  const onFloorChange = vi.fn();
  const onOpeningStateChange = options.onOpeningStateChange ?? vi.fn();
  const view = render(
    <I18nProvider>
      <BuildingScene
        house={house} sensors={sensors} samples={samples}
        {...(options.sensorMeasurements ? { sensorMeasurements: options.sensorMeasurements } : {})}
        {...(options.energyDevicesVisible === undefined ? {} : { energyDevicesVisible: options.energyDevicesVisible })}
        observations={options.observations ?? state.observations} definition={definition} units={options.units ?? "metric"}
        activeFloorId={house.floors[0]!.id} selectedSensorId={sensors.find((sensor) => sensor.enabled)?.id ?? null}
        {...(options.referenceTimeMs === undefined ? {} : { referenceTimeMs: options.referenceTimeMs })}
        openingStateObservations={options.openingStateObservations ?? []}
        pendingOpeningStateKeys={options.pendingOpeningStateKeys ?? new Set()}
        onOpeningStateChange={onOpeningStateChange}
        editing={options.editing ?? false}
        onFloorSelect={onFloorSelect} onSensorSelect={onSensorSelect} onFloorChange={onFloorChange}
      />
    </I18nProvider>,
  );
  return { ...view, state, house, sensors, samples, definition, onFloorSelect, onSensorSelect, onFloorChange, onOpeningStateChange };
}

describe("BuildingScene", () => {
  it("uses effective runtime opening state and toggles it without selecting or editing the floor", () => {
    const state = createDemoState();
    const base = state.houses[0]!.floors[0]!;
    const floor: Floor = {
      ...base,
      planElements: [
        { id: "runtime-door", kind: "door", wallId: base.walls[0]!.id, position: { x: 220, y: 45 }, rotationDegrees: 0, state: "closed" },
        { id: "fixed-window", kind: "window", variant: "fixed", wallId: base.walls[0]!.id, position: { x: 420, y: 45 }, rotationDegrees: 0 },
      ],
    };
    const observation: OpeningStateObservation = {
      id: "manual-open", houseId: state.houses[0]!.id, floorId: floor.id, elementId: "runtime-door",
      state: "open", source: "manual", observedAt: "2026-07-21T08:00:30.000Z",
    };
    const onOpeningStateChange = vi.fn();
    const view = renderScene({
      floors: [floor], sensors: [], samples: {}, observations: [], referenceTimeMs: Date.parse("2026-07-21T08:01:00.000Z"),
      openingStateObservations: [observation],
      onOpeningStateChange,
    });

    const door = screen.getByRole("button", { name: /Door 1.*Open.*Closed/i });
    expect(door.getAttribute("aria-label")).toContain(floor.name);
    expect(door.getAttribute("data-opening-state")).toBe("open");
    expect(door.getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerDown(door);
    fireEvent.click(door);
    expect(onOpeningStateChange).toHaveBeenCalledWith(floor.id, "runtime-door", "closed");
    expect(view.onFloorSelect).not.toHaveBeenCalled();
    expect(view.onFloorChange).not.toHaveBeenCalled();
    const fixedWindow = view.container.querySelector<SVGGElement>('[data-element-id="fixed-window"]');
    expect(fixedWindow?.getAttribute("role")).toBe("img");
    expect(fixedWindow?.hasAttribute("tabindex")).toBe(false);

    onOpeningStateChange.mockClear();
    fireEvent.keyDown(door, { key: "Enter" });
    expect(onOpeningStateChange).toHaveBeenCalledOnce();
    expect(onOpeningStateChange).toHaveBeenCalledWith(floor.id, "runtime-door", "closed");
    expect(view.onFloorSelect).not.toHaveBeenCalled();
  });

  it("extrudes each floor using its independently configured wall height", () => {
    const state = createDemoState();
    const floors = state.houses[0]!.floors.map((floor, index) => ({ ...floor, wallHeight: index === 0 ? 3.4 : 2.2 }));
    const { container } = renderScene({ floors });
    const rendered = [...container.querySelectorAll<SVGGElement>(".building-floor")];

    expect(rendered.find((item) => item.getAttribute("data-wall-height") === "3.400")).toBeDefined();
    expect(rendered.find((item) => item.getAttribute("data-wall-height") === "2.200")).toBeDefined();
  });

  it("renders an attic roof and a fireplace chimney that reaches above it", () => {
    const state = createDemoState();
    const [ground, upper] = state.houses[0]!.floors;
    const fireplace = { id: "hearth", kind: "fireplace" as const, position: { x: 150, y: 230 }, rotationDegrees: 0, width: 80, height: 1.2, verticalExtent: "roof" as const, chimneyWidth: 42, chimneyDepth: 28 };
    const attic: Floor = {
      ...upper!, id: "attic", name: "Attic", type: "attic", elevation: 6, wallHeight: .9,
      roof: { style: "gable", pitchDegrees: 35, ridgeAxis: "x", overhang: 12, eavesHeight: .9 },
      planElements: [],
    };
    const { container } = renderScene({ floors: [{ ...ground!, planElements: [fireplace] }, upper!, attic] });

    expect(container.querySelectorAll(".building-roof-face")).toHaveLength(2);
    const chimney = container.querySelector<SVGGElement>(".building-chimney[data-vertical-extent=roof]");
    expect(chimney).not.toBeNull();
    expect(chimney?.dataset.bottom).toBe(ground!.elevation.toFixed(4));
    expect(chimney?.dataset.width).toBe("42.0000");
    expect(chimney?.dataset.depth).toBe("28.0000");
    expect(chimney?.querySelectorAll(".building-chimney-course")).toHaveLength(7);
  });

  it("renders a wall-attached exterior fire escape with configurable projection", () => {
    const state = createDemoState();
    const base = state.houses[0]!.floors[0]!;
    const wall = base.walls[0]!;
    const floor: Floor = {
      ...base,
      planElements: [{
        id: "north-escape", kind: "fireEscape", wallId: wall.id,
        position: { x: (wall.from.x + wall.to.x) / 2, y: (wall.from.y + wall.to.y) / 2 },
        rotationDegrees: 0, width: 75, height: 2.4, bottomOffsetM: .2, projection: 45, variant: "ladder",
      }],
    };
    const { container } = renderScene({ floors: [floor], sensors: [], samples: {}, observations: [], editing: true });
    const escape = container.querySelector<SVGGElement>('[data-element-id="north-escape"]');

    expect(escape?.dataset.kind).toBe("fireEscape");
    expect(escape?.dataset.depth).toBe("45.0000");
    expect(escape?.dataset.bottom).toBe("0.2000");
    expect(escape?.querySelectorAll(".building-fire-escape-detail line").length).toBeGreaterThan(6);
  });

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

  it("renders energy plugs with compact stats in 3D and honors their marker layer visibility", () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const plug: Sensor = {
      ...state.sensors[0]!, id: "plug-hs110", floorId: floor.id, name: "Desk plug", model: "HS110", tpLinkDeviceId: "hs110-1",
    };
    const power: MeasurementSample = { sensorId: plug.id, metric: "power", value: 52, canonicalUnit: "W", timestamp: new Date().toISOString(), source: "tp-link", quality: "good" };
    const energy: MeasurementSample = { ...power, metric: "energy", value: 3.14, canonicalUnit: "kWh" };
    const visible = renderScene({ sensors: [plug], samples: {}, sensorMeasurements: { [plug.id]: { power, energy } } });

    expect(visible.container.querySelector(".building-sensor.energy-device")?.textContent).toContain("52 W");
    expect(visible.container.querySelector(".building-sensor.energy-device")?.textContent).toContain("3.14 kWh");
    expect(screen.getByRole("button", { name: /Desk plug, plug sensor.*52 W.*3.14 kWh/i })).not.toBeNull();
    visible.unmount();

    const hidden = renderScene({ sensors: [plug], samples: {}, sensorMeasurements: { [plug.id]: { power, energy } }, energyDevicesVisible: false });
    expect(hidden.container.querySelector(".building-sensor.energy-device")).toBeNull();
  });

  it("renders the shared floor geometry and edits element width and height live in 3D", () => {
    const state = createDemoState();
    const base = state.houses[0]!.floors[0]!;
    const floor: Floor = {
      ...base,
      planElements: [
        { id: "door-front", kind: "door", wallId: base.walls[0]!.id, position: { x: 220, y: 45 }, rotationDegrees: 0, width: 70, height: 2 },
        { id: "window-front", kind: "window", wallId: base.walls[0]!.id, position: { x: 410, y: 45 }, rotationDegrees: 0, width: 100, height: 1.1 },
        { id: "fireplace-living", kind: "fireplace", position: { x: 150, y: 230 }, rotationDegrees: 90, width: 80, height: 1.25 },
      ],
    };
    const floorSensors = state.sensors.filter((sensor) => sensor.floorId === floor.id);
    const view = renderScene({ floors: [floor], sensors: floorSensors, observations: [], editing: true });

    expect(view.container.querySelectorAll(".building-wall-face")).toHaveLength(floor.walls.length);
    expect(view.container.querySelectorAll(".building-room-surface")).toHaveLength(floor.rooms.length);
    expect(view.container.querySelectorAll(".building-plan-element")).toHaveLength(3);
    const door = view.container.querySelector<SVGGElement>('[data-element-id="door-front"]')!;
    expect(door.dataset.width).toBe("70.0000");
    expect(door.dataset.height).toBe("2.0000");
    expect(door.dataset.bottom).toBe("0.0000");

    fireEvent.pointerDown(door);
    fireEvent.click(door);
    expect(view.onFloorSelect).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Height" }), { target: { value: "2.3" } });
    expect(view.onFloorChange).toHaveBeenLastCalledWith(expect.objectContaining({
      planElements: expect.arrayContaining([expect.objectContaining({ id: "door-front", height: 2.3 })]),
    }));
    const heightFloor = view.onFloorChange.mock.calls.at(-1)![0] as Floor;
    view.rerender(
      <I18nProvider>
        <BuildingScene
          house={{ ...view.house, floors: [heightFloor] }} sensors={view.sensors} samples={view.samples} observations={[]}
          definition={view.definition} units="metric" activeFloorId={floor.id} selectedSensorId={null}
          editing onFloorSelect={view.onFloorSelect} onSensorSelect={view.onSensorSelect} onFloorChange={view.onFloorChange}
        />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "82" } });
    const changedFloor = view.onFloorChange.mock.calls.at(-1)![0] as Floor;
    expect(changedFloor.planElements?.find((element) => element.id === "door-front")?.width).toBe(82);

    const changedHouse = { ...view.house, floors: [changedFloor] };
    view.rerender(
      <I18nProvider>
        <BuildingScene
          house={changedHouse} sensors={view.sensors} samples={view.samples} observations={[]}
          definition={view.definition} units="metric" activeFloorId={floor.id} selectedSensorId={null}
          editing onFloorSelect={view.onFloorSelect} onSensorSelect={view.onSensorSelect} onFloorChange={view.onFloorChange}
        />
      </I18nProvider>,
    );
    expect(view.container.querySelector<SVGGElement>('[data-element-id="door-front"]')?.dataset.width).toBe("82.0000");
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

  it("renders field-derived XYZ vectors instead of floor-average arrows", () => {
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
    const vectors = [...container.querySelectorAll<SVGGElement>(".volume-flow-vector")];

    expect(container.querySelectorAll(".vertical-gradient")).toHaveLength(0);
    expect(vectors.length).toBeGreaterThan(0);
    expect(vectors.some((vector) => Math.abs(Number(vector.dataset.dz)) > .01)).toBe(true);
    expect(vectors.every((vector) => Number(vector.dataset.dx) || Number(vector.dataset.dy) || Number(vector.dataset.dz))).toBe(true);
  });

  it("suppresses unsupported vertical components for equal and stale cross-floor data", () => {
    const state = createDemoState();
    const equalSamples = Object.fromEntries(state.sensors.map((sensor) => [sensor.id, {
      ...state.latestMeasurements[sensor.id]!.temperature!, value: 21,
    }])) as Record<string, MeasurementSample>;
    const equal = renderScene({ samples: equalSamples, observations: [] });
    expect(equal.container.querySelectorAll(".volume-flow-vector")).toHaveLength(0);
    equal.unmount();

    const staleUpperSamples = Object.fromEntries(state.sensors.map((sensor) => [sensor.id, {
      ...state.latestMeasurements[sensor.id]!.temperature!,
      quality: sensor.floorId === state.houses[0]!.floors[1]!.id ? "stale" as const : "good" as const,
    }])) as Record<string, MeasurementSample>;
    const stale = renderScene({ samples: staleUpperSamples, observations: [] });
    expect(stale.container.querySelectorAll(".volume-flow-vector.has-z")).toHaveLength(0);
  });

  it("changes projection when rotated by buttons and pointer drag, and resets the camera", async () => {
    const user = userEvent.setup();
    const { container } = renderScene();
    const svg = container.querySelector<SVGSVGElement>(".building-svg")!;
    const sensor = container.querySelector<SVGGElement>(".building-sensor")!;
    const initialYaw = svg.dataset.cameraYaw;
    const initialPitch = svg.dataset.cameraPitch;
    const initialTransform = sensor.getAttribute("transform");

    await user.click(screen.getByRole("button", { name: "Rotate view right" }));
    expect(svg.dataset.cameraYaw).not.toBe(initialYaw);
    expect(container.querySelector(".building-sensor")?.getAttribute("transform")).not.toBe(initialTransform);

    const buttonYaw = svg.dataset.cameraYaw;
    const pointer = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
      Object.defineProperty(event, "pointerId", { value: 7 });
      fireEvent(svg, event);
    };
    pointer("pointerdown", 420, 250);
    pointer("pointermove", 500, 290);
    pointer("pointerup", 500, 290);
    expect(svg.dataset.cameraYaw).not.toBe(buttonYaw);
    expect(svg.dataset.cameraPitch).not.toBe(initialPitch);

    const yawAfterDiagonalDrag = svg.dataset.cameraYaw;
    const pitchAfterDiagonalDrag = svg.dataset.cameraPitch;
    pointer("pointerdown", 500, 290);
    pointer("pointermove", 500, 520);
    pointer("pointerup", 500, 520);
    expect(svg.dataset.cameraYaw).toBe(yawAfterDiagonalDrag);
    expect(svg.dataset.cameraPitch).not.toBe(pitchAfterDiagonalDrag);
    expect(Number(svg.dataset.cameraPitch)).toBeLessThan(0);

    await user.click(screen.getByRole("button", { name: "Reset view" }));
    expect(svg.dataset.cameraYaw).toBe(initialYaw);
    expect(svg.dataset.cameraPitch).toBe(initialPitch);
    expect(svg.dataset.cameraZoom).toBe("1.00");
  });

  it("leaves ordinary page scrolling alone and only wheel-zooms with a modifier", () => {
    const { container } = renderScene();
    const svg = container.querySelector<SVGSVGElement>(".building-svg")!;
    const initialZoom = svg.dataset.cameraZoom;
    const plainWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 });
    fireEvent(svg, plainWheel);
    expect(plainWheel.defaultPrevented).toBe(false);
    expect(svg.dataset.cameraZoom).toBe(initialZoom);

    const zoomWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120 });
    fireEvent(svg, zoomWheel);
    expect(svg.dataset.cameraZoom).not.toBe(initialZoom);
  });

  it("keeps the 3D view active and the view switch available while editing", () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const floor = house.floors[0]!;
    const onViewMode = vi.fn();
    const view = render(
      <I18nProvider>
        <TwinDashboard
          state={demo} house={house} floor={floor} houseId={house.id} floorId={floor.id}
          metric="temperature" units="metric" viewMode="isometric" selectedSensorId={demo.sensors[0]!.id}
          saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
          onViewMode={onViewMode} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onSensorUpdate={vi.fn()}
          onFloorChange={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
          onCreateObservation={vi.fn().mockResolvedValue(demo.observations[0]!)}
          onCreateStaticParameter={vi.fn().mockResolvedValue(demo.staticParameters[0]!)}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    expect(onViewMode).not.toHaveBeenCalled();
    expect(view.container.querySelector(".building-scene")).not.toBeNull();
    expect(screen.getByRole("button", { name: "3D building" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Element properties" })).not.toBeNull();
  });
});

describe("TwinDashboard whole-building replay", () => {
  it("persists a live map toggle as runtime state instead of a layout edit", async () => {
    const user = userEvent.setup();
    const demo = createDemoState();
    const baseFloor = demo.houses[0]!.floors[0]!;
    const floor: Floor = {
      ...baseFloor,
      planElements: [{
        id: "runtime-door", kind: "door", wallId: baseFloor.walls[0]!.id,
        position: { x: 220, y: 45 }, rotationDegrees: 0, state: "closed",
      }],
    };
    const house = { ...demo.houses[0]!, floors: [floor] };
    const state = { ...demo, houses: [house] };
    const openingStates = vi.spyOn(api, "openingStates").mockResolvedValue({
      snapshot: { houseId: house.id, at: "2026-07-21T08:00:00.000Z", states: [] }, observations: [],
    });
    const recordOpeningState = vi.spyOn(api, "recordOpeningState").mockImplementation(async (houseId, input) => ({
      ...input, id: "manual-runtime-toggle", houseId, observedAt: "2026-07-21T08:00:30.000Z",
    }));
    const onFloorChange = vi.fn();
    try {
      render(
        <I18nProvider>
          <TwinDashboard
            state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
            metric="temperature" units="metric" viewMode="plan" selectedSensorId={demo.sensors[0]!.id}
            saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
            onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onSensorUpdate={vi.fn()}
            onFloorChange={onFloorChange} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
            onCreateObservation={vi.fn().mockResolvedValue(demo.observations[0]!)}
            onCreateStaticParameter={vi.fn().mockResolvedValue(demo.staticParameters[0]!)}
          />
        </I18nProvider>,
      );

      await waitFor(() => expect(openingStates).toHaveBeenCalledWith(house.id, undefined, expect.any(AbortSignal)));
      expect(screen.getByText(/Select a door, window, or vent/i)).not.toBeNull();
      await user.click(screen.getByRole("button", { name: /Door 1, Closed.*Open/i }));
      await waitFor(() => expect(recordOpeningState).toHaveBeenCalledOnce());
      expect(recordOpeningState).toHaveBeenCalledWith(house.id, expect.objectContaining({
        floorId: floor.id, elementId: "runtime-door", state: "open", source: "manual",
      }));
      expect(recordOpeningState.mock.calls[0]?.[1]).not.toHaveProperty("observedAt");
      await waitFor(() => expect(screen.getByRole("button", { name: /Door 1, Open.*Closed/i }).getAttribute("data-opening-state")).toBe("open"));
      expect(onFloorChange).not.toHaveBeenCalled();
      expect(screen.getByText("Door 1 is now Open.", { selector: ".sr-only" })).not.toBeNull();
    } finally {
      openingStates.mockRestore();
      recordOpeningState.mockRestore();
    }
  });

  it("suppresses derived summaries when there are no usable readings", () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const floor = house.floors[0]!;
    const state = { ...demo, latestMeasurements: {}, measurementHistory: {} };
    const onOpenSensors = vi.fn();
    const view = render(
      <I18nProvider>
        <TwinDashboard
          state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
          metric="temperature" units="metric" viewMode="isometric" selectedSensorId={demo.sensors[0]!.id}
          saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
          onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onSensorUpdate={vi.fn()}
          onFloorChange={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
          onCreateObservation={vi.fn().mockResolvedValue(demo.observations[0]!)}
          onCreateStaticParameter={vi.fn().mockResolvedValue(demo.staticParameters[0]!)}
          onOpenSensors={onOpenSensors}
        />
      </I18nProvider>,
    );

    expect(view.container.querySelector(".home-status-zone")).toBeNull();
    expect(view.container.querySelector(".moisture-coach")).toBeNull();
    expect(view.container.querySelector(".room-comfort-section")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(onOpenSensors).toHaveBeenCalledWith(house.id);
  });

  it("loads every airflow driver for every enabled house sensor in isometric replay", async () => {
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
    await waitFor(() => expect(onLoadSeries).toHaveBeenCalledTimes(enabledHouseSensors.length * 3));
    for (const metric of ["temperature", "humidity", "co2"]) {
      expect(onLoadSeries.mock.calls.filter(([, loadedMetric]) => loadedMetric === metric).map(([sensorId]) => sensorId).sort())
        .toEqual(enabledHouseSensors.map((sensor) => sensor.id).sort());
    }
    expect(onLoadSeries.mock.calls.filter(([sensorId]) => sensorId === selectedSensor.id)).toHaveLength(3);
    expect(onLoadSeries.mock.calls.every(([, , range, forecastSupported]) => range === "24h" && forecastSupported === true)).toBe(true);
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
    expect(screen.queryByRole("combobox", { name: "Metric" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Replay" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Room thermal model" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Available measurements" })).toBeNull();
    expect(screen.getByText(/Drag this sensor on the plan.*arrow keys/i)).not.toBeNull();
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
