import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import type { Floor, MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";
import styles from "./styles.css?raw";
import i18nSource from "./i18n.tsx?raw";
import { AppShell } from "./components/AppShell";
import { defaultPlanElementWidth, FloorPlan, floorGridSize, snapPointToGrid } from "./components/FloorPlan";
import { TrendChart } from "./components/TrendChart";
import { createDemoState, type ClimateState } from "./domain";
import { I18nProvider } from "./i18n";
import { definitionFor } from "./measurements";
import { AlertsPage } from "./pages/AlertsPage";
import { TwinDashboard } from "./pages/TwinDashboard";

function withI18n(node: ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

function samplesFor(state: ClimateState, definition: MeasurementDefinition, sensors: Sensor[] = state.sensors) {
  return Object.fromEntries(sensors.flatMap((sensor) => {
    const sample = state.latestMeasurements[sensor.id]?.[definition.id];
    return sample ? [[sensor.id, sample]] : [];
  })) as Record<string, MeasurementSample>;
}

function ControlledFloorPlan({
  initialFloor, definition, sensors = [], onChange,
}: {
  initialFloor: Floor;
  definition: MeasurementDefinition;
  sensors?: Sensor[];
  onChange: (floor: Floor) => void;
}) {
  const [floor, setFloor] = useState(initialFloor);
  return (
    <FloorPlan
      floor={floor} sensors={sensors} samples={{}} observations={[]} definition={definition} units="metric"
      viewMode="plan" selectedSensorId={null} editing observationPlacement={false}
      onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={(next) => { setFloor(next); onChange(next); }}
      onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
    />
  );
}

async function openFloorAddTools(user: ReturnType<typeof userEvent.setup>) {
  const summary = screen.getByText("Add", { selector: "summary" });
  await user.click(summary);
  await waitFor(() => expect(summary.closest("details")?.open).toBe(true));
}

async function openFloorEditorOptions(user: ReturnType<typeof userEvent.setup>) {
  const summary = screen.getByText("Editor options", { selector: "summary" });
  await user.click(summary);
  await waitFor(() => expect(summary.closest("details")?.open).toBe(true));
}

describe("frontend regressions", () => {
  it("keeps translation source free of common mojibake markers", () => {
    expect(i18nSource).not.toMatch(/â€¦|Ã|Â°|â€“|â€”|â€™|â€œ|â€|Â·/);
  });

  it("shows the distinct demo shell only after the environment is confirmed", () => {
    const shell = (dataMode: "demo" | "real" | "unknown") => withI18n(
      <AppShell page="twin" onPage={vi.fn()} connection="offline" units="metric" onUnits={vi.fn()} lastUpdated={null} dataMode={dataMode}>
        <p>Content</p>
      </AppShell>,
    );
    const view = render(shell("unknown"));
    const appShell = view.container.querySelector(".app-shell")!;
    expect(appShell.classList.contains("neutral-mode")).toBe(true);
    expect(appShell.classList.contains("demo-mode")).toBe(false);
    expect(appShell.getAttribute("data-environment")).toBe("unknown");
    expect(view.container.querySelector(".demo-banner")).toBeNull();

    view.rerender(shell("demo"));
    expect(appShell.classList.contains("demo-mode")).toBe(true);
    expect(view.container.querySelector(".demo-banner")?.textContent).toMatch(/Demo data.*generated sample data/i);

    view.rerender(shell("real"));
    expect(appShell.classList.contains("real-mode")).toBe(true);
    expect(view.container.querySelector(".demo-banner")).toBeNull();
  });

  it("keeps an in-progress temperature threshold stable when units change", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const onCreateRule = vi.fn().mockResolvedValue(undefined);
    const view = render(withI18n(
      <AlertsPage state={state} units="metric" onCreateRule={onCreateRule} onUpdateRule={vi.fn()} onAcknowledge={vi.fn()} />,
    ));

    await user.click(screen.getByRole("button", { name: "New rule" }));
    await user.type(screen.getByLabelText("Rule name"), "Cold room");
    await user.selectOptions(screen.getByLabelText("Metric"), "temperature");
    const threshold = screen.getByLabelText(/^Threshold/) as HTMLInputElement;
    expect(Number(threshold.value)).toBe(20);
    await user.clear(threshold);
    await user.type(threshold, "23.5");

    view.rerender(withI18n(
      <AlertsPage state={state} units="imperial" onCreateRule={onCreateRule} onUpdateRule={vi.fn()} onAcknowledge={vi.fn()} />,
    ));
    expect(Number((screen.getByLabelText(/^Threshold/) as HTMLInputElement).value)).toBeCloseTo(74.3, 5);

    await user.click(screen.getByRole("button", { name: "Create rule" }));
    expect(onCreateRule).toHaveBeenCalledOnce();
    const submitted = onCreateRule.mock.calls[0]![0];
    expect(submitted.metric).toBe("temperature");
    expect(submitted.threshold).toBeCloseTo(23.5, 5);
  });

  it("exposes alert-rule severity as text in the disclosed rules list", async () => {
    const user = userEvent.setup();
    render(withI18n(
      <AlertsPage state={createDemoState()} units="metric" onCreateRule={vi.fn()} onUpdateRule={vi.fn()} onAcknowledge={vi.fn()} />,
    ));

    await user.click(screen.getByText("Rules", { selector: ".alerts-rule-admin > summary strong" }));
    const rules = document.querySelector<HTMLElement>(".alerts-rule-admin");
    expect(rules).not.toBeNull();
    expect(within(rules!).getByText(/Warning/)).not.toBeNull();
  });

  it("removes the closed mobile navigation from interaction and restores it when opened", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((media: string) => ({
      matches: media === "(max-width: 900px)",
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    try {
      const view = render(withI18n(
        <AppShell page="twin" onPage={vi.fn()} connection="offline" units="metric" onUnits={vi.fn()} lastUpdated={null} dataMode="demo">
          <p>Content</p>
        </AppShell>,
      ));
      const navigation = screen.getByLabelText("Primary navigation");
      const mainColumn = view.container.querySelector(".app-main-column")!;
      expect(navigation.getAttribute("aria-hidden")).toBe("true");
      expect(navigation.hasAttribute("inert")).toBe(true);
      expect(mainColumn.hasAttribute("aria-hidden")).toBe(false);
      expect(mainColumn.hasAttribute("inert")).toBe(false);

      const opener = screen.getByRole("button", { name: "Open navigation" });
      expect(opener.getAttribute("aria-expanded")).toBe("false");
      expect(opener.getAttribute("aria-controls")).toBe(navigation.id);
      await user.click(opener);

      expect(navigation.hasAttribute("inert")).toBe(false);
      expect(navigation.hasAttribute("aria-hidden")).toBe(false);
      expect(navigation.getAttribute("role")).toBe("dialog");
      expect(navigation.getAttribute("aria-modal")).toBe("true");
      expect(opener.getAttribute("aria-expanded")).toBe("true");
      expect(mainColumn.getAttribute("aria-hidden")).toBe("true");
      expect(mainColumn.hasAttribute("inert")).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");
      const scrim = view.container.querySelector(".nav-scrim")!;
      expect(scrim.getAttribute("aria-hidden")).toBe("true");
      expect(scrim.hasAttribute("tabindex")).toBe(false);
      expect(scrim.tagName).toBe("DIV");
      await waitFor(() => expect(document.activeElement).toBe(within(navigation).getByRole("button", { name: "Close navigation" })));

      await user.keyboard("{Escape}");
      await waitFor(() => expect(document.activeElement).toBe(opener));
      expect(navigation.getAttribute("aria-hidden")).toBe("true");
      expect(navigation.hasAttribute("inert")).toBe(true);
      expect(mainColumn.hasAttribute("aria-hidden")).toBe(false);
      expect(document.body.style.overflow).toBe("");
      view.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes the mobile navigation when the viewport becomes desktop-sized", async () => {
    const user = userEvent.setup();
    let onViewportChange: ((event: MediaQueryListEvent) => void) | undefined;
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true,
      media: "(max-width: 900px)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => { onViewportChange = listener; }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      render(withI18n(
        <AppShell page="twin" onPage={vi.fn()} connection="offline" units="metric" onUnits={vi.fn()} lastUpdated={null} dataMode="demo">
          <p>Content</p>
        </AppShell>,
      ));
      const opener = screen.getByRole("button", { name: "Open navigation" });
      await user.click(opener);
      expect(opener.getAttribute("aria-expanded")).toBe("true");

      act(() => onViewportChange?.({ matches: false } as MediaQueryListEvent));
      await waitFor(() => expect(opener.getAttribute("aria-expanded")).toBe("false"));
      expect(screen.getByLabelText("Primary navigation").hasAttribute("aria-hidden")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets desktop users hide, restore, and persist the primary navigation", async () => {
    const user = userEvent.setup();
    const renderShell = () => render(withI18n(
      <AppShell page="twin" onPage={vi.fn()} connection="offline" units="metric" onUnits={vi.fn()} lastUpdated={null} dataMode="demo">
        <p>Content</p>
      </AppShell>,
    ));

    const firstView = renderShell();
    const firstShell = firstView.container.querySelector(".app-shell");
    const navigation = firstView.container.querySelector("#primary-sidebar");
    expect(firstShell?.classList.contains("navigation-hidden")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Hide navigation" }));
    expect(firstShell?.classList.contains("navigation-hidden")).toBe(true);
    expect(navigation?.getAttribute("aria-hidden")).toBe("true");
    expect(localStorage.getItem("climate-twin-navigation")).toBe("hidden");
    const firstShowButton = screen.getByRole("button", { name: "Show navigation" });
    await waitFor(() => expect(document.activeElement).toBe(firstShowButton));
    firstView.unmount();

    const persistedView = renderShell();
    const persistedShell = persistedView.container.querySelector(".app-shell");
    expect(persistedShell?.classList.contains("navigation-hidden")).toBe(true);
    const showButton = screen.getByRole("button", { name: "Show navigation" });
    await user.click(showButton);
    expect(persistedShell?.classList.contains("navigation-hidden")).toBe(false);
    expect(persistedView.container.querySelector("#primary-sidebar")?.hasAttribute("aria-hidden")).toBe(false);
    expect(localStorage.getItem("climate-twin-navigation")).toBe("visible");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide navigation" })));
  });

  it("supports keyboard placement of observations and walls on the floor map", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.floorId === floor.id);
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const samples = samplesFor(state, definition, sensors);
    const onObservationPoint = vi.fn();
    const observationView = render(withI18n(
      <FloorPlan
        floor={floor} sensors={sensors} samples={samples} observations={state.observations}
        definition={definition} units="metric" viewMode="plan" selectedSensorId={null} editing={false}
        observationPlacement onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onObservationPoint={onObservationPoint} onCancelObservationPlacement={vi.fn()}
      />,
    ));
    const observationMap = screen.getByRole("group", { name: /Temperature map for Ground floor/i });
    expect(observationMap.getAttribute("tabindex")).toBe("0");
    observationMap.focus();
    await user.keyboard("{Enter}");
    expect(onObservationPoint).toHaveBeenCalledOnce();
    expect(onObservationPoint.mock.calls[0]![0].x).toBeGreaterThanOrEqual(0);
    expect(onObservationPoint.mock.calls[0]![0].x).toBeLessThanOrEqual(floor.width);
    expect(onObservationPoint.mock.calls[0]![0].y).toBeGreaterThanOrEqual(0);
    expect(onObservationPoint.mock.calls[0]![0].y).toBeLessThanOrEqual(floor.height);
    observationView.unmount();

    const onFloorChange = vi.fn();
    const editableFloor = { ...floor, metersPerPlanUnit: .012 };
    const wallView = render(withI18n(
      <FloorPlan
        floor={editableFloor} sensors={sensors} samples={samples} observations={state.observations}
        definition={definition} units="metric" viewMode="plan" selectedSensorId={null} editing
        observationPlacement={false} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={onFloorChange}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />,
    ));
    expect(screen.getByRole("toolbar", { name: "Floor-plan editing tools" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Select & move" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toMatch(/Select a room.*wall.*plan element.*drawing tool/i);
    await openFloorAddTools(user);
    await user.click(screen.getByRole("button", { name: "Draw wall" }));
    expect(screen.getByRole("status").textContent).toMatch(/Choose a start point.*Enter.*Escape/i);
    const wallMap = screen.getByRole("group", { name: /Editing Ground floor/i });
    wallMap.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status").textContent).toMatch(/Choose the end point.*Shift.*Escape/i);
    expect(wallView.container.querySelector(".wall-preview-length")?.textContent).toBe("0 m");
    await user.keyboard("{ArrowRight}");
    const gridSize = floorGridSize(editableFloor);
    const expectedPreviewLength = new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(gridSize * editableFloor.metersPerPlanUnit);
    expect(wallView.container.querySelector(".wall-preview-length")?.textContent).toBe(`${expectedPreviewLength} m`);
    await user.keyboard("{Enter}");
    expect(onFloorChange).toHaveBeenCalledOnce();
    const changedFloor = onFloorChange.mock.calls[0]![0];
    const wall = changedFloor.walls.at(-1)!;
    expect(wall.from).not.toEqual(wall.to);
    expect(wall.to.x - wall.from.x).toBeCloseTo(gridSize, 8);
    for (const coordinate of [wall.from.x, wall.from.y, wall.to.x, wall.to.y]) {
      expect(coordinate / gridSize).toBeCloseTo(Math.round(coordinate / gridSize), 8);
    }

    await user.keyboard("{Enter}{Enter}");
    expect(onFloorChange).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Draw wall", hidden: true }).getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Select & move" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("selects and deletes walls from the original floor template", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const onFloorChange = vi.fn();
    const view = render(withI18n(
      <FloorPlan
        floor={floor} sensors={[]} samples={{}} observations={[]} definition={definition} units="metric"
        viewMode="plan" selectedSensorId={null} editing observationPlacement={false}
        onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={onFloorChange}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />,
    ));

    await openFloorEditorOptions(user);
    expect(view.container.querySelector('[data-testid="floor-snap-grid"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Snap to grid" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Grid size" })).not.toBeNull();

    const originalWall = floor.walls[0]!;
    const wallButton = screen.getByRole("button", { name: "Wall 1" });
    await user.click(wallButton);
    expect(wallButton.getAttribute("aria-pressed")).toBe("true");
    const deleteButton = screen.getByRole("button", { name: "Delete wall" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(false);
    await user.click(deleteButton);

    expect(onFloorChange).toHaveBeenCalledOnce();
    const changedFloor = onFloorChange.mock.calls[0]![0];
    expect(changedFloor.walls).toHaveLength(floor.walls.length - 1);
    expect(changedFloor.walls.some((wall: { id: string }) => wall.id === originalWall.id)).toBe(false);
    expect(floor.walls).toHaveLength(8);

    view.unmount();
    const readOnlyView = render(withI18n(
      <FloorPlan
        floor={floor} sensors={[]} samples={{}} observations={[]} definition={definition} units="metric"
        viewMode="plan" selectedSensorId={null} editing={false} observationPlacement={false}
        onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />,
    ));
    expect(readOnlyView.container.querySelector('[data-testid="floor-snap-grid"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Wall 1" })).toBeNull();
    expect(screen.getByRole("img", { name: `Room: ${floor.rooms[0]!.name}` })).not.toBeNull();
  });

  it("designates, renames, classifies, reshapes, and deletes room zones", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const floor = {
      ...state.houses[0]!.floors[0]!,
      rooms: state.houses[0]!.floors[0]!.rooms.map((room) => ({ ...room, points: room.points.map((point) => ({ ...point })) })),
    };
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const onChange = vi.fn();
    const roomSensor = state.sensors.find((sensor) => sensor.floorId === floor.id && sensor.room === "Living room")!;
    const view = render(withI18n(<ControlledFloorPlan initialFloor={floor} definition={definition} sensors={[roomSensor]} onChange={onChange} />));

    await user.click(screen.getByRole("button", { name: "Room: Living room" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
    expect(screen.getByText(/Manage their assignments separately in Sensors/i)).not.toBeNull();
    expect(view.container.querySelectorAll(".room-vertex-handle")).toHaveLength(4);
    const firstCorner = screen.getByRole("button", { name: /Living room, corner 1/i });
    firstCorner.focus();
    await user.keyboard("{ArrowRight}");
    let changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.rooms[0]!.points[0]!.x).toBeGreaterThan(floor.rooms[0]!.points[0]!.x);
    const name = screen.getByLabelText("Name");
    name.focus();
    await user.clear(name);
    await user.type(name, "Family room");
    await user.selectOptions(screen.getByLabelText("Type"), "living");
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.rooms.find((room) => room.id === floor.rooms[0]!.id)).toMatchObject({ name: "Family room", kind: "living" });

    await openFloorEditorOptions(user);
    expect((screen.getByRole("button", { name: "Delete room" }) as HTMLButtonElement).disabled).toBe(true);
    const unassignedRoom = floor.rooms.find((room) => room.id !== floor.rooms[0]!.id)!;
    await user.click(screen.getByRole("button", { name: `Room: ${unassignedRoom.name}` }));
    await user.click(screen.getByRole("button", { name: "Delete room" }));
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.rooms.some((room) => room.id === floor.rooms[0]!.id)).toBe(true);
    expect(changed.rooms.some((room) => room.id === unassignedRoom.id)).toBe(false);

    await openFloorAddTools(user);
    await user.click(screen.getByRole("button", { name: "Designate room" }));
    const map = screen.getByRole("group", { name: /Editing Ground floor/i });
    map.focus();
    await user.keyboard("{Enter}{ArrowRight}{ArrowDown}{Enter}");
    changed = onChange.mock.calls.at(-1)![0] as Floor;
    const added = changed.rooms.at(-1)!;
    expect(added.name).toMatch(/^Room /);
    expect(added.kind).toBe("other");
    expect(added.points).toHaveLength(4);
    const gridSize = floorGridSize(floor);
    for (const point of added.points) {
      expect(point.x / gridSize).toBeCloseTo(Math.round(point.x / gridSize), 8);
      expect(point.y / gridSize).toBeCloseTo(Math.round(point.y / gridSize), 8);
    }
  });

  it("adds enough room edit points to create an L-shaped room", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const floor: Floor = {
      id: "l-shaped-room", name: "L-shaped room", width: 100, height: 100, elevation: 0, walls: [],
      rooms: [{ id: "room", name: "Test room", kind: "other", points: [{ x: 25, y: 25 }, { x: 50, y: 25 }, { x: 50, y: 50 }, { x: 25, y: 50 }] }],
      planElements: [],
    };
    const onChange = vi.fn();
    const view = render(withI18n(<ControlledFloorPlan initialFloor={floor} definition={definition} onChange={onChange} />));

    await user.click(screen.getByRole("button", { name: "Room: Test room" }));
    const rightEdge = screen.getByRole("button", { name: /Test room, add a corner between corners 2 and 3/i });
    rightEdge.focus();
    await user.keyboard("{Enter}");
    expect(view.container.querySelectorAll(".room-vertex-handle")).toHaveLength(5);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Test room, corner 3/i }));

    await user.click(screen.getByRole("button", { name: /Test room, add a corner between corners 4 and 5/i }));
    expect(view.container.querySelectorAll(".room-vertex-handle")).toHaveLength(6);
    expect(view.container.querySelectorAll(".room-edge-handle")).toHaveLength(6);

    const map = view.container.querySelector<SVGSVGElement>("svg.floor-plan")!;
    Object.defineProperty(map, "getScreenCTM", { configurable: true, value: () => null });
    Object.defineProperty(map, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, toJSON: () => ({}) }),
    });
    const innerCorner = screen.getByRole("button", { name: /Test room, corner 4/i });
    fireEvent(innerCorner, new MouseEvent("pointerdown", { bubbles: true, clientX: 500, clientY: 500 }));
    fireEvent(innerCorner, new MouseEvent("pointermove", { bubbles: true, clientX: 375, clientY: 375 }));
    fireEvent(innerCorner, new MouseEvent("pointerup", { bubbles: true, clientX: 375, clientY: 375 }));

    const changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.rooms[0]!.points).toEqual([
      { x: 25, y: 25 }, { x: 50, y: 25 }, { x: 50, y: 37.5 },
      { x: 37.5, y: 37.5 }, { x: 37.5, y: 50 }, { x: 25, y: 50 },
    ]);
  });

  it("rejects duplicate room names case-insensitively at commit", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const originalRoom = floor.rooms[0]!;
    const duplicateName = floor.rooms[1]!.name.toUpperCase();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const onChange = vi.fn();
    render(withI18n(<ControlledFloorPlan initialFloor={floor} definition={definition} onChange={onChange} />));

    await user.click(screen.getByRole("button", { name: `Room: ${originalRoom.name}` }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, duplicateName);
    await user.tab();

    expect((await screen.findByRole("alert")).textContent).toMatch(/already exists.*unique name/i);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(originalRoom.name);
    const changed = onChange.mock.calls.at(-1)![0] as Floor;
    expect(changed.rooms.find((room) => room.id === originalRoom.id)?.name).toBe(originalRoom.name);
  });

  it("keeps the last valid room boundary when a vertex edit would collapse it", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const floor: Floor = {
      id: "room-shape", name: "Room shape", width: 100, height: 100, elevation: 0, walls: [],
      rooms: [{ id: "room", name: "Test room", kind: "other", points: [{ x: 25, y: 25 }, { x: 50, y: 25 }, { x: 50, y: 50 }, { x: 25, y: 50 }] }],
      planElements: [],
    };
    const onChange = vi.fn();
    render(withI18n(<ControlledFloorPlan initialFloor={floor} definition={definition} onChange={onChange} />));

    await user.click(screen.getByRole("button", { name: "Room: Test room" }));
    const corner = screen.getByRole("button", { name: /Test room, corner 1/i });
    corner.focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect((onChange.mock.calls.at(-1)![0] as Floor).rooms[0]!.points[0]!.x).toBe(37.5);
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");

    expect(onChange).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toMatch(/collapse or cross the room boundary/i);
  });

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

function declarationsFor(source: string, selector: string) {
  const result: Record<string, string> = {};
  let previousClose = -1;
  let open = source.indexOf("{");
  while (open !== -1) {
    const close = source.indexOf("}", open + 1);
    if (close === -1) break;
    const header = source.slice(previousClose + 1, open);
    if (header.includes(selector)) {
      for (const declaration of source.slice(open + 1, close).split(";")) {
        const colon = declaration.indexOf(":");
        if (colon === -1) continue;
        result[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
    }
    previousClose = close;
    open = source.indexOf("{", open + 1);
  }
  return result;
}

function resolveVariable(value: string | undefined, variables: Record<string, string>): string {
  if (!value) throw new Error("Expected a CSS color declaration");
  const match = value.match(/^var\((--[^,)]+)/);
  return match ? resolveVariable(variables[match[1]!], variables) : value;
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => {
    const normalized = color.startsWith("#")
      ? color.length === 4
        ? color.slice(1).split("").map((channel) => parseInt(channel + channel, 16))
        : [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map((channel) => parseInt(channel, 16))
      : color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const channels = normalized;
    if (channels.length !== 3) throw new Error(`Expected an RGB color, received ${color}`);
    const linear = channels.map((channel) => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + .05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + .05);
}
