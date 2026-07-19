import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { FloorPlan } from "./FloorPlan";

describe("FloorPlan editor disclosure", () => {
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
});
