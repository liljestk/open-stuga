import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderPage } from "./SensorManagementPageTestSupport";

describe("sensor inventory filters", () => {
  it("filters sensors by model as a sensor type", async () => {
    const user = userEvent.setup();
    renderPage();

    const inventory = screen.getByRole("heading", { name: "Sensors in Pine House" }).closest("section")!;
    const typeFilter = within(inventory).getByRole("combobox", { name: "Sensor type" });

    expect(within(typeFilter).getByRole("option", { name: "Tapo T310" })).not.toBeNull();
    expect(within(typeFilter).getByRole("option", { name: "Tapo T315" })).not.toBeNull();

    await user.selectOptions(typeFilter, "Tapo T315");

    expect(within(inventory).getByRole("button", { name: "View data for Living room" })).not.toBeNull();
    expect(within(inventory).queryByRole("button", { name: "View data for Kitchen" })).toBeNull();

    await user.selectOptions(typeFilter, "");

    expect(within(inventory).getByRole("button", { name: "View data for Kitchen" })).not.toBeNull();
  });
});
