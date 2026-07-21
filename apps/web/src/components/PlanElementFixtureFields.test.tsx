import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Floor } from "@climate-twin/contracts";
import { I18nProvider } from "../i18n";
import { applyFixturePlanElementPatch, PlanElementFixtureFields } from "./PlanElementFixtureFields";

const floor: Floor = {
  id: "ground", name: "Ground", width: 10, height: 8, elevation: 0, ceilingHeight: 2.8,
  walls: [{ id: "north", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }], rooms: [],
};

describe("PlanElementFixtureFields", () => {
  it("configures an independent full-height chimney and clears roof-only dimensions when disabled", () => {
    const element = {
      id: "hearth", kind: "fireplace" as const, position: { x: 4, y: 3 }, rotationDegrees: 0,
      width: 1.2, verticalExtent: "roof" as const, chimneyHeightAboveRoof: .8, chimneyWidth: .7, chimneyDepth: .5,
    };
    const onChange = vi.fn();
    render(<I18nProvider><PlanElementFixtureFields floor={floor} element={element} planUnitLabel="plan unit" onChange={onChange} /></I18nProvider>);

    expect((screen.getByRole("spinbutton", { name: /^Chimney shaft width/ }) as HTMLInputElement).valueAsNumber).toBe(.7);
    expect((screen.getByRole("spinbutton", { name: /^Chimney shaft depth/ }) as HTMLInputElement).valueAsNumber).toBe(.5);
    fireEvent.change(screen.getByRole("combobox", { name: "Vertical structure" }), { target: { value: "level" } });
    expect(onChange).toHaveBeenLastCalledWith({
      verticalExtent: "level", chimneyHeightAboveRoof: undefined, chimneyWidth: undefined, chimneyDepth: undefined,
    });
    expect(applyFixturePlanElementPatch(element, onChange.mock.calls.at(-1)![0])).toEqual(expect.not.objectContaining({ chimneyWidth: expect.anything() }));
  });

  it("edits the exterior fire escape type, mounting height, and projection", () => {
    const element = {
      id: "escape", kind: "fireEscape" as const, wallId: "north", position: { x: 5, y: 0 }, rotationDegrees: 0,
      width: 1.1, height: 2.2, variant: "ladder" as const, projection: .7,
    };
    const onChange = vi.fn();
    render(<I18nProvider><PlanElementFixtureFields floor={floor} element={element} planUnitLabel="plan unit" onChange={onChange} /></I18nProvider>);

    fireEvent.change(screen.getByRole("combobox", { name: "Fire escape type" }), { target: { value: "stairs" } });
    expect(onChange).toHaveBeenCalledWith({ fireEscapeVariant: "stairs" });
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Projection from wall/ }), { target: { value: "1.2" } });
    expect(onChange).toHaveBeenLastCalledWith({ projection: 1.2 });
  });
});
