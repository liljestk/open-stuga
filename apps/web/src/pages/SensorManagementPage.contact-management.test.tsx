import axe from "axe-core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DoorPlanElement,
  OpeningStateObservation,
  Sensor,
  TpLinkDiscoveredDevice,
  WindowPlanElement,
} from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { createDemoState } from "../domain";
import { discoveredDevice, renderPage } from "./SensorManagementPageTestSupport";

afterEach(() => vi.restoreAllMocks());

function mappedContactFixture() {
  const base = createDemoState();
  const frontDoor: DoorPlanElement = {
    id: "front-door",
    kind: "door",
    wallId: "g-o1",
    position: { x: 220, y: 45 },
    rotationDegrees: 0,
    variant: "exterior",
    label: "Front door",
    stateBinding: {
      provider: "tapo",
      externalId: "tapo-t110-entry",
      connectionId: "tp-link-main",
    },
  };
  const kitchenWindow: WindowPlanElement = {
    id: "kitchen-window",
    kind: "window",
    wallId: "g-o1",
    position: { x: 760, y: 45 },
    rotationDegrees: 0,
    variant: "casement",
    label: "Kitchen window",
  };
  const ground = {
    ...base.houses[0]!.floors[0]!,
    planElements: [frontDoor, kitchenWindow],
  };
  const house = {
    ...base.houses[0]!,
    floors: [ground, ...base.houses[0]!.floors.slice(1)],
  };
  const contactDevice: TpLinkDiscoveredDevice = {
    ...discoveredDevice,
    connectionId: "tp-link-main",
    deviceId: "tapo-t110-entry",
    model: "Tapo T110",
    alias: "Entry contact",
    temperature: null,
    humidity: null,
    contactOpen: false,
    mappedSensorId: null,
    mappedOpening: {
      floorId: ground.id,
      elementId: frontDoor.id,
      kind: "door",
      label: frontDoor.label ?? null,
    },
  };
  return { base, frontDoor, kitchenWindow, ground, house, contactDevice };
}

describe("door and window sensor management", () => {
  it("shows transition stats and an open/closed timeline for a mapped contact", async () => {
    const user = userEvent.setup();
    const { base, frontDoor, ground, house, contactDevice } = mappedContactFixture();
    const now = Date.now();
    const observation = (
      id: string,
      hoursAgo: number,
      state: OpeningStateObservation["state"],
    ): OpeningStateObservation => ({
      id,
      houseId: house.id,
      floorId: ground.id,
      elementId: frontDoor.id,
      state,
      source: "tapo",
      observedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
      externalId: contactDevice.deviceId,
      ...(contactDevice.connectionId ? { connectionId: contactDevice.connectionId } : {}),
    });
    const history = [
      observation("seed-closed", 25, "closed"),
      observation("opened-morning", 20, "open"),
      observation("open-heartbeat", 19, "open"),
      observation("closed-midday", 10, "closed"),
      observation("opened-evening", 2, "open"),
    ];
    const openingHistory = vi.spyOn(api, "openingStateHistory").mockResolvedValue(history);
    renderPage({
      state: { ...base, houses: [house] },
      house,
      houses: [house],
      tpLinkDevices: [{ ...contactDevice, contactOpen: true }],
    });

    await user.click(screen.getByRole("button", { name: "View data for Entry contact" }));
    const details = await screen.findByRole("region", { name: "Open and closed timeline" });
    await waitFor(() => expect(openingHistory).toHaveBeenCalledWith(
      house.id,
      expect.any(String),
      expect.any(String),
      10_000,
      expect.any(AbortSignal),
    ));

    expect(screen.getByText("Openings").parentElement?.textContent).toBe("Openings2");
    expect(screen.getByText("Closings").parentElement?.textContent).toBe("Closings1");
    expect(within(details).getByRole("img", { name: /2 openings and 1 closings/i })).not.toBeNull();
    const recent = document.querySelector<HTMLElement>(".contact-history-events")!;
    expect(within(recent).getAllByText("Opened")).toHaveLength(2);
    expect(within(recent).getAllByText("Closed")).toHaveLength(1);
    const accessibility = await axe.run(document.querySelector<HTMLElement>(".contact-history-panel")!, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("lists a mapped contact as live and safely edits its assignment", async () => {
    const user = userEvent.setup();
    const { base, frontDoor, kitchenWindow, house, contactDevice } = mappedContactFixture();
    const onUpdateHouse = vi.fn().mockResolvedValue(house);
    renderPage({
      state: { ...base, houses: [house] },
      house,
      houses: [house],
      tpLinkDevices: [contactDevice],
      onUpdateHouse,
    });

    expect(screen.getByText("Entry contact")).not.toBeNull();
    expect(screen.getByText(/Tapo T110 · Door\/window sensor · Closed/)).not.toBeNull();
    expect(screen.getByRole("button", { name: new RegExp(`Live ${base.sensors.length + 1}`) })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit door/window" }));
    expect(await screen.findByRole("heading", { name: "Edit Entry contact" })).not.toBeNull();
    const openingList = screen.getByRole("group", { name: "Available doors and windows" });
    expect(within(openingList).getByRole("button", { name: /Front door.*Selected/i })).not.toBeNull();
    await user.click(within(openingList).getByRole("button", { name: /Kitchen window.*Available/i }));
    await user.click(screen.getByRole("button", { name: "Save assignment" }));

    await waitFor(() => expect(onUpdateHouse).toHaveBeenCalledTimes(1));
    const savedGround = (onUpdateHouse.mock.calls[0]![1].floors as typeof house.floors)[0]!;
    expect(savedGround.planElements!.find((element) => element.id === frontDoor.id))
      .not.toHaveProperty("stateBinding");
    expect(savedGround.planElements!.find((element) => element.id === kitchenWindow.id))
      .toMatchObject({
        stateBinding: {
          provider: "tapo",
          externalId: contactDevice.deviceId,
          connectionId: contactDevice.connectionId,
        },
      });
  });

  it("shows an archived T110 as a migrated contact instead of a temperature sensor", async () => {
    const user = userEvent.setup();
    const { base, ground, house, contactDevice } = mappedContactFixture();
    const {
      tpLinkDeviceId: _tpLinkDeviceId,
      tpLinkConnectionId: _tpLinkConnectionId,
      ...legacySensorTemplate
    } = base.sensors[0]!;
    const legacyContactSensor: Sensor = {
      ...legacySensorTemplate,
      id: "sensor-t110-legacy",
      houseId: house.id,
      floorId: ground.id,
      name: "Entry contact T110",
      model: "T110",
      enabled: false,
    };
    const measurementPage = vi.spyOn(api, "sensorMeasurementPage");
    renderPage({
      state: { ...base, houses: [house], sensors: [...base.sensors, legacyContactSensor] },
      house,
      houses: [house],
      tpLinkDevices: [contactDevice],
    });

    await user.click(screen.getByRole("button", { name: "View data for Entry contact T110" }));
    const details = document.querySelector<HTMLElement>(".sensor-details-panel")!;
    expect(within(details).getByText("Archived legacy record")).not.toBeNull();
    expect(within(details).getByText("Front door")).not.toBeNull();
    expect(within(details).getByText(/old climate-style record/i)).not.toBeNull();
    expect(within(details).queryByRole("combobox", { name: "Measurement" })).toBeNull();
    expect(within(details).queryByText("Temperature")).toBeNull();
    expect(measurementPage).not.toHaveBeenCalled();
    expect(within(details).getByRole("button", { name: "Edit door/window" })).not.toBeNull();
  });
});
