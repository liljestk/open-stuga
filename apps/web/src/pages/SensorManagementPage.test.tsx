import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Sensor, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { SensorManagementPage } from "./SensorManagementPage";

const discoveredDevice: TpLinkDiscoveredDevice = {
  houseId: "house-pine",
  deviceId: "tapo-child-office",
  model: "T315",
  alias: "Office window",
  status: "online",
  temperature: 21.4,
  humidity: 44,
  battery: 92,
  lastSeenAt: "2026-07-14T12:00:00.000Z",
  mappedSensorId: null,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPage(overrides: Partial<React.ComponentProps<typeof SensorManagementPage>> = {}) {
  localStorage.setItem("climate-twin-locale", "en");
  const state = createDemoState();
  const house = state.houses[0]!;
  const props: React.ComponentProps<typeof SensorManagementPage> = {
    state,
    house,
    houses: state.houses,
    integration: { ...state.integration, tpLink: {
      configured: true,
      connected: true,
      lastPollAt: "2026-07-14T12:00:00.000Z",
      mappedDevices: 0,
      discoveredDevices: 1,
      hubModel: "H200",
      error: null,
    } },
    tpLinkDevices: [discoveredDevice],
    tpLinkDevicesLoading: false,
    tpLinkDevicesError: null,
    onHouse: vi.fn(),
    onRefreshDevices: vi.fn().mockResolvedValue([discoveredDevice]),
    onCreateSensor: vi.fn().mockImplementation(async (input) => ({ ...input, id: "sensor-created" })),
    onUpdateSensor: vi.fn().mockImplementation(async (id, patch) => {
      const current = state.sensors.find((sensor) => sensor.id === id);
      if (!current) throw new Error("Sensor not found");
      const updated = { ...current, ...patch } as Sensor;
      if (patch.tpLinkDeviceId === null) delete updated.tpLinkDeviceId;
      return updated;
    }),
    onDeleteSensor: vi.fn().mockResolvedValue(undefined),
    onImportHistoricalData: vi.fn().mockResolvedValue({ submitted: 0, accepted: 0, ignoredDuplicates: 0 }),
    ...overrides,
  };

  return {
    ...render(<I18nProvider><SensorManagementPage {...props} /></I18nProvider>),
    props,
  };
}

function expectDescribedError(control: HTMLElement, message: string) {
  expect(control.getAttribute("aria-invalid")).toBe("true");
  const descriptionId = control.getAttribute("aria-describedby");
  expect(descriptionId).not.toBeNull();
  expect(document.getElementById(descriptionId!)?.textContent).toBe(message);
}

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
    expect(screen.getByText("TP-Link hub or one direct energy device")).not.toBeNull();
  });

  it("guides a non-technical user from a CSV file to a validated history import", async () => {
    const user = userEvent.setup();
    const onImportHistoricalData = vi.fn().mockResolvedValue({ submitted: 2, accepted: 2, ignoredDuplicates: 0 });
    const rendered = renderPage({ onImportHistoricalData });

    await user.click(screen.getAllByText("Import history").find((item) => item.closest("summary"))!);
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

  it("shows that automatic hub discovery is active even between list refreshes", () => {
    renderPage();

    const status = screen.getByRole("region", { name: "Automatic sensor discovery status" });
    expect(within(status).getByText("Looking for new TP-Link sensors")).not.toBeNull();
    expect(within(status).getByText(/Automatic hub checks are active\. Last checked/)).not.toBeNull();
    expect(within(status).getByRole("button", { name: "Refresh device list" })).not.toBeNull();
  });

  it("restores focus after closing inline sensor setup and history import", async () => {
    const user = userEvent.setup();
    renderPage();

    const addButton = screen.getByRole("button", { name: "Add sensor" });
    await user.click(addButton);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a source" })));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(addButton));

    await user.click(screen.getAllByText("Import history").find((item) => item.closest("summary"))!);
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
  });

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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { props } = renderPage();

    await user.click(screen.getByRole("button", { name: "View data for Living room" }));
    await user.click(screen.getByRole("button", { name: "Delete Living room" }));

    expect(confirm).toHaveBeenCalledWith("Delete Living room permanently? Its sensor history and bindings will also be removed.");
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage({ state, onDeleteSensor });

    await user.click(screen.getByRole("button", { name: "Remove demo sensors (2)" }));

    expect(confirm).toHaveBeenCalledWith("Remove all 2 demo sensors? Their generated history and bindings will be permanently deleted.");
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage({ state, integration: state.integration, onDeleteSensor });

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    await user.click(screen.getByRole("button", { name: /Office window.*T315.*tapo-child-office.*online/i }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const review = screen.getByRole("heading", { name: "Review sensor" }).closest("section")!;
    await user.click(within(review).getByRole("button", { name: "Add sensor" }));

    await waitFor(() => expect(onDeleteSensor).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledWith("Remove all 2 demo sensors? Their generated history and bindings will be permanently deleted.");
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage({ state, integration: state.integration, onDeleteSensor });

    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    await user.click(screen.getByRole("button", { name: /Office window.*T315.*tapo-child-office.*online/i }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const review = screen.getByRole("heading", { name: "Review sensor" }).closest("section")!;
    await user.click(within(review).getByRole("button", { name: "Add sensor" }));

    expect(await screen.findByText("Office window was added.")).not.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(onDeleteSensor).not.toHaveBeenCalled();
  });

  it("binds every enabled electricity measurement to a Home Assistant entity", async () => {
    const user = userEvent.setup();
    const base = createDemoState();
    const template = base.measurementDefinitions[0]!;
    const electricityDefinitions = [
      { ...template, id: "power", labels: { en: "Power" }, unit: "W", builtin: false },
      { ...template, id: "energy", labels: { en: "Energy" }, unit: "kWh", builtin: false },
      { ...template, id: "electricity_price", labels: { en: "Electricity spot price" }, unit: "EUR/kWh", builtin: false },
      { ...template, id: "voltage", labels: { en: "Voltage" }, unit: "V", builtin: false, enabled: false },
    ];
    const state = {
      ...base,
      measurementDefinitions: [
        ...base.measurementDefinitions.filter((definition) => !electricityDefinitions.some((candidate) => candidate.id === definition.id)),
        ...electricityDefinitions,
      ],
    };
    const rendered = renderPage({ state });

    await user.click(screen.getByRole("button", { name: "View data for Living room" }));
    await user.click(screen.getByRole("button", { name: "Edit Living room" }));
    await user.click(screen.getByText("Advanced placement and connection"));
    await user.type(screen.getByRole("textbox", { name: "Power Home Assistant entity ID" }), "sensor.house_power");
    await user.type(screen.getByRole("textbox", { name: "Energy Home Assistant entity ID" }), "sensor.house_energy");
    await user.type(screen.getByRole("textbox", { name: "Electricity spot price Home Assistant entity ID" }), "sensor.nordpool_price");
    expect(screen.queryByRole("textbox", { name: "Voltage Home Assistant entity ID" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(rendered.props.onUpdateSensor).toHaveBeenCalledTimes(1));
    expect(rendered.props.onUpdateSensor).toHaveBeenCalledWith("sensor-living", expect.objectContaining({
      measurementEntityIds: expect.objectContaining({
        power: "sensor.house_power",
        energy: "sensor.house_energy",
        electricity_price: "sensor.nordpool_price",
      }),
    }));
  });

  it("keeps failed edits open, exposes the server error, and retries discovery", async () => {
    const user = userEvent.setup();
    const onUpdateSensor = vi.fn().mockRejectedValue(new Error("Sensor service is unavailable"));
    const onRefreshDevices = vi.fn()
      .mockRejectedValueOnce(new Error("Hub discovery timed out"))
      .mockResolvedValueOnce(undefined);
    renderPage({ onUpdateSensor, onRefreshDevices });

    await user.click(screen.getByRole("button", { name: "View data for Kitchen" }));
    await user.click(screen.getByRole("button", { name: "Edit Kitchen" }));
    const name = screen.getByRole("textbox", { name: "Sensor name" });
    await user.clear(name);
    await user.type(name, "Kitchen north");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Sensor service is unavailable")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Edit Kitchen" })).not.toBeNull();
    expect((screen.getByRole("textbox", { name: "Sensor name" }) as HTMLInputElement).value).toBe("Kitchen north");

    await user.click(screen.getByText("Device discovery"));
    await user.click(screen.getByRole("button", { name: "Refresh devices" }));
    expect(await screen.findByText("Hub discovery timed out")).not.toBeNull();
    expect(onRefreshDevices).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Refresh devices" }));
    await waitFor(() => {
      expect(onRefreshDevices).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Hub discovery timed out")).toBeNull();
    });
    expect(screen.getByText("Sensor service is unavailable")).not.toBeNull();
  });

  it("uses exclusive urgency buckets as direct inventory filters", async () => {
    const user = userEvent.setup();
    const base = createDemoState();
    const currentHouse = base.houses[0]!;
    const live = base.sensors.find((sensor) => sensor.houseId === currentHouse.id && sensor.enabled && !sensor.tags.includes("unplaced"))!;
    const sensors: Sensor[] = [
      { ...live, name: "Live sensor" },
      { ...live, id: "sensor-waiting", name: "Waiting sensor" },
      { ...live, id: "sensor-unplaced", name: "Unplaced sensor", tags: [...live.tags, "unplaced"] },
      { ...live, id: "sensor-archived", name: "Archived sensor", enabled: false, tags: [...live.tags, "unplaced"] },
    ];
    const state = {
      ...base,
      sensors: [...base.sensors.filter((sensor) => sensor.houseId !== currentHouse.id), ...sensors],
    };
    renderPage({ state, house: currentHouse, houses: base.houses });

    expect(screen.getByRole("button", { name: /Waiting for data.*1/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Unplaced.*1/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Live.*1/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Archived.*1/ })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /Archived.*1/ }));
    const inventory = screen.getByRole("heading", { name: `Sensors in ${currentHouse.name}` }).closest("section")!;
    expect(within(inventory).getByText("Archived sensor")).not.toBeNull();
    expect(within(inventory).queryByText("Unplaced sensor")).toBeNull();
  });

  it("shows true onboarding instead of an empty filtered inventory when a home has no sensors", async () => {
    const user = userEvent.setup();
    const base = createDemoState();
    const currentHouse = base.houses[0]!;
    const state = { ...base, sensors: base.sensors.filter((sensor) => sensor.houseId !== currentHouse.id) };
    renderPage({ state, house: currentHouse, houses: base.houses });

    expect(screen.getByRole("heading", { name: "Set up the next sensor" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: `Sensors in ${currentHouse.name}` })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import history" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start guided setup" }));
    expect(screen.getByRole("heading", { name: "Choose a source" })).not.toBeNull();
  });

  it("keeps placement, binding, history import, and discovery behind explicit disclosures", async () => {
    const user = userEvent.setup();
    const rendered = renderPage();
    await user.click(screen.getByRole("button", { name: "View data for Living room" }));
    await user.click(screen.getByRole("button", { name: "Edit Living room" }));

    const advanced = rendered.container.querySelector<HTMLDetailsElement>(".sensor-edit-advanced")!;
    expect(advanced.open).toBe(false);
    await user.click(screen.getByText("Advanced placement and connection"));
    expect(advanced.open).toBe(true);
    expect(screen.getByRole("spinbutton", { name: "X position" })).not.toBeNull();
    expect(screen.getByRole("combobox", { name: /^TP-Link device binding/ })).not.toBeNull();
  });

  it("keeps the newly selected sensor details when an older request finishes later", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const firstSensor = state.sensors.find((sensor) => sensor.id === "sensor-living")!;
    const secondSensor = state.sensors.find((sensor) => sensor.id === "sensor-kitchen")!;
    const firstSample = { ...state.latestMeasurements[firstSensor.id]!.temperature!, value: 11.11 };
    const secondSample = { ...state.latestMeasurements[secondSensor.id]!.temperature!, value: 22.22 };
    const firstPage = deferred<Awaited<ReturnType<typeof api.sensorMeasurementPage>>>();
    const secondPage = deferred<Awaited<ReturnType<typeof api.sensorMeasurementPage>>>();
    vi.spyOn(api, "sensorMeasurementPage").mockImplementation((sensorId) => (
      sensorId === firstSensor.id ? firstPage.promise : secondPage.promise
    ));
    renderPage({ state });

    await user.click(screen.getByRole("button", { name: `View data for ${firstSensor.name}` }));
    expect(screen.getByRole("heading", { name: firstSensor.name, level: 2 })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: `View data for ${secondSensor.name}` }));
    expect(screen.getByRole("heading", { name: secondSensor.name, level: 2 })).not.toBeNull();

    await act(async () => {
      secondPage.resolve({ samples: [secondSample], nextCursor: null });
      await secondPage.promise;
    });
    const details = document.querySelector<HTMLElement>(".sensor-details-panel")!;
    expect(within(details).getByText(`${secondSample.value} ${secondSample.canonicalUnit}`)).not.toBeNull();

    await act(async () => {
      firstPage.resolve({ samples: [firstSample], nextCursor: null });
      await firstPage.promise;
    });
    expect(within(details).getByRole("heading", { name: secondSensor.name, level: 2 })).not.toBeNull();
    expect(within(details).queryByText(`${firstSample.value} ${firstSample.canonicalUnit}`)).toBeNull();
  });

  it("does not reopen sensor details when a closed request finishes", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const sensor = state.sensors.find((candidate) => candidate.id === "sensor-living")!;
    const sample = state.latestMeasurements[sensor.id]!.temperature!;
    const page = deferred<Awaited<ReturnType<typeof api.sensorMeasurementPage>>>();
    vi.spyOn(api, "sensorMeasurementPage").mockReturnValue(page.promise);
    renderPage({ state });

    const opener = screen.getByRole("button", { name: `View data for ${sensor.name}` });
    await user.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: sensor.name, level: 2 })));
    await user.click(within(document.querySelector<HTMLElement>(".sensor-details-panel")!).getByRole("button", { name: "Close" }));
    expect(document.querySelector(".sensor-details-panel")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));

    await act(async () => {
      page.resolve({ samples: [sample], nextCursor: null });
      await page.promise;
    });
    expect(document.querySelector(".sensor-details-panel")).toBeNull();
  });

  it("invalidates sensor details when the active house changes", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const sensor = state.sensors[0]!;
    const page = deferred<Awaited<ReturnType<typeof api.sensorMeasurementPage>>>();
    vi.spyOn(api, "sensorMeasurementPage").mockReturnValue(page.promise);
    const rendered = renderPage({ state });

    await user.click(screen.getByRole("button", { name: `View data for ${sensor.name}` }));
    expect(document.querySelector(".sensor-details-panel")).not.toBeNull();

    const otherHouse = {
      ...state.houses[0]!,
      id: "house-other",
      name: "Other house",
      timezone: "America/New_York",
    };
    const nextState = { ...state, houses: [...state.houses, otherHouse] };
    rendered.rerender(
      <I18nProvider>
        <SensorManagementPage
          {...rendered.props}
          state={nextState}
          house={otherHouse}
          houses={nextState.houses}
        />
      </I18nProvider>,
    );
    expect(document.querySelector(".sensor-details-panel")).toBeNull();

    await act(async () => {
      page.resolve({ samples: [state.latestMeasurements[sensor.id]!.temperature!], nextCursor: null });
      await page.promise;
    });
    expect(document.querySelector(".sensor-details-panel")).toBeNull();
  });

  it("lets a read-only Home guest inspect sensor inventory and data without any management controls", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const sensor = state.sensors.find((candidate) => candidate.houseId === state.houses[0]!.id)!;
    const sample = state.latestMeasurements[sensor.id]!.temperature!;
    vi.spyOn(api, "sensorMeasurementPage").mockResolvedValue({ samples: [sample], nextCursor: null });
    const onRequestedDeviceHandled = vi.fn();
    const rendered = renderPage({
      state,
      readOnly: true,
      requestedDevice: { deviceId: discoveredDevice.deviceId, connectionId: null },
      onRequestedDeviceHandled,
    });

    expect(screen.getByRole("heading", { name: "Sensors" })).not.toBeNull();
    expect(screen.getByText(sensor.name)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Add sensor" })).toBeNull();
    expect(screen.queryByRole("button", { name: `Edit ${sensor.name}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Archive ${sensor.name}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Delete ${sensor.name}` })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import history" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Refresh device/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Automatic sensor discovery status" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sensor details" })).toBeNull();
    expect(onRequestedDeviceHandled).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: `View data for ${sensor.name}` }));
    expect(await screen.findByText(`${sample.value} ${sample.canonicalUnit}`)).not.toBeNull();
    expect(rendered.props.onCreateSensor).not.toHaveBeenCalled();
    expect(rendered.props.onUpdateSensor).not.toHaveBeenCalled();
    expect(rendered.props.onDeleteSensor).not.toHaveBeenCalled();
    expect(rendered.props.onImportHistoricalData).not.toHaveBeenCalled();
    expect(rendered.props.onRefreshDevices).not.toHaveBeenCalled();
  });

  it("invalidates sensor details when the selected sensor disappears", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const sensor = state.sensors[0]!;
    const page = deferred<Awaited<ReturnType<typeof api.sensorMeasurementPage>>>();
    vi.spyOn(api, "sensorMeasurementPage").mockReturnValue(page.promise);
    const rendered = renderPage({ state });

    await user.click(screen.getByRole("button", { name: `View data for ${sensor.name}` }));
    rendered.rerender(
      <I18nProvider>
        <SensorManagementPage
          {...rendered.props}
          state={{ ...state, sensors: state.sensors.filter((candidate) => candidate.id !== sensor.id) }}
        />
      </I18nProvider>,
    );
    expect(document.querySelector(".sensor-details-panel")).toBeNull();

    await act(async () => {
      page.resolve({ samples: [state.latestMeasurements[sensor.id]!.temperature!], nextCursor: null });
      await page.promise;
    });
    expect(document.querySelector(".sensor-details-panel")).toBeNull();
  });

  it("closes and invalidates selected details after permanent deletion", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const sensor = state.sensors[0]!;
    const page = deferred<Awaited<ReturnType<typeof api.sensorMeasurementPage>>>();
    vi.spyOn(api, "sensorMeasurementPage").mockReturnValue(page.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const rendered = renderPage({ state });

    await user.click(screen.getByRole("button", { name: `View data for ${sensor.name}` }));
    await user.click(screen.getByRole("button", { name: `Delete ${sensor.name}` }));
    await waitFor(() => {
      expect(rendered.props.onDeleteSensor).toHaveBeenCalledWith(sensor.id);
      expect(document.querySelector(".sensor-details-panel")).toBeNull();
    });

    await act(async () => {
      page.resolve({ samples: [state.latestMeasurements[sensor.id]!.temperature!], nextCursor: null });
      await page.promise;
    });
    expect(document.querySelector(".sensor-details-panel")).toBeNull();
  });
});
