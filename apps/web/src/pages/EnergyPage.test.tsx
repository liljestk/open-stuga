import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeasurementSample, Sensor } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { api } from "../api";
import { EnergyPage, counterConsumption } from "./EnergyPage";

function sample(value: number, timestamp: string): MeasurementSample {
  return {
    sensorId: "meter",
    metric: "energy",
    value,
    canonicalUnit: "kWh",
    timestamp,
    source: "home-assistant",
    quality: "good",
  };
}

describe("counterConsumption", () => {
  it("adds positive counter movement and tolerates a reset", () => {
    expect(counterConsumption([
      sample(10, "2026-07-15T10:00:00.000Z"),
      sample(12, "2026-07-15T12:00:00.000Z"),
      sample(1, "2026-07-16T00:00:00.000Z"),
      sample(3, "2026-07-16T10:00:00.000Z"),
    ])).toBe(5);
  });

  it("requires two readings before claiming a period total", () => {
    expect(counterConsumption([sample(3, "2026-07-16T10:00:00.000Z")])).toBeNull();
  });
});

describe("EnergyPage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("explains the one-device direct TP-Link boundary during onboarding", () => {
    const state = createDemoState();
    const house = state.houses[0]!;

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenSensors={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Connect electricity data" })).not.toBeNull();
    expect(screen.getByText("Home Assistant or direct TP-Link")).not.toBeNull();
    expect(screen.getByText(/supported TP-Link energy device/i)).not.toBeNull();
    expect(screen.getByText(/clearly mark anything that is unavailable/i)).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Electricity history" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Electricity sources" })).toBeNull();
    expect(screen.queryByText("Waiting for a source")).toBeNull();
  });

  it("preserves a disabled fixed contract when editing its descriptive fields", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const config = {
      propertyId: house.propertyId,
      provider: "porssisahko" as const,
      endpointUrl: "https://api.porssisahko.net/v1/latest-prices.json",
      enabled: false,
      marginCentsPerKwh: 1.25,
      contractType: "fixed" as const,
      contractName: "Winter fixed",
      retailer: "Old retailer",
      monthlyFeeEur: 4.5,
      lastFetchedAt: null,
      lastError: null,
      updatedAt: "2026-07-17T10:00:00.000Z",
    };
    vi.spyOn(api, "propertyElectricity").mockResolvedValue({ config, current: null, prices: [] });
    const configure = vi.spyOn(api, "configurePropertyElectricity").mockResolvedValue({ config: { ...config, retailer: "New retailer" } });
    const refresh = vi.spyOn(api, "refreshPropertyElectricity");

    render(<I18nProvider><EnergyPage state={state} propertyId={house.propertyId} units="metric" onLoadSeries={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    const retailer = await screen.findByLabelText("Retailer");
    expect((screen.getByLabelText("Contract type") as HTMLSelectElement).value).toBe("fixed");
    expect((screen.getByLabelText("Fetch and apply electricity prices") as HTMLInputElement).checked).toBe(false);
    await user.clear(retailer);
    await user.type(retailer, "New retailer");
    await user.click(screen.getByRole("button", { name: "Save and refresh" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith(house.propertyId, expect.objectContaining({
      enabled: false,
      contractType: "fixed",
      retailer: "New retailer",
    })));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the property contract observational for Guests", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    vi.spyOn(api, "propertyElectricity").mockResolvedValue({
      config: {
        propertyId: house.propertyId,
        provider: "porssisahko",
        endpointUrl: "https://api.porssisahko.net/v2/latest-prices.json",
        enabled: true,
        marginCentsPerKwh: 0,
        contractType: "spot",
        contractName: null,
        retailer: null,
        monthlyFeeEur: null,
        lastFetchedAt: null,
        lastError: null,
        updatedAt: "2026-07-17T10:00:00.000Z",
      },
      current: null,
      prices: [],
    });
    render(<I18nProvider><EnergyPage state={state} propertyId={house.propertyId} units="metric" readOnly onLoadSeries={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: "Electricity contract" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Save and refresh" })).toBeNull();
  });

  it("keeps contract management available for a Property without a Home", async () => {
    const state = createDemoState();
    const propertyId = state.properties[0]!.id;
    const config = {
      propertyId,
      provider: "porssisahko" as const,
      endpointUrl: "https://api.porssisahko.net/v1/latest-prices.json",
      enabled: true,
      marginCentsPerKwh: 0,
      contractType: "spot" as const,
      contractName: null,
      retailer: null,
      monthlyFeeEur: null,
      lastFetchedAt: null,
      lastError: null,
      updatedAt: "2026-07-17T10:00:00.000Z",
    };
    vi.spyOn(api, "propertyElectricity").mockResolvedValue({ config, current: null, prices: [] });

    render(<I18nProvider><EnergyPage
      state={{ ...state, houses: [], sensors: [] }}
      propertyId={propertyId}
      units="metric"
      onOpenAlerts={vi.fn()}
    /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: "Electricity contract" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save and refresh" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Connect electricity data" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Electricity history" })).toBeNull();
  });

  it("discards a late contract response after the selected Property changes", async () => {
    const state = createDemoState();
    const firstProperty = state.properties[0]!;
    const secondProperty = { ...firstProperty, id: "property-second", name: "Second Property" };
    state.properties = [firstProperty, secondProperty];
    type Result = Awaited<ReturnType<typeof api.propertyElectricity>>;
    let resolveFirst!: (result: Result) => void;
    let resolveSecond!: (result: Result) => void;
    const first = new Promise<Result>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<Result>((resolve) => { resolveSecond = resolve; });
    vi.spyOn(api, "propertyElectricity").mockImplementation((propertyId) => propertyId === firstProperty.id ? first : second);
    const result = (propertyId: string, retailer: string): Result => ({
      config: {
        propertyId,
        provider: "porssisahko",
        endpointUrl: "https://api.porssisahko.net/v2/latest-prices.json",
        enabled: true,
        marginCentsPerKwh: 0,
        contractType: "spot",
        contractName: null,
        retailer,
        monthlyFeeEur: null,
        lastFetchedAt: null,
        lastError: null,
        updatedAt: "2026-07-17T10:00:00.000Z",
      },
      current: null,
      prices: [],
    });

    const view = render(<I18nProvider><EnergyPage state={state} propertyId={firstProperty.id} units="metric" onOpenAlerts={vi.fn()} /></I18nProvider>);
    view.rerender(<I18nProvider><EnergyPage state={state} propertyId={secondProperty.id} units="metric" onOpenAlerts={vi.fn()} /></I18nProvider>);
    resolveSecond(result(secondProperty.id, "Second retailer"));
    await waitFor(() => expect((screen.getByLabelText("Retailer") as HTMLInputElement).value).toBe("Second retailer"));
    resolveFirst(result(firstProperty.id, "Late first retailer"));
    await Promise.resolve();
    expect((screen.getByLabelText("Retailer") as HTMLInputElement).value).toBe("Second retailer");
  });

  it("shows power, consumption, spot price, cost, history, and alert actions", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const state = createDemoState();
    const house = state.houses[0]!;
    const meter: Sensor = {
      ...state.sensors[0]!,
      id: "meter",
      houseId: house.id,
      name: "Main electricity meter",
      room: "Utility",
      model: "Home Assistant energy",
      measurementEntityIds: {
        power: "sensor.main_power",
        energy: "sensor.main_energy_today",
        electricity_price: "sensor.spot_price",
      },
    };
    const history = [
      sample(10, "2026-07-15T13:00:00.000Z"),
      sample(12, "2026-07-15T23:00:00.000Z"),
      sample(1, "2026-07-16T00:00:00.000Z"),
      sample(3, "2026-07-16T11:00:00.000Z"),
    ];
    state.sensors = [meter];
    state.latestMeasurements = {
      meter: {
        power: { ...sample(3_000, "2026-07-16T11:59:00.000Z"), metric: "power", canonicalUnit: "W" },
        energy: history.at(-1)!,
        electricity_price: { ...sample(0.123, "2026-07-16T11:00:00.000Z"), metric: "electricity_price", canonicalUnit: "€/kWh" },
      },
    };
    state.measurementHistory = { meter: { power: [], energy: history, electricity_price: [] } };
    state.measurementForecasts = { meter: {} };
    const onLoadSeries = vi.fn();
    const onOpenSensors = vi.fn();
    const onOpenAlerts = vi.fn();
    const consumptionHistory = vi.spyOn(api, "measurementHistory").mockResolvedValue(history);
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null });

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={onLoadSeries} onOpenSensors={onOpenSensors} onOpenAlerts={onOpenAlerts} /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Electricity" })).not.toBeNull();
    expect(screen.getAllByText("3000 W")).toHaveLength(2);
    expect(await screen.findByText("5.00 kWh")).not.toBeNull();
    expect(screen.getAllByText("0.123 €/kWh")).toHaveLength(2);
    expect(screen.getByText("0.37 €/h")).not.toBeNull();
    await waitFor(() => expect(onLoadSeries).toHaveBeenCalledWith("meter", "power", "24h", false));
    await waitFor(() => expect(consumptionHistory).toHaveBeenCalledWith(
      "meter", "energy", expect.any(String), expect.any(String), 50_000,
      expect.any(AbortSignal),
    ));

    await user.click(screen.getByRole("button", { name: "Electricity consumption" }));
    await user.click(screen.getByRole("button", { name: "6 hours" }));
    await waitFor(() => expect(onLoadSeries).toHaveBeenLastCalledWith("meter", "energy", "6h", false));
    expect(screen.getByText("5.00 kWh")).not.toBeNull();
    expect(consumptionHistory).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Manage alerts" }));
    expect(onOpenAlerts).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Edit sources" }));
    expect(onOpenSensors).toHaveBeenCalledTimes(1);
  });

  it("uses the Home-safe effective Property price without exposing contract controls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const state = createDemoState();
    const house = state.houses[0]!;
    const meter: Sensor = {
      ...state.sensors[0]!,
      id: "meter",
      houseId: house.id,
      name: "Main electricity meter",
      measurementEntityIds: { power: "sensor.main_power" },
    };
    state.sensors = [meter];
    state.latestMeasurements = {
      meter: {
        power: { ...sample(2_000, "2026-07-16T11:59:00.000Z"), metric: "power", canonicalUnit: "W" },
      },
    };
    state.measurementHistory = { meter: { power: [] } };
    state.measurementForecasts = { meter: {} };
    vi.spyOn(api, "measurementHistory").mockResolvedValue([]);
    const propertyContract = vi.spyOn(api, "propertyElectricity");
    const homeProjection = vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({
      current: {
        startAt: "2026-07-16T11:00:00.000Z",
        endAt: "2026-07-16T12:00:00.000Z",
        effectivePriceCentsPerKwh: 15,
        effectivePriceEurPerKwh: 0.15,
        fetchedAt: "2026-07-16T11:55:00.000Z",
      },
    });

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    expect(await screen.findByText("0.150 €/kWh")).not.toBeNull();
    expect(screen.getByText("0.30 €/h")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Electricity contract" })).toBeNull();
    expect(screen.queryByLabelText("Retailer")).toBeNull();
    expect(homeProjection).toHaveBeenCalledWith(house.id);
    expect(propertyContract).not.toHaveBeenCalled();
  });

  it("does not label a shorter chart cache as 24-hour consumption when the dedicated request fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const state = createDemoState();
    const house = state.houses[0]!;
    const meter: Sensor = {
      ...state.sensors[0]!,
      id: "meter",
      houseId: house.id,
      name: "Main electricity meter",
      measurementEntityIds: { energy: "sensor.main_energy" },
    };
    const shortHistory = [
      sample(1, "2026-07-16T06:00:00.000Z"),
      sample(3, "2026-07-16T12:00:00.000Z"),
    ];
    state.sensors = [meter];
    state.latestMeasurements = { meter: { energy: shortHistory.at(-1)! } };
    state.measurementHistory = { meter: { energy: shortHistory } };
    state.measurementForecasts = { meter: {} };
    const consumptionHistory = vi.spyOn(api, "measurementHistory").mockRejectedValue(new Error("History unavailable"));

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenSensors={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    await waitFor(() => expect(consumptionHistory).toHaveBeenCalledOnce());
    expect(screen.getByText("Consumption reading")).not.toBeNull();
    expect(screen.queryByText("Consumption · 24 hours")).toBeNull();
    expect(screen.getAllByText("3.00 kWh")).toHaveLength(2);
  });

  it("uses a fresh electricity source when a newer candidate is marked stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const state = createDemoState();
    const house = state.houses[0]!;
    const staleMeter: Sensor = {
      ...state.sensors[0]!, id: "stale-meter", houseId: house.id, name: "Stale meter",
      measurementEntityIds: { power: "sensor.stale_power" },
    };
    const freshMeter: Sensor = {
      ...state.sensors[0]!, id: "fresh-meter", houseId: house.id, name: "Fresh meter",
      measurementEntityIds: { power: "sensor.fresh_power" },
    };
    state.sensors = [staleMeter, freshMeter];
    state.latestMeasurements = {
      [staleMeter.id]: {
        power: { ...sample(9_000, "2026-07-16T11:59:00.000Z"), sensorId: staleMeter.id, metric: "power", canonicalUnit: "W", quality: "stale" },
      },
      [freshMeter.id]: {
        power: { ...sample(1_500, "2026-07-16T11:58:00.000Z"), sensorId: freshMeter.id, metric: "power", canonicalUnit: "W" },
      },
    };
    state.measurementHistory = {};
    state.measurementForecasts = {};

    const view = render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenSensors={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    const summary = view.container.querySelector<HTMLElement>(".energy-summary-card.power")!;
    expect(within(summary).getByText("1500 W")).not.toBeNull();
    expect(within(summary).getByText("Fresh meter")).not.toBeNull();
    expect(within(summary).queryByText("9000 W")).toBeNull();
  });
});
