import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { createDemoState } from "../domain";
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

  it("presents the generated Wilfa sensor as integration-managed telemetry", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const sensor = {
      ...state.sensors[0]!,
      id: "sensor-gree-aabbccddeeff",
      name: "Nordkapp",
      model: "Wilfa Nordkapp 30",
      tags: ["integration:gree", "equipment:heat-pump"],
    };
    state.sensors = [sensor];
    state.latestMeasurements[sensor.id] = {
      humidity: {
        sensorId: sensor.id,
        metric: "humidity",
        value: 48,
        canonicalUnit: "%",
        timestamp: "2026-07-14T12:00:00.000Z",
        source: "gree",
        quality: "good",
      },
    };
    renderPage({ state, house: state.houses[0]!, houses: state.houses });

    expect(screen.getByText(/Gree \/ Wilfa connection/u)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "View data for Nordkapp" }));

    expect(screen.getByText(/Readings, history, and placement are managed/u)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
