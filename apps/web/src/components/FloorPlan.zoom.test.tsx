import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { FloorPlan } from "./FloorPlan";

afterEach(() => localStorage.clear());

describe("2D floor-plan camera", () => {
  it("zooms around the center with controls and Ctrl/Command + scroll", async () => {
    localStorage.setItem("climate-twin-locale", "en");
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const view = render(
      <I18nProvider><FloorPlan
        floor={floor} house={house} sensors={[]} samples={{}} observations={[]} definition={definition} units="metric"
        viewMode="plan" selectedSensorId={null} editing={false} observationPlacement={false}
        onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      /></I18nProvider>,
    );

    const svg = view.container.querySelector<SVGSVGElement>(".floor-plan")!;
    const initialViewBox = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(screen.getByRole("group", { name: "2D plan controls" })).not.toBeNull();
    expect(svg.dataset.planZoom).toBe("1.00");

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomedViewBox = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(svg.dataset.planZoom).toBe("1.15");
    expect(zoomedViewBox[2]).toBeLessThan(initialViewBox[2]!);
    expect(zoomedViewBox[0]! + zoomedViewBox[2]! / 2).toBeCloseTo(initialViewBox[0]! + initialViewBox[2]! / 2);
    expect(zoomedViewBox[1]! + zoomedViewBox[3]! / 2).toBeCloseTo(initialViewBox[1]! + initialViewBox[3]! / 2);

    fireEvent.wheel(svg, { ctrlKey: true, deltaY: -120 });
    expect(Number(svg.dataset.planZoom)).toBeGreaterThan(1.15);
    const wheelZoom = svg.dataset.planZoom;
    fireEvent.wheel(svg, { deltaY: -120 });
    expect(svg.dataset.planZoom).toBe(wheelZoom);

    await user.click(screen.getByRole("button", { name: "Reset view" }));
    expect(svg.dataset.planZoom).toBe("1.00");
    expect(svg.getAttribute("viewBox")).toBe(initialViewBox.join(" "));
  });
});
