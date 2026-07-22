import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
