import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { StrictMode } from "react";

import userEvent from "@testing-library/user-event";

import type { DoorPlanElement } from "@climate-twin/contracts";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

import { I18nProvider } from "./i18n";

import { createDemoState } from "./domain";

import { useClimateData } from "./useClimateData";

import { api } from "./api";

import { ROUTE_READY_TIMEOUT_MS, findPageHeading, mockClimateData, renderApp } from "./AppTestSupport";

vi.mock("./useClimateData", () => ({ useClimateData: vi.fn() }));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.removeItem("stugu-dismissed-tp-link-device-notices");
  mockClimateData();
});

describe("Stugu app", () => {
  it("announces a discovered sensor across the app and opens its location step", async () => {
    const user = userEvent.setup();
    const climate = mockClimateData();
    const device = {
      houseId: "house-pine",
      deviceId: "tapo-child-office",
      model: "T315",
      alias: "Office window",
      status: "online",
      temperature: 21.4,
      humidity: 44,
      battery: 92,
      lastSeenAt: "2026-07-16T10:00:00.000Z",
      mappedSensorId: null,
    };
    climate.dataMode = "real";
    climate.tpLinkDevices = [device];
    climate.state = {
      ...climate.state,
      integration: {
        ...climate.state.integration,
        tpLink: {
          configured: true,
          connected: true,
          lastPollAt: "2026-07-16T10:00:00.000Z",
          mappedDevices: 0,
          discoveredDevices: 1,
          hubModel: "H200",
          error: null,
        },
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    renderApp();

    expect(await screen.findByText("New TP-Link sensor found")).not.toBeNull();
    expect(screen.getByText("Office window · T315 is ready. Choose its home, floor, and room.")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.queryByText("New TP-Link sensor found")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(await screen.findByText("New TP-Link sensor found")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Choose home & room" }));

    const heading = await screen.findByRole(
      "heading",
      { name: "Sensor details" },
      { timeout: ROUTE_READY_TIMEOUT_MS },
    );
    const editor = heading.closest<HTMLElement>(".sensor-editor-card");
    expect(editor).not.toBeNull();
    expect((within(editor!).getByRole("textbox", { name: "Sensor name" }) as HTMLInputElement).value).toBe("Office window");
    expect(within(editor!).getByRole("combobox", { name: "Home" })).not.toBeNull();
    expect(within(editor!).getByRole("combobox", { name: "Room" })).not.toBeNull();
    expect(screen.queryByText("New TP-Link sensor found")).toBeNull();
    await user.click(within(editor!).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Sensors" })));
  });

  it("announces a T110 as a contact sensor and opens the 2D opening picker", async () => {
    const user = userEvent.setup();
    const climate = mockClimateData();
    const door: DoorPlanElement = {
      id: "front-door",
      kind: "door",
      wallId: "g-o1",
      position: { x: 220, y: 45 },
      rotationDegrees: 0,
      width: 90,
      variant: "exterior",
      state: "closed",
      label: "Front door",
    };
    const house = {
      ...climate.state.houses[0]!,
      floors: climate.state.houses[0]!.floors.map((floor, index) => index === 0
        ? { ...floor, planElements: [door] }
        : floor),
    };
    const lastPollAt = "2026-07-16T10:00:00.000Z";
    climate.dataMode = "real";
    climate.tpLinkDevices = [{
      houseId: house.id,
      connectionId: "hall-hub",
      deviceId: "tapo-t110-entry",
      model: "T110",
      alias: "Entry contact",
      status: "online",
      temperature: null,
      humidity: null,
      battery: 92,
      contactOpen: false,
      deviceType: "contact",
      lastSeenAt: lastPollAt,
      mappedSensorId: null,
      mappedOpening: null,
    }];
    climate.state = {
      ...climate.state,
      houses: [house],
      integration: {
        ...climate.state.integration,
        tpLink: {
          configured: true,
          connected: true,
          lastPollAt,
          mappedDevices: 0,
          discoveredDevices: 1,
          hubModel: "H200",
          error: null,
        },
      },
    };
    vi.mocked(climate.updateHouse).mockResolvedValue(house);
    vi.mocked(useClimateData).mockReturnValue(climate);
    renderApp();

    expect(await screen.findByText("New door/window sensor found")).not.toBeNull();
    expect(screen.getByText("Entry contact · T110 is ready. Attach it to an opening in your floor plan.")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Choose door or window" }));

    expect(await screen.findByRole(
      "heading",
      { name: "Attach Entry contact" },
      { timeout: ROUTE_READY_TIMEOUT_MS },
    )).not.toBeNull();
    expect(screen.getByRole("group", { name: "Door and window picker for Ground floor" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Attach sensor" }));
    await waitFor(() => expect(climate.updateHouse).toHaveBeenCalledWith(house.id, expect.objectContaining({
      floors: expect.any(Array),
    })));
  });

  it("shows a new-sensor notice only while its assigned Home is selected", async () => {
    const user = userEvent.setup();
    const climate = mockClimateData();
    const mainHouse = climate.state.houses[0]!;
    const lakeHouse = { ...mainHouse, id: "house-lake", name: "Lake home" };
    const lastPollAt = "2026-07-16T10:00:00.000Z";
    climate.tpLinkDevices = [{
      houseId: lakeHouse.id,
      connectionId: "shared-hub-lake-assignment",
      deviceId: "tapo-child-lake",
      model: "T315",
      alias: "Lake bedroom",
      status: "online",
      temperature: 21,
      humidity: 44,
      battery: 92,
      lastSeenAt: lastPollAt,
      mappedSensorId: null,
    }];
    climate.state = {
      ...climate.state,
      houses: [mainHouse, lakeHouse],
      integration: {
        ...climate.state.integration,
        tpLink: {
          configured: true,
          connected: true,
          lastPollAt,
          mappedDevices: 0,
          discoveredDevices: 1,
          hubModel: null,
          error: null,
          connections: [
            { id: "shared-hub-main-assignment", houseId: mainHouse.id, configured: true, connected: true, lastPollAt, mappedDevices: 0, discoveredDevices: 0, hubModel: "H200", error: null },
            { id: "shared-hub-lake-assignment", houseId: lakeHouse.id, configured: true, connected: true, lastPollAt, mappedDevices: 0, discoveredDevices: 1, hubModel: "H200", error: null },
          ],
        },
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    renderApp();

    await findPageHeading("Your home, at a glance");
    expect(screen.queryByText("New TP-Link sensor found")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Home shown on this page"), lakeHouse.id);
    expect(await screen.findByText("New TP-Link sensor found")).not.toBeNull();
    expect(screen.getByText(/Lake bedroom/)).not.toBeNull();
  });

  it("does not announce a device absent from the latest hub snapshot", async () => {
    const climate = mockClimateData();
    climate.dataMode = "real";
    climate.tpLinkDevices = [{
      houseId: "house-pine",
      deviceId: "tapo-child-stale",
      model: "T315",
      alias: "Old sensor",
      status: "online",
      temperature: 20,
      humidity: 40,
      battery: 80,
      lastSeenAt: "2026-07-16T09:55:00.000Z",
      mappedSensorId: null,
    }];
    climate.state = {
      ...climate.state,
      integration: {
        ...climate.state.integration,
        tpLink: {
          configured: true,
          connected: true,
          lastPollAt: "2026-07-16T10:00:00.000Z",
          mappedDevices: 0,
          discoveredDevices: 1,
          hubModel: "H200",
          error: null,
        },
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    renderApp();

    await findPageHeading("Your home, at a glance");
    expect(screen.queryByText("New TP-Link sensor found")).toBeNull();
  });
});
