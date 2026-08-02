import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Floor } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { definitionFor } from "../measurements";
import { ControlledFloorPlan, openFloorAddTools, withI18n } from "../regressionsTestSupport";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("FloorPlan pointer placement", () => {
  it("places walls and doors when randomUUID is unavailable on LAN HTTP", async () => {
    localStorage.setItem("climate-twin-locale", "en");
    let uuidSequence = 1;
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0);
        bytes[15] = uuidSequence;
        uuidSequence += 1;
        return bytes;
      },
    });

    const user = userEvent.setup();
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const onChange = vi.fn();
    const view = render(withI18n(
      <ControlledFloorPlan
        initialFloor={floor}
        definition={definitionFor(state.measurementDefinitions, "temperature")}
        onChange={onChange}
      />,
    ));
    const map = view.container.querySelector<SVGSVGElement>("svg.floor-plan")!;
    Object.defineProperty(map, "getScreenCTM", { configurable: true, value: () => null });
    Object.defineProperty(map, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, toJSON: () => ({}) }),
    });

    await openFloorAddTools(user);
    await user.click(screen.getByRole("button", { name: "Draw wall" }));
    fireEvent(map, new MouseEvent("pointerdown", { bubbles: true, clientX: 300, clientY: 500 }));
    fireEvent(map, new MouseEvent("pointermove", { bubbles: true, clientX: 600, clientY: 500 }));
    fireEvent(map, new MouseEvent("pointerdown", { bubbles: true, clientX: 600, clientY: 500 }));

    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    const wallFloor = onChange.mock.calls[0]![0] as Floor;
    expect(wallFloor.walls).toHaveLength(floor.walls.length + 1);
    expect(wallFloor.walls.at(-1)?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    await openFloorAddTools(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Element" }), "door");
    await user.click(screen.getByRole("button", { name: "Place element" }));
    const targetWall = floor.walls[0]!;
    const point = {
      x: (targetWall.from.x + targetWall.to.x) / 2,
      y: (targetWall.from.y + targetWall.to.y) / 2,
    };
    const clientX = point.x / floor.width * 1000;
    const clientY = point.y / floor.height * 1000;
    fireEvent(map, new MouseEvent("pointermove", { bubbles: true, clientX, clientY }));
    fireEvent(map, new MouseEvent("pointerdown", { bubbles: true, clientX, clientY }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    const elementFloor = onChange.mock.calls[1]![0] as Floor;
    const door = elementFloor.planElements?.at(-1);
    expect(door?.kind).toBe("door");
    expect(door?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(door?.id).not.toBe(wallFloor.walls.at(-1)?.id);
  });
});
