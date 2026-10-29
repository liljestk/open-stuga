import { screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import type { TpLinkDiscoveredDevice } from "@climate-twin/contracts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { confirmAction } from "../components/ConfirmationProvider";

import { createDemoState } from "../domain";

import { I18nProvider } from "../i18n";

import { SensorManagementPage } from "./SensorManagementPage";

import { discoveredDevice, expectDescribedError, renderPage } from "./SensorManagementPageTestSupport";

vi.mock("../components/ConfirmationProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ConfirmationProvider")>();
  return { ...actual, confirmAction: vi.fn().mockResolvedValue(true) };
});

beforeEach(() => vi.mocked(confirmAction).mockReset().mockResolvedValue(true));

afterEach(() => vi.restoreAllMocks());

describe("sensor onboarding and management", () => {
  it("labels a direct electricity endpoint and shows its available readings", async () => {
    const user = userEvent.setup();
    const energyDevice: TpLinkDiscoveredDevice = {
      ...discoveredDevice,
      deviceId: "tapo-plug-laundry",
      model: "P110",
      alias: "Laundry plug",
      temperature: null,
      humidity: null,
      battery: null,
      power: 428.5,
      energy: 12.34,
    };
    renderPage({ tpLinkDevices: [energyDevice] });

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    expect(screen.getByRole("button", { name: /Laundry plug.*P110.*Energy endpoint.*tapo-plug-laundry.*Power 428\.5 W.*Total 12\.34 kWh.*online/i })).not.toBeNull();
  });

  it("guides a non-technical user from a CSV file to a validated history import", async () => {
    const user = userEvent.setup();
    const onImportHistoricalData = vi.fn().mockResolvedValue({ submitted: 2, accepted: 2, ignoredDuplicates: 0 });
    const rendered = renderPage({ onImportHistoricalData });

    await user.click(screen.getByText("Manage sensors & connections"));
    await user.click(screen.getByRole("button", { name: "Import history" }));
    expect(await screen.findByRole("heading", { name: "Choose your file" })).not.toBeNull();
    const file = new File([
      "Date and time,Sensor,Temperature (°C),Humidity (%)\n2026-01-15 08:00,Living room,21.5,45",
    ], "home-history.csv", { type: "text/csv" });
    const input = rendered.container.ownerDocument.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(input!, file);

    expect(await screen.findByRole("heading", { name: "Match your columns" })).not.toBeNull();
    expect(screen.getByText("home-history.csv")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Review data" }));

    expect(screen.getByRole("heading", { name: "Check your data" })).not.toBeNull();
    expect(screen.getByText("measurements ready").closest("div")?.textContent).toBe("2measurements ready");
    await user.click(screen.getByRole("button", { name: "Import 2 measurements" }));

    await waitFor(() => expect(onImportHistoricalData).toHaveBeenCalledTimes(1));
    expect(onImportHistoricalData.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ sensorId: "sensor-living", metric: "temperature", value: 21.5, source: "import" }),
      expect.objectContaining({ sensorId: "sensor-living", metric: "humidity", value: 45, source: "import" }),
    ]);
    expect(await screen.findByRole("heading", { name: "History imported" })).not.toBeNull();
    expect(screen.getByText("2 new measurements were added to Pine House.")).not.toBeNull();
  });

  it("adds a discovered TP-Link sensor through all four setup steps", async () => {
    const user = userEvent.setup();
    const { props } = renderPage();

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    expect(screen.getByRole("heading", { name: "Choose a source" })).not.toBeNull();

    const device = screen.getByRole("button", { name: /Office window.*T315.*tapo-child-office.*online/i });
    await user.click(device);
    expect(device.getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Sensor details" })).not.toBeNull();
    expect((screen.getByRole("textbox", { name: "Sensor name" }) as HTMLInputElement).value).toBe("Office window");
    expect((screen.getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("T315");

    await user.selectOptions(screen.getByRole("combobox", { name: "Floor" }), "floor-upper");
    const room = screen.getByRole("combobox", { name: "Room" });
    await user.clear(room);
    await user.type(room, "Office");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Place sensor" })).not.toBeNull();

    const x = screen.getByRole("spinbutton", { name: "X position" });
    const y = screen.getByRole("spinbutton", { name: "Y position" });
    const height = screen.getByRole("spinbutton", { name: "Mounting height" });
    await user.clear(x);
    await user.type(x, "812.5");
    await user.clear(y);
    await user.type(y, "205.25");
    await user.clear(height);
    await user.type(height, "1.8");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const reviewHeading = screen.getByRole("heading", { name: "Review sensor" });
    expect(reviewHeading).not.toBeNull();
    const review = reviewHeading.closest("section");
    expect(review).not.toBeNull();
    expect(within(review!).getByText("tapo-child-office")).not.toBeNull();
    await user.click(within(review!).getByRole("button", { name: "Add sensor" }));

    await waitFor(() => expect(props.onCreateSensor).toHaveBeenCalledTimes(1));
    expect(props.onCreateSensor).toHaveBeenCalledWith({
      houseId: "house-pine",
      floorId: "floor-upper",
      name: "Office window",
      roomId: "r-office",
      room: "Office",
      model: "T315",
      x: 812.5,
      y: 205.25,
      z: 4.8,
      tags: [],
      enabled: true,
      tpLinkDeviceId: "tapo-child-office",
    });
    expect(await screen.findByText("Office window was added.")).not.toBeNull();
  });

  it("attaches a discovered direct device to its existing Home Assistant sensor", async () => {
    const user = userEvent.setup();
    const { props } = renderPage();

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    await user.click(screen.getByRole("button", { name: /Office window.*tapo-child-office.*online/i }));
    expect(screen.getByText("Already connected through Home Assistant?")).not.toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Existing Stugu sensor" }), "sensor-office");
    await user.click(screen.getByRole("button", { name: "Attach to existing sensor" }));

    expect(screen.getByRole("heading", { name: "Edit Office" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(props.onUpdateSensor).toHaveBeenCalledTimes(1));
    expect(props.onUpdateSensor).toHaveBeenCalledWith("sensor-office", expect.objectContaining({
      tpLinkDeviceId: "tapo-child-office",
    }));
    expect(props.onCreateSensor).not.toHaveBeenCalled();
  });

  it("offers and applies an experimental coverage-aware placement suggestion", async () => {
    const user = userEvent.setup();
    const rendered = renderPage();

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    await user.click(screen.getByRole("radio", { name: /Set up manually/i }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByRole("textbox", { name: "Sensor name" }), "Coverage probe");
    await user.type(screen.getByRole("textbox", { name: "Model" }), "TH review");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const suggestion = screen.getByRole("region", { name: "Suggested placement" });
    expect(within(suggestion).getByText(/fresh temperature/i)).not.toBeNull();
    const placementMap = screen.getByRole("group", { name: "Placement map for Ground floor" });
    expect(placementMap.querySelectorAll(".sensor-placement-coverage ellipse").length).toBeGreaterThan(0);
    expect(placementMap.querySelector(".sensor-placement-target")).not.toBeNull();

    await user.click(within(suggestion).getByRole("button", { name: "Use this position" }));

    expect((screen.getByRole("spinbutton", { name: "Mounting height" }) as HTMLInputElement).value).toBe("1.26");
    expect((within(suggestion).getByRole("button", { name: "Suggested position selected" }) as HTMLButtonElement).disabled).toBe(true);
    expect(rendered.container.querySelector(".sensor-placement-target")).not.toBeNull();
  });

  it("opens a notification-selected device at home and room assignment", async () => {
    const onRequestedDeviceHandled = vi.fn();
    renderPage({
      requestedDeviceId: discoveredDevice.deviceId,
      onRequestedDeviceHandled,
    });

    const heading = await screen.findByRole("heading", { name: "Sensor details" });
    const editor = heading.closest<HTMLElement>(".sensor-editor-card");
    expect(editor).not.toBeNull();
    expect((within(editor!).getByRole("textbox", { name: "Sensor name" }) as HTMLInputElement).value).toBe("Office window");
    expect((within(editor!).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("T315");
    expect((within(editor!).getByRole("combobox", { name: "Home" }) as HTMLSelectElement).value).toBe("house-pine");
    expect((within(editor!).getByRole("combobox", { name: "Floor" }) as HTMLSelectElement).value).toBe("floor-ground");
    expect(within(editor!).getByRole("combobox", { name: "Room" })).not.toBeNull();
    expect(onRequestedDeviceHandled).toHaveBeenCalledOnce();
  });

  it("opens placement for a just-saved energy device before its first live inventory arrives", async () => {
    const user = userEvent.setup();
    const onRequestedDeviceHandled = vi.fn();
    renderPage({
      tpLinkDevices: [],
      requestedDevice: {
        deviceId: "p115-water-heater",
        connectionId: "water-heater-connection",
        model: "P115",
        alias: "Water heater",
        deviceType: "energy",
      },
      onRequestedDeviceHandled,
    });

    const detailsHeading = await screen.findByRole("heading", { name: "Sensor details" });
    const editor = detailsHeading.closest<HTMLElement>(".sensor-editor-card")!;
    expect((within(editor).getByRole("textbox", { name: "Sensor name" }) as HTMLInputElement).value).toBe("Water heater");
    expect((within(editor).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("P115");
    await user.click(within(editor).getByRole("button", { name: "Continue" }));
    expect(await within(editor).findByRole("heading", { name: "Place sensor" })).not.toBeNull();
    expect(within(editor).getByRole("group", { name: /Placement map/ })).not.toBeNull();
    expect(onRequestedDeviceHandled).toHaveBeenCalledOnce();
  });

  it("shows discovered sensors as a direct setup action", async () => {
    const user = userEvent.setup();
    const secondDevice: TpLinkDiscoveredDevice = {
      ...discoveredDevice,
      deviceId: "tapo-child-bedroom",
      alias: "Bedroom sensor",
    };
    renderPage({ tpLinkDevices: [discoveredDevice, secondDevice] });

    const ready = screen.getByRole("region", { name: "2 new TP-Link sensors found" });
    expect(within(ready).getByText("Office window · T315, plus 1 more. Choose where they belong.")).not.toBeNull();
    await user.click(within(ready).getByRole("button", { name: "Choose home & room" }));

    const editor = await screen.findByRole("heading", { name: "Sensor details" });
    const panel = editor.closest<HTMLElement>(".sensor-editor-card")!;
    expect((within(panel).getByRole("textbox", { name: "Sensor name" }) as HTMLInputElement).value).toBe("Office window");
    expect((within(panel).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("T315");
  });

  it("never offers a TP-Link device assigned to a different Home", async () => {
    const user = userEvent.setup();
    const siblingDevice: TpLinkDiscoveredDevice = {
      ...discoveredDevice,
      houseId: "house-sibling",
      deviceId: "tapo-child-sibling",
      alias: "Sibling bedroom",
    };
    renderPage({ tpLinkDevices: [discoveredDevice, siblingDevice] });

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    expect(screen.getByRole("button", { name: /Office window.*tapo-child-office/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Sibling bedroom.*tapo-child-sibling/i })).toBeNull();
    expect(screen.queryByText("tapo-child-sibling")).toBeNull();
  });

  it("keeps healthy automatic discovery available in a closed management disclosure", async () => {
    const user = userEvent.setup();
    renderPage();

    const management = screen.getByText("Manage sensors & connections").closest("details");
    expect(management?.open).toBe(false);
    await user.click(screen.getByText("Manage sensors & connections"));
    const status = screen.getByRole("region", { name: "Automatic sensor discovery status" });
    expect(within(status).getByText("Connected")).not.toBeNull();
    expect(within(status).getByText(/Automatic hub checks are active\. Last checked/)).not.toBeNull();
    expect(within(status).getByRole("button", { name: "Refresh devices" })).not.toBeNull();
  });

  it("keeps owner-only integrations and imports out of an editable shared Home", async () => {
    const user = userEvent.setup();
    renderPage({ localAuthority: false });

    expect(screen.queryByRole("region", { name: "Automatic sensor discovery status" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import history" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    expect(screen.queryByText("Discovered TP-Link device")).toBeNull();
    expect(screen.getByRole("radio", { name: /Set up manually/i })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByText("Home Assistant measurement entities")).toBeNull();
  });

  it("explains that an unavailable hub is retried automatically", () => {
    const state = createDemoState();
    renderPage({
      integration: {
        ...state.integration,
        tpLink: {
          configured: true,
          connected: false,
          lastPollAt: "2026-07-14T12:00:00.000Z",
          mappedDevices: 0,
          discoveredDevices: 1,
          hubModel: "H200",
          error: "TP-Link connection failed: hub unavailable",
        },
      },
    });

    const status = screen.getByRole("region", { name: "Automatic sensor discovery status" });
    expect(within(status).getByText("Reconnecting to the TP-Link hub")).not.toBeNull();
    expect(within(status).getByText("Stugu keeps retrying automatically. Sensor checks resume as soon as the connection is restored.")).not.toBeNull();
    expect(status.querySelector(".sensor-discovery-watch-icon .spin")).not.toBeNull();
  });

  it("restores focus after closing inline sensor setup and history import", async () => {
    const user = userEvent.setup();
    renderPage();

    const addButton = screen.getByRole("button", { name: "Add sensor" });
    await user.click(addButton);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a source" })));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(addButton));

    await user.click(screen.getByText("Manage sensors & connections"));
    const importButton = screen.getByRole("button", { name: "Import history" });
    await user.click(importButton);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose your file" })));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(importButton));
  });

  it("validates a manual sensor before adding it without a device binding", async () => {
    const user = userEvent.setup();
    const { props } = renderPage();

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    await user.click(screen.getByRole("radio", { name: /Set up manually/i }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const name = screen.getByRole("textbox", { name: "Sensor name" });
    const model = screen.getByRole("textbox", { name: "Model" });
    const room = screen.getByRole("combobox", { name: "Room" });
    await user.clear(room);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("heading", { name: "Sensor details" })).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Check the highlighted fields before continuing.");
    expectDescribedError(name, "Enter a sensor name.");
    expectDescribedError(model, "Enter a sensor model.");
    expectDescribedError(room, "Enter or choose a room.");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(props.onCreateSensor).not.toHaveBeenCalled();

    await user.type(name, "Workshop probe");
    await user.type(model, "Custom TH-1");
    await user.type(room, "Workshop");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const x = screen.getByRole("spinbutton", { name: "X position" });
    const y = screen.getByRole("spinbutton", { name: "Y position" });
    const height = screen.getByRole("spinbutton", { name: "Mounting height" });
    await user.clear(x);
    await user.type(x, "1001");
    await user.clear(y);
    await user.type(y, "641");
    await user.clear(height);
    await user.type(height, "-1");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("heading", { name: "Place sensor" })).not.toBeNull();
    expectDescribedError(x, "Enter an X position from 0 to 1000.");
    expectDescribedError(y, "Enter a Y position from 0 to 640.");
    expectDescribedError(height, "Enter a mounting height of 0 or more.");
    expect(props.onCreateSensor).not.toHaveBeenCalled();

    await user.clear(x);
    await user.type(x, "15.2");
    await user.clear(y);
    await user.type(y, "25.3");
    await user.clear(height);
    await user.type(height, "1.6");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const review = screen.getByRole("heading", { name: "Review sensor" }).closest("section");
    expect(review).not.toBeNull();
    await user.click(within(review!).getByRole("button", { name: "Add sensor" }));

    await waitFor(() => expect(props.onCreateSensor).toHaveBeenCalledTimes(1));
    expect(props.onCreateSensor).toHaveBeenCalledWith({
      houseId: "house-pine",
      floorId: "floor-ground",
      name: "Workshop probe",
      roomId: null,
      room: "Workshop",
      model: "Custom TH-1",
      x: 15.2,
      y: 25.3,
      z: 1.6,
      tags: [],
      enabled: true,
    });
  }, 10_000);

  it("edits a sensor name, room, floor, and exact placement", async () => {
    const user = userEvent.setup();
    const { props } = renderPage();

    await user.click(screen.getByRole("button", { name: "View data for Living room" }));
    await user.click(screen.getByRole("button", { name: "Edit Living room" }));
    expect(screen.getByRole("heading", { name: "Edit Living room" })).not.toBeNull();

    const name = screen.getByRole("textbox", { name: "Sensor name" });
    await user.clear(name);
    await user.type(name, "Living window");
    await user.selectOptions(screen.getByRole("combobox", { name: "Floor" }), "floor-upper");

    const room = screen.getByRole("combobox", { name: "Room" });
    await user.clear(room);
    await user.type(room, "Window nook");
    await user.click(screen.getByText("Advanced placement and connection"));
    const x = screen.getByRole("spinbutton", { name: "X position" });
    const y = screen.getByRole("spinbutton", { name: "Y position" });
    const height = screen.getByRole("spinbutton", { name: "Mounting height" });
    await user.clear(x);
    await user.type(x, "730.4");
    await user.clear(y);
    await user.type(y, "180.2");
    await user.clear(height);
    await user.type(height, "1.7");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(props.onUpdateSensor).toHaveBeenCalledTimes(1));
    expect(props.onUpdateSensor).toHaveBeenCalledWith("sensor-living", {
      houseId: "house-pine",
      floorId: "floor-upper",
      name: "Living window",
      roomId: null,
      room: "Window nook",
      model: "Tapo T315",
      x: 730.4,
      y: 180.2,
      z: 4.7,
      enabled: true,
      tags: [],
      tpLinkDeviceId: null,
    });
    expect(await screen.findByText("Living window was updated.")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Edit Living room" })).toBeNull();
  });

  it("can remove an existing TP-Link binding without deleting the sensor", async () => {
    const user = userEvent.setup();
    const baseState = createDemoState();
    const state = {
      ...baseState,
      sensors: baseState.sensors.map((sensor) => sensor.id === "sensor-living"
        ? { ...sensor, tpLinkDeviceId: "tapo-child-living" }
        : sensor),
    };
    const boundDevice: TpLinkDiscoveredDevice = {
      ...discoveredDevice,
      deviceId: "tapo-child-living",
      alias: "Living room",
      mappedSensorId: "sensor-living",
    };
    const { props } = renderPage({ state, tpLinkDevices: [boundDevice] });

    await user.click(screen.getByRole("button", { name: "View data for Living room" }));
    await user.click(screen.getByRole("button", { name: "Edit Living room" }));
    await user.click(screen.getByText("Advanced placement and connection"));
    const binding = screen.getByRole("combobox", { name: /^TP-Link device binding/ });
    expect((binding as HTMLSelectElement).value).toBe("tapo-child-living");
    await user.selectOptions(binding, "");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(props.onUpdateSensor).toHaveBeenCalledTimes(1));
    expect(props.onUpdateSensor).toHaveBeenCalledWith(
      "sensor-living",
      expect.objectContaining({ tpLinkDeviceId: null }),
    );
    expect(await screen.findByText("Living room was updated.")).not.toBeNull();
  });

  it("archives and restores a sensor while preserving its identity", async () => {
    const user = userEvent.setup();
    const rendered = renderPage();

    await user.click(screen.getByRole("button", { name: "View data for Living room" }));
    await user.click(screen.getByRole("button", { name: "Archive Living room" }));
    await waitFor(() => expect(rendered.props.onUpdateSensor).toHaveBeenCalledWith("sensor-living", { enabled: false }));
    expect(await screen.findByText("Living room was archived. Its history is preserved.")).not.toBeNull();

    const archivedState = {
      ...rendered.props.state,
      sensors: rendered.props.state.sensors.map((sensor) => sensor.id === "sensor-living"
        ? { ...sensor, enabled: false }
        : sensor),
    };
    vi.mocked(rendered.props.onUpdateSensor).mockClear();
    rendered.rerender(
      <I18nProvider>
        <SensorManagementPage {...rendered.props} state={archivedState} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Restore Living room" }));
    await waitFor(() => expect(rendered.props.onUpdateSensor).toHaveBeenCalledTimes(1));
    expect(rendered.props.onUpdateSensor).toHaveBeenCalledWith("sensor-living", { enabled: true });
    expect(await screen.findByText("Living room was restored.")).not.toBeNull();
  });

  it("permanently deletes a sensor only after confirmation", async () => {
    const user = userEvent.setup();
    const { props } = renderPage();

    await user.click(screen.getByRole("button", { name: "View data for Living room" }));
    await user.click(screen.getByRole("button", { name: "Delete Living room" }));

    expect(confirmAction).toHaveBeenCalledWith("Delete Living room permanently? Its sensor history and bindings will also be removed.", "Delete");
    await waitFor(() => expect(props.onDeleteSensor).toHaveBeenCalledWith("sensor-living"));
    expect(await screen.findByText("Living room and its sensor history were deleted.")).not.toBeNull();
  });

  it("offers an explicit bulk action for tagged demo sensors", async () => {
    const user = userEvent.setup();
    const base = createDemoState();
    const state = {
      ...base,
      sensors: base.sensors.slice(0, 2).map((sensor) => ({ ...sensor, tags: [...sensor.tags, "seeded"] })),
    };
    const onDeleteSensor = vi.fn().mockResolvedValue(undefined);
    renderPage({ state, onDeleteSensor });

    await user.click(screen.getByText("Manage sensors & connections"));
    await user.click(screen.getByRole("button", { name: "Remove demo sensors (2)" }));

    expect(confirmAction).toHaveBeenCalledWith("Remove all 2 demo sensors? Their generated history and bindings will be permanently deleted.", "Remove demo sensors");
    await waitFor(() => expect(onDeleteSensor).toHaveBeenCalledTimes(2));
    expect(onDeleteSensor.mock.calls.map(([sensorId]) => sensorId).sort()).toEqual(["sensor-kitchen", "sensor-living"]);
    expect(await screen.findByText("2 demo sensors and their generated history were removed.")).not.toBeNull();
  });

  it("offers to remove demo inventory after the first real bound sensor is added", async () => {
    const user = userEvent.setup();
    const base = createDemoState();
    const state = {
      ...base,
      sensors: base.sensors.slice(0, 2).map((sensor) => ({ ...sensor, tags: [...sensor.tags, "seeded"] })),
      integration: {
        ...base.integration,
        mock: { ...base.integration.mock, enabled: false, mode: "real" as const, activatedAt: "2026-07-16T08:00:00.000Z" },
      },
    };
    const onDeleteSensor = vi.fn().mockResolvedValue(undefined);
    renderPage({ state, integration: state.integration, onDeleteSensor });

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    await user.click(screen.getByRole("button", { name: /Office window.*T315.*tapo-child-office.*online/i }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const review = screen.getByRole("heading", { name: "Review sensor" }).closest("section")!;
    await user.click(within(review).getByRole("button", { name: "Add sensor" }));

    await waitFor(() => expect(onDeleteSensor).toHaveBeenCalledTimes(2));
    expect(confirmAction).toHaveBeenCalledWith("Remove all 2 demo sensors? Their generated history and bindings will be permanently deleted.", "Remove demo sensors");
    expect(await screen.findByText("Office window was added and 2 demo sensors were removed.")).not.toBeNull();
  });

  it("does not offer automatic demo cleanup while mock mode can still generate readings", async () => {
    const user = userEvent.setup();
    const base = createDemoState();
    const state = {
      ...base,
      sensors: base.sensors.slice(0, 2).map((sensor) => ({ ...sensor, tags: [...sensor.tags, "seeded"] })),
    };
    const onDeleteSensor = vi.fn().mockResolvedValue(undefined);
    renderPage({ state, integration: state.integration, onDeleteSensor });

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    await user.click(screen.getByRole("button", { name: /Office window.*T315.*tapo-child-office.*online/i }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const review = screen.getByRole("heading", { name: "Review sensor" }).closest("section")!;
    await user.click(within(review).getByRole("button", { name: "Add sensor" }));

    expect(await screen.findByText("Office window was added.")).not.toBeNull();
    expect(confirmAction).not.toHaveBeenCalled();
    expect(onDeleteSensor).not.toHaveBeenCalled();
  });

  it("distinguishes duplicate sensor names in accessible data actions", () => {
    const base = createDemoState();
    const live = base.sensors.find((sensor) => sensor.id === "sensor-living")!;
    const archived = { ...live, id: "sensor-living-archived", enabled: false };
    renderPage({ state: { ...base, sensors: [...base.sensors, archived] } });

    expect(screen.getByRole("button", { name: "View data for Living room · Live" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "View data for Living room · Archived" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "View data for Living room" })).toBeNull();
  });

  it("keeps a sensor live for the Home freshness window and names one that stopped reporting", () => {
    const base = createDemoState();
    const live = base.sensors.find((sensor) => sensor.id === "sensor-living")!;
    const silent = { ...live, id: "sensor-living-silent", name: "Silent room" };
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const withTimestamp = (sensorId: string, timestamp: string) => ({
      reading: { ...base.readings[live.id]!, sensorId, timestamp },
      measurements: Object.fromEntries(Object.entries(base.latestMeasurements[live.id] ?? {})
        .map(([metric, sample]) => [metric, { ...sample, sensorId, timestamp }])),
    });
    const recent = withTimestamp(live.id, at(12));
    const old = withTimestamp(silent.id, at(3 * 24 * 60));
    renderPage({
      state: {
        ...base,
        sensors: [...base.sensors, silent],
        readings: { ...base.readings, [live.id]: recent.reading, [silent.id]: old.reading },
        latestMeasurements: { ...base.latestMeasurements, [live.id]: recent.measurements, [silent.id]: old.measurements },
      },
    });

    const liveRow = screen.getByText("Living room", { selector: "strong" }).closest("li")!;
    expect(within(liveRow).getByText("Live")).not.toBeNull();
    const silentRow = screen.getByText("Silent room", { selector: "strong" }).closest("li")!;
    expect(within(silentRow).getByText("Not reporting")).not.toBeNull();
    expect(within(silentRow).queryByText("Waiting for data")).toBeNull();
  });
});
