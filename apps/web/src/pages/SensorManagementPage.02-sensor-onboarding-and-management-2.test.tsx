import { act, render, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import type { Sensor, TpLinkDiscoveredDevice } from "@climate-twin/contracts";

import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";

import { createDemoState } from "../domain";

import { I18nProvider } from "../i18n";

import { SensorManagementPage } from "./SensorManagementPage";

import { deferred, discoveredDevice, expectDescribedError, renderPage } from "./SensorManagementPageTestSupport";

afterEach(() => vi.restoreAllMocks());

describe("sensor onboarding and management", () => {
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

  it("keeps history and prediction visualization on each individual sensor detail view", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const sensor = state.sensors.find((candidate) => candidate.id === "sensor-living")!;
    vi.spyOn(api, "sensorMeasurementPage").mockResolvedValue({
      samples: state.measurementHistory[sensor.id]!.temperature!,
      nextCursor: null,
    });
    const onLoadSeries = vi.fn();
    const rendered = renderPage({ state, onLoadSeries });

    expect(screen.queryByRole("heading", { name: "Home sensor analytics" })).toBeNull();

    await user.click(screen.getByRole("button", { name: `View data for ${sensor.name}` }));
    const details = rendered.container.querySelector<HTMLElement>(".sensor-details-panel")!;
    expect(within(details).getByRole("group", { name: /Temperature history and forecast for Living room/ })).not.toBeNull();
    expect(within(details).getByText("Predicted")).not.toBeNull();
    expect(onLoadSeries).toHaveBeenCalledWith(sensor.id, "temperature", "24h", true);

    await user.selectOptions(within(details).getByRole("combobox", { name: "Measurement" }), "humidity");
    await waitFor(() => expect(onLoadSeries).toHaveBeenCalledWith(sensor.id, "humidity", "24h", true));
    expect(within(details).getByRole("group", { name: /Humidity history and forecast for Living room/ })).not.toBeNull();
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
    expect(within(rendered.container.querySelector<HTMLElement>(".sensor-list-panel")!).getByText(sensor.name)).not.toBeNull();
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
