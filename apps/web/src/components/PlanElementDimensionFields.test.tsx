import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanElementDimensionFields } from "./PlanElementDimensionFields";

describe("PlanElementDimensionFields", () => {
  it("keeps precise canonical values in the number inputs", () => {
    const onWidthChange = vi.fn();
    render(<PlanElementDimensionFields
      widthLabel="Width"
      heightLabel="Height"
      planUnitLabel="plan units"
      metreLabel="m"
      width={1.16666666667}
      height={1.2}
      widthBounds={{ min: .466666666668, max: 2.91666666668, step: .116666666667 }}
      heightBounds={{ min: .3, max: 2.6, step: .05 }}
      onWidthChange={onWidthChange}
      onHeightChange={vi.fn()}
    />);

    const width = screen.getByRole("spinbutton", { name: "Width" });
    expect((width as HTMLInputElement).value).toBe("1.16666666667");
    expect(screen.getByRole("group", { name: "Width" }).contains(width)).toBe(true);

    fireEvent.blur(width);
    expect(onWidthChange).toHaveBeenLastCalledWith(1.16666666667);
  });
});
