import { fireEvent, render, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MaintenanceTask } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { MaintenancePage } from "./MaintenancePage";

function handlers() {
  return {
    onCreateTask: vi.fn(),
    onUpdateTask: vi.fn(),
    onReloadTask: vi.fn(),
    onLoadTaskRevisions: vi.fn(),
  };
}

describe("MaintenancePage scope", () => {
  it("defaults new work to the Home when opened from a Home route", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    render(
      <I18nProvider>
        <MaintenancePage
          state={state}
          house={house}
          propertyId={house.propertyId}
          houses={state.houses}
          {...handlers()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Plan work" }));
    expect((screen.getByLabelText("Homes") as HTMLSelectElement).value).toBe(house.id);
  });

  it("keeps Whole property as the default on the Property route", () => {
    const state = createDemoState();
    const property = state.properties[0]!;
    render(
      <I18nProvider>
        <MaintenancePage
          state={state}
          propertyId={property.id}
          houses={state.houses}
          {...handlers()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Plan work" }));
    expect((screen.getByLabelText("Homes") as HTMLSelectElement).value).toBe("");
  });

  it("keeps retained work editable when its Home has been hidden", async () => {
    const state = createDemoState();
    const hiddenHouse = state.houses[0]!;
    const retainedTask: MaintenanceTask = {
      id: "task-hidden-home",
      propertyId: hiddenHouse.propertyId,
      houseId: hiddenHouse.id,
      floorId: hiddenHouse.floors[0]!.id,
      title: "Inspect retained service",
      description: null,
      basis: "scheduled",
      basisDetail: null,
      priority: "normal",
      plannedFor: null,
      dueBy: null,
      observationIds: [],
      status: "planned",
      completionNote: null,
      completedAt: null,
      verificationNote: null,
      verifiedAt: null,
      revision: 1,
      createdAt: "2026-07-01T08:00:00.000Z",
      updatedAt: "2026-07-01T08:00:00.000Z",
    };
    const onUpdateTask = vi.fn().mockResolvedValue(retainedTask);

    render(
      <I18nProvider>
        <MaintenancePage
          state={{ ...state, houses: [], observations: [], maintenanceTasks: [retainedTask] }}
          propertyId={hiddenHouse.propertyId}
          houses={[]}
          {...handlers()}
          onUpdateTask={onUpdateTask}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Hidden Home")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Inspect retained service/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit work" }));
    const homeSelect = screen.getByLabelText("Homes") as HTMLSelectElement;
    expect(homeSelect.value).toBe(hiddenHouse.id);
    expect(homeSelect.selectedOptions[0]?.textContent).toBe("Hidden Home");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith(retainedTask.id, expect.objectContaining({
      houseId: hiddenHouse.id,
      floorId: hiddenHouse.floors[0]!.id,
    })));
  });
});
