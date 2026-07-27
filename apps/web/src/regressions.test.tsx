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
});
