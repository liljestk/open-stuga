import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Sensor, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { SensorManagementPage } from "./SensorManagementPage";

const discoveredDevice: TpLinkDiscoveredDevice = {
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
  it("guides a non-technical user from a CSV file to a validated history import", async () => {
    const user = userEvent.setup();
    const onImportHistoricalData = vi.fn().mockResolvedValue({ submitted: 2, accepted: 2, ignoredDuplicates: 0 });
    const rendered = renderPage({ onImportHistoricalData });

    await user.click(screen.getByRole("button", { name: "Import history" }));
    expect(screen.getByRole("heading", { name: "Choose your file" })).not.toBeNull();
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

  it("restores focus after closing inline sensor setup and history import", async () => {
    const user = userEvent.setup();
    renderPage();

    const addButton = screen.getByRole("button", { name: "Add sensor" });
    await user.click(addButton);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a source" })));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(addButton));

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

    await user.click(screen.getByRole("button", { name: "Edit Living room" }));
    expect(screen.getByRole("heading", { name: "Edit Living room" })).not.toBeNull();

    const name = screen.getByRole("textbox", { name: "Sensor name" });
    await user.clear(name);
    await user.type(name, "Living window");
    await user.selectOptions(screen.getByRole("combobox", { name: "Floor" }), "floor-upper");

    const room = screen.getByRole("combobox", { name: "Room" });
    await user.clear(room);
    await user.type(room, "Window nook");
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

    await user.click(screen.getByRole("button", { name: "Edit Living room" }));
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

  it("keeps failed edits open, exposes the server error, and retries discovery", async () => {
    const user = userEvent.setup();
    const onUpdateSensor = vi.fn().mockRejectedValue(new Error("Sensor service is unavailable"));
    const onRefreshDevices = vi.fn()
      .mockRejectedValueOnce(new Error("Hub discovery timed out"))
      .mockResolvedValueOnce(undefined);
    renderPage({ onUpdateSensor, onRefreshDevices });

    await user.click(screen.getByRole("button", { name: "Edit Kitchen" }));
    const name = screen.getByRole("textbox", { name: "Sensor name" });
    await user.clear(name);
    await user.type(name, "Kitchen north");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Sensor service is unavailable")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Edit Kitchen" })).not.toBeNull();
    expect((screen.getByRole("textbox", { name: "Sensor name" }) as HTMLInputElement).value).toBe("Kitchen north");

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
});
