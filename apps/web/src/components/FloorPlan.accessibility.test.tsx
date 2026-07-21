import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { FloorPlan } from "./FloorPlan";
import { openingStateKey } from "../openingState";

describe("FloorPlan editor disclosure", () => {
  it("opens and closes runtime openings without changing the building layout", () => {
    const state = createDemoState();
    const baseFloor = state.houses[0]!.floors[0]!;
    const floor = {
      ...baseFloor,
      planElements: [
        { id: "runtime-door", kind: "door" as const, wallId: baseFloor.walls[0]!.id, position: { x: 220, y: 45 }, rotationDegrees: 0, state: "closed" as const },
        { id: "fixed-window", kind: "window" as const, variant: "fixed" as const, wallId: baseFloor.walls[0]!.id, position: { x: 420, y: 45 }, rotationDegrees: 0 },
      ],
    };
    const house = { ...state.houses[0]!, floors: [floor] };
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const onOpeningStateChange = vi.fn();
    const onFloorChange = vi.fn();
    const common = {
      floor, house, sensors: [], samples: {}, observations: [], definition, units: "metric" as const,
      viewMode: "plan" as const, selectedSensorId: null, editing: false, observationPlacement: false,
      onSensorSelect: vi.fn(), onSensorMove: vi.fn(), onFloorChange, onObservationPoint: vi.fn(),
      onCancelObservationPlacement: vi.fn(), onOpeningStateChange,
    };
    const view = render(<I18nProvider><FloorPlan {...common} referenceTimeMs={Date.parse("2026-07-21T08:00:00.000Z")} /></I18nProvider>);

    const closedDoor = screen.getByRole("button", { name: /Door 1, Closed.*Open/i });
    fireEvent.click(closedDoor);
    expect(onOpeningStateChange).toHaveBeenCalledWith(floor.id, "runtime-door", "open");
    expect(onFloorChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Window 2/i })).toBeNull();

    onOpeningStateChange.mockClear();
    view.rerender(<I18nProvider><FloorPlan
      {...common}
      referenceTimeMs={Date.parse("2026-07-21T08:01:00.000Z")}
      openingStateObservations={[{
        id: "manual-open", houseId: house.id, floorId: floor.id, elementId: "runtime-door",
        state: "open", source: "manual", observedAt: "2026-07-21T08:00:30.000Z",
      }, {
        id: "other-house-closed", houseId: "other-house", floorId: floor.id, elementId: "runtime-door",
        state: "closed", source: "manual", observedAt: "2026-07-21T08:00:50.000Z",
      }]}
    /></I18nProvider>);
    const openDoor = screen.getByRole("button", { name: /Door 1, Open.*Closed/i });
    expect(openDoor.getAttribute("aria-pressed")).toBe("true");
    expect(openDoor.getAttribute("data-opening-state")).toBe("open");
    fireEvent.keyDown(openDoor, { key: " " });
    expect(onOpeningStateChange).toHaveBeenCalledWith(floor.id, "runtime-door", "closed");

    onOpeningStateChange.mockClear();
    view.rerender(<I18nProvider><FloorPlan
      {...common}
      referenceTimeMs={Date.parse("2026-07-21T08:01:00.000Z")}
      openingStateObservations={[{
        id: "manual-open", houseId: house.id, floorId: floor.id, elementId: "runtime-door",
        state: "open", source: "manual", observedAt: "2026-07-21T08:00:30.000Z",
      }]}
      pendingOpeningStateKeys={new Set([openingStateKey(floor.id, "runtime-door")])}
    /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Door 1, Open.*Closed/i }));
    expect(onOpeningStateChange).not.toHaveBeenCalled();
  });

  it("shows roof geometry and inherited chimney penetrations in the 2D attic plan", () => {
    const state = createDemoState();
    const [ground, upper] = state.houses[0]!.floors;
    const fireplace = { id: "hearth", kind: "fireplace" as const, position: { x: 150, y: 230 }, rotationDegrees: 0, width: 80, verticalExtent: "roof" as const };
    const attic = {
      ...upper!, id: "attic", name: "Attic", type: "attic" as const, elevation: 6, wallHeight: .9,
      roof: { style: "hip" as const, pitchDegrees: 32, ridgeAxis: "x" as const, overhang: 10, eavesHeight: .9 },
      planElements: [],
    };
    const house = { ...state.houses[0]!, floors: [{ ...ground!, planElements: [fireplace] }, upper!, attic] };
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const { container } = render(
      <I18nProvider><FloorPlan
        floor={attic} house={house} sensors={[]} samples={{}} observations={[]}
        definition={definition} units="metric" viewMode="plan" selectedSensorId={null}
        editing={false} observationPlacement={false} onSensorSelect={vi.fn()} onSensorMove={vi.fn()}
        onFloorChange={vi.fn()} onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      /></I18nProvider>,
    );

    expect(container.querySelector(".plan-roof-overlay.hip")).not.toBeNull();
    expect(container.querySelectorAll(".chimney-penetration")).toHaveLength(1);
  });

  it("keeps add and editor options concise and only reveals delete for a selection", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.floorId === floor.id);
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const samples = Object.fromEntries(sensors.flatMap((sensor) => {
      const sample = state.latestMeasurements[sensor.id]?.temperature;
      return sample ? [[sensor.id, sample]] : [];
    }));
    const { container } = render(
      <I18nProvider>
        <FloorPlan
          floor={floor} sensors={sensors} samples={samples} observations={[]}
          definition={definition} units="metric" viewMode="plan" selectedSensorId={null}
          editing observationPlacement={false} onSensorSelect={vi.fn()} onSensorMove={vi.fn()}
          onFloorChange={vi.fn()} onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(container.querySelectorAll(".sensor-hit-target")).toHaveLength(sensors.length);
    expect(container.querySelector(".sensor-hit-target")?.getAttribute("r")).toBe("56");

    expect(screen.getByRole("button", { name: "Select & move" })).not.toBeNull();
    expect(screen.getByText("Add", { selector: "summary" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Draw wall" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Snap to grid" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete wall" })).toBeNull();

    await user.click(screen.getByText("Add", { selector: "summary" }));
    expect(screen.getByRole("button", { name: "Draw wall" })).not.toBeNull();

    await user.click(screen.getByText("Editor options", { selector: "summary" }));
    expect(screen.getByRole("button", { name: "Snap to grid" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Delete wall" })).toBeNull();

    const wall = container.querySelector<SVGGElement>('.wall-segment-group[role="button"]')!;
    fireEvent.pointerDown(wall);
    expect(screen.getByRole("button", { name: "Delete wall" })).not.toBeNull();
  });

  it("calibrates a level from one measured wall and labels every wall length", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const onFloorChange = vi.fn();
    const { container } = render(
      <I18nProvider><FloorPlan
        floor={floor} sensors={[]} samples={{}} observations={[]}
        definition={definition} units="metric" viewMode="plan" selectedSensorId={null}
        editing observationPlacement={false} onSensorSelect={vi.fn()} onSensorMove={vi.fn()}
        onFloorChange={onFloorChange} onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      /></I18nProvider>,
    );

    const labels = [...container.querySelectorAll<SVGTextElement>(".wall-length-label")];
    expect(labels).toHaveLength(floor.walls.length);
    expect(labels[0]?.textContent).toBe("900 units");

    await user.click(screen.getByRole("button", { name: "Wall 1" }));
    const length = screen.getByRole("spinbutton", { name: "Wall length" });
    await user.type(length, "10.8{Enter}");

    expect(onFloorChange).toHaveBeenCalledOnce();
    expect(onFloorChange.mock.calls[0]![0].metersPerPlanUnit).toBeCloseTo(.012, 8);
  });
});
