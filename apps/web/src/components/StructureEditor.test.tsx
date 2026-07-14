import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { StructureEditor } from "./StructureEditor";

describe("StructureEditor", () => {
  it("adds typed levels and protects levels that still contain sensors", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const onHouseChange = vi.fn();
    const onFloorSelect = vi.fn();
    render(
      <I18nProvider>
        <StructureEditor
          houses={state.houses} house={house} floor={floor} sensors={state.sensors}
          onHouseSelect={vi.fn()} onFloorSelect={onFloorSelect} onHouseChange={onHouseChange}
        />
      </I18nProvider>,
    );

    expect((screen.getByRole("button", { name: "Delete level" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Add level" }));
    const name = screen.getAllByLabelText("Level name").find((item) => item.closest("form"))!;
    const form = name.closest("form")!;
    await user.selectOptions(within(form).getByLabelText("Level type"), "attic");
    await user.clear(name);
    await user.type(name, "Roof studio");
    await user.click(within(form).getByRole("button", { name: "Add level" }));

    expect(onHouseChange).toHaveBeenCalledOnce();
    const created = onHouseChange.mock.calls[0]![0].floors.at(-1)!;
    expect(created).toMatchObject({ name: "Roof studio", type: "attic", ceilingHeight: 2.4 });
    expect(onFloorSelect).toHaveBeenCalledWith(created.id);
  });

  it("switches between multiple properties and duplicates a selected level with fresh geometry ids", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const baseHouse = state.houses[0]!;
    const sourceFloor = baseHouse.floors[0]!;
    const house = {
      ...baseHouse,
      floors: [{
        ...sourceFloor,
        planElements: [{ id: "front-door", kind: "door" as const, position: { x: 200, y: 45 }, rotationDegrees: 0, wallId: sourceFloor.walls[0]!.id }],
      }, ...baseHouse.floors.slice(1)],
    };
    const second = { ...house, id: "house-lake", name: "Lake house" };
    const onHouseSelect = vi.fn();
    const onHouseChange = vi.fn();
    render(
      <I18nProvider>
        <StructureEditor
          houses={[house, second]} house={house} floor={house.floors[0]!} sensors={state.sensors}
          onHouseSelect={onHouseSelect} onFloorSelect={vi.fn()} onHouseChange={onHouseChange}
        />
      </I18nProvider>,
    );

    await user.selectOptions(screen.getByLabelText("Active house"), second.id);
    expect(onHouseSelect).toHaveBeenCalledWith(second.id);
    await user.click(screen.getByRole("button", { name: "Duplicate level" }));
    const duplicated = onHouseChange.mock.calls[0]![0].floors[1]!;
    expect(duplicated.id).not.toBe(house.floors[0]!.id);
    expect(duplicated.walls[0]!.id).not.toBe(house.floors[0]!.walls[0]!.id);
    expect(duplicated.planElements[0]!.id).not.toBe(house.floors[0]!.planElements![0]!.id);
    expect(duplicated.planElements[0]!.wallId).toBe(duplicated.walls[0]!.id);
    expect(duplicated.type).toBe("upper");
  });

  it("creates, renames, and deletes houses through explicit controls", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const created = { ...house, id: "house-lake", name: "Lake house", floors: [{ ...house.floors[0]!, id: "lake-main" }] };
    const onHouseCreate = vi.fn().mockResolvedValue(created);
    const onHouseSelect = vi.fn();
    const onFloorSelect = vi.fn();
    const onHouseChange = vi.fn();
    const onHouseSave = vi.fn().mockResolvedValue(undefined);
    const onHouseDelete = vi.fn().mockResolvedValue(undefined);

    const view = render(
      <I18nProvider>
        <StructureEditor
          houses={[house]} house={house} floor={house.floors[0]!} sensors={state.sensors}
          onHouseSelect={onHouseSelect} onFloorSelect={onFloorSelect} onHouseChange={onHouseChange}
          onHouseSave={onHouseSave} onHouseCreate={onHouseCreate} onHouseDelete={onHouseDelete}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Add another home before deleting this one.")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Add house" }));
    await user.type(screen.getByPlaceholderText("e.g. Lake house"), "Lake house");
    await user.click(within(screen.getByPlaceholderText("e.g. Lake house").closest("form")!).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onHouseCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Lake house" })));
    expect(onHouseSelect).toHaveBeenCalledWith(created.id);
    expect(onFloorSelect).toHaveBeenCalledWith(created.floors[0]!.id);

    fireEvent.change(screen.getByRole("textbox", { name: "House name" }), { target: { value: "Pine retreat" } });
    const renamed = onHouseChange.mock.calls.at(-1)![0];
    view.rerender(
      <I18nProvider>
        <StructureEditor
          houses={[renamed, created]} house={renamed} floor={renamed.floors[0]!} sensors={state.sensors}
          onHouseSelect={onHouseSelect} onFloorSelect={onFloorSelect} onHouseChange={onHouseChange}
          onHouseSave={onHouseSave} onHouseCreate={onHouseCreate} onHouseDelete={onHouseDelete}
        />
      </I18nProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(onHouseSave).toHaveBeenCalledWith(expect.objectContaining({ id: house.id, name: "Pine retreat" })));

    await user.click(screen.getByRole("button", { name: "Delete house" }));
    expect(screen.getByText("Delete Pine retreat and all of its local data?")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete house" }));
    await waitFor(() => expect(onHouseDelete).toHaveBeenCalledWith(house.id));
  });
});
