import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HomeEnergyCost, HomeEnergySummary, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { api, ApiRequestError } from "../api";
import { queryClient } from "../data/queryClient";
import { EnergyPage } from "./EnergyPage";

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

function cumulativeCost(houseId: string, sensorId: string, from: string, to: string, costEur: number): HomeEnergyCost {
  return {
    houseId,
    sensorId,
    from,
    to,
    measurementBasis: "energy_counter",
    consumptionKwh: 5,
    pricedConsumptionKwh: 5,
    costEur,
    costBreakdown: null,
    priceCoveragePercent: 100,
    measurementCoverageFrom: from,
    measurementCoverageUntil: to,
    quality: "measured",
    archiveState: "local-only",
    complete: true,
    calculatedAt: to,
  };
}

function combinedSummary(
  houseId: string,
  from: string,
  to: string,
  costEur: number,
  sensorIds: string[] = ["meter"],
  measurementBasis: HomeEnergyCost["measurementBasis"] = "energy_counter",
): HomeEnergySummary {
  const contributions = sensorIds.map((sensorId) => ({
    ...cumulativeCost(houseId, sensorId, from, to, costEur / sensorIds.length),
    measurementBasis,
    consumptionKwh: 5 / sensorIds.length,
    pricedConsumptionKwh: 5 / sensorIds.length,
  }));
  return {
    schemaVersion: 3,
    algorithmVersion: "home-energy-summary/v3", tariffRevision: 0,
    houseId,
    from,
    to,
    consumptionKwh: 5,
    pricedConsumptionKwh: 5,
    costEur,
    totalCostEur: costEur,
    costBreakdown: null,
    priceCoveragePercent: 100,
    quality: "measured",
    archiveState: "local-only",
    aggregationMode: "independent_sources",
    complete: true,
    sourceCount: sensorIds.length,
    totalSources: sensorIds.length,
    excludedSourceCount: 0,
    failedSourceCount: 0,
    contributions,
    calculatedAt: to,
  };
}

describe("EnergyPage", () => {
  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
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

  it("keeps electricity source setup with the owner of a shared Home", () => {
    const state = createDemoState();
    const house = state.houses[0]!;

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" localAuthority={false} onOpenSensors={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "No electricity data available" })).not.toBeNull();
    expect(screen.getByText(/Only this Home's owner can configure its electricity sources/i)).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Connect electricity data" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure a source" })).toBeNull();
  });

  it("labels the optimizer as Property-wide on a Home electricity page", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const property = state.properties.find((candidate) => candidate.id === house.propertyId)!;

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onOpenAlerts={vi.fn()} /></I18nProvider>);

    const optimizer = screen.getByRole("heading", { name: "Cheapest practical times" }).closest("details")!;
    expect(optimizer.open).toBe(false);
    expect(within(optimizer).getByText(`Property scope · ${property.name}`)).not.toBeNull();
  });

  it("saves source details without touching the contract terms kept in the tariff", async () => {
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
    expect(screen.queryByLabelText("Contract type")).toBeNull();
    expect((screen.getByLabelText("Fetch and apply electricity prices") as HTMLInputElement).checked).toBe(false);
    await user.clear(retailer);
    await user.type(retailer, "New retailer");
    await user.click(screen.getByRole("button", { name: "Save and refresh" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith(house.propertyId, expect.objectContaining({
      enabled: false,
      retailer: "New retailer",
    })));
    const sent = configure.mock.calls[0]![1];
    expect(sent).not.toHaveProperty("contractType");
    expect(sent).not.toHaveProperty("marginCentsPerKwh");
    expect(sent).not.toHaveProperty("monthlyFeeEur");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("summarizes a working Property contract and keeps its editor closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-17T10:30:00.000Z"));
    const user = userEvent.setup();
    const state = createDemoState();
    const propertyId = state.properties[0]!.id;
    const config = {
      propertyId,
      provider: "porssisahko" as const,
      endpointUrl: "https://api.porssisahko.net/v1/latest-prices.json",
      enabled: true,
      marginCentsPerKwh: 0.5,
      contractType: "spot" as const,
      contractName: "Everyday spot",
      retailer: "Local energy",
      monthlyFeeEur: 3.5,
      lastFetchedAt: "2026-07-17T10:00:00.000Z",
      lastError: null,
      updatedAt: "2026-07-17T10:00:00.000Z",
    };
    vi.spyOn(api, "propertyElectricity").mockResolvedValue({
      config,
      current: {
        propertyId,
        startAt: "2026-07-17T10:00:00.000Z",
        endAt: "2026-07-17T11:00:00.000Z",
        rawPriceCentsPerKwh: 8,
        effectivePriceCentsPerKwh: 8.5,
        effectivePriceEurPerKwh: 0.085,
        fetchedAt: "2026-07-17T10:00:00.000Z",
      },
      prices: [],
    });

    render(<I18nProvider><EnergyPage state={state} propertyId={propertyId} units="metric" onOpenAlerts={vi.fn()} /></I18nProvider>);

    expect(await screen.findByText(/8\.500/)).not.toBeNull();
    const editor = screen.getByText("Edit electricity contract", { selector: ".energy-contract-editor > summary span" }).closest("details")!;
    expect(editor.open).toBe(false);
    await user.click(editor.querySelector("summary")!);
    expect(editor.open).toBe(true);
    expect(await screen.findByRole("button", { name: "Save and refresh" })).not.toBeNull();
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
    expect(await screen.findByRole("button", { name: "Save and refresh" })).not.toBeNull();
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
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null });
    const summaryRequest = vi.spyOn(api, "houseEnergySummary").mockImplementation(async (houseId, from, to) => {
      const duration = Date.parse(to) - Date.parse(from);
      return combinedSummary(houseId, from, to, duration <= 3_600_000 ? 0.19 : 8.42);
    });
    const historyRequest = vi.spyOn(api, "analyticsQuery").mockImplementation(async (input) => ({
      apiVersion: "1.0", requestId: input.requestId, dataMode: input.dataMode,
      resolvedRange: input.range, resolution: input.resolution === "auto" ? "5m" : input.resolution,
      series: [], summaries: [], provenance: [], warnings: [], generatedAt: input.range.end,
      quality: { coverage: 0, seriesCount: 0, sampleCount: 0, excludedSampleCount: 0, includedQualities: ["good"], lowCoverageSeries: 0 },
      cache: { hit: false, keyVersion: "analytics-query-v2" },
    }));

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={onLoadSeries} onOpenSensors={onOpenSensors} onOpenAlerts={onOpenAlerts} /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Electricity" })).not.toBeNull();
    expect(screen.getAllByText("3000 W")).toHaveLength(2);
    expect(await screen.findByText("5.00 kWh")).not.toBeNull();
    expect(screen.getAllByText("0.123 €/kWh")).toHaveLength(2);
    expect(await screen.findByText("8.42 €")).not.toBeNull();
    const costInterval = screen.getByRole("combobox", { name: "Running cost interval" });
    expect((costInterval as HTMLSelectElement).value).toBe("month");
    await user.selectOptions(costInterval, "1h");
    expect(await screen.findByText("0.19 €")).not.toBeNull();
    expect(summaryRequest).toHaveBeenLastCalledWith(house.id, expect.any(String), expect.any(String), expect.any(AbortSignal));
    const latestSummaryCall = summaryRequest.mock.calls.at(-1)!;
    expect(Date.parse(latestSummaryCall[2]) - Date.parse(latestSummaryCall[1])).toBe(3_600_000);
    await waitFor(() => expect(onLoadSeries).toHaveBeenCalledWith("meter", "power", "24h", false));

    await user.click(screen.getByRole("button", { name: "Energy used" }));
    await user.click(screen.getByRole("button", { name: "6 hours" }));
    await waitFor(() => expect(historyRequest).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "house", id: house.id, entityIds: ["meter"] },
      measurementIds: ["energy"], resolution: "5m", aggregation: "delta",
    }), expect.any(AbortSignal)));
    const energyHistoryCall = historyRequest.mock.calls.filter(([input]) => input.measurementIds[0] === "energy").at(-1)![0];
    expect(Date.parse(energyHistoryCall.range.end) - Date.parse(energyHistoryCall.range.start)).toBe(6 * 3_600_000);
    expect(onLoadSeries.mock.calls.some(([, metric]) => metric === "energy")).toBe(false);
    expect(screen.getByText("5.00 kWh")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Manage alerts" }));
    expect(onOpenAlerts).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("heading", { name: "Electricity sources" }));
    await user.click(screen.getByRole("button", { name: "Edit sources" }));
    expect(onOpenSensors).toHaveBeenCalledTimes(1);
  });

  it("labels a combined unarchived cost as priced so far", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const meter: Sensor = {
      ...state.sensors[0]!,
      id: "pending-meter",
      houseId: house.id,
      measurementEntityIds: { power: "sensor.pending_power" },
    };
    const secondMeter: Sensor = {
      ...meter,
      id: "pending-meter-2",
      name: "Second pending meter",
      measurementEntityIds: { power: "sensor.pending_power_2" },
    };
    state.sensors = [meter, secondMeter];
    state.latestMeasurements = {
      [meter.id]: {
        power: {
          ...sample(500, "2026-07-16T11:59:00.000Z"),
          sensorId: meter.id,
          metric: "power",
          canonicalUnit: "W",
        },
      },
      [secondMeter.id]: {
        power: {
          ...sample(300, "2026-07-16T11:59:00.000Z"),
          sensorId: secondMeter.id,
          metric: "power",
          canonicalUnit: "W",
        },
      },
    };
    state.measurementHistory = { [meter.id]: { power: [] }, [secondMeter.id]: { power: [] } };
    state.measurementForecasts = { [meter.id]: {}, [secondMeter.id]: {} };
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null });
    vi.spyOn(api, "houseEnergySummary").mockImplementation(async (houseId, from, to) => {
      const summary = combinedSummary(houseId, from, to, 2.5, [meter.id, secondMeter.id]);
      return {
        ...summary,
        quality: "partial",
        archiveState: "pending",
        complete: false,
        contributions: summary.contributions.map((cost) => ({
          ...cost,
          quality: "partial",
          archiveState: "pending",
          complete: false,
        })),
      };
    });

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    expect(await screen.findByText(/priced so far/i)).not.toBeNull();
    expect(screen.getByText(/2 of 2 sensors combined · Pending time-database confirmation/i)).not.toBeNull();
  });

  it("shows no cost instead of a current-price guess when usage exists but historical prices do not", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-16T11:59:00.000Z"));
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const meter: Sensor = {
      ...state.sensors[0]!, id: "cost-meter", houseId: house.id, name: "Water heater",
      measurementEntityIds: { energy: "sensor.water_heater_energy" },
    };
    state.sensors = [meter];
    state.latestMeasurements = { [meter.id]: { energy: { ...sample(20, "2026-07-16T11:59:00.000Z"), sensorId: meter.id } } };
    state.measurementHistory = { [meter.id]: { energy: [] } };
    state.measurementForecasts = { [meter.id]: {} };
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({
      current: {
        startAt: "2026-07-16T11:00:00.000Z",
        endAt: "2026-07-16T12:00:00.000Z",
        effectivePriceCentsPerKwh: 20,
        effectivePriceEurPerKwh: 0.2,
        fetchedAt: "2026-07-16T11:55:00.000Z",
      },
    });
    vi.spyOn(api, "houseEnergySummary").mockImplementation(async (houseId, from, to) => {
      const consumptionKwh = Date.parse(to) - Date.parse(from) <= 3_600_000 ? 1 : 5;
      const result = combinedSummary(houseId, from, to, 0, [meter.id]);
      return {
        ...result,
        consumptionKwh,
        pricedConsumptionKwh: null,
        costEur: null,
        totalCostEur: null,
        costBreakdown: null,
        priceCoveragePercent: 0,
        complete: false,
        quality: "partial",
        contributions: result.contributions.map((cost) => ({
          ...cost, consumptionKwh, pricedConsumptionKwh: null, costEur: null, costBreakdown: null, priceCoveragePercent: 0, complete: false, quality: "partial",
        })),
      };
    });

    const view = render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    const costCard = view.container.querySelector<HTMLElement>(".energy-summary-card.running_cost")!;
    expect(await within(costCard).findByText(/matching price data is unavailable/i)).not.toBeNull();
    expect(within(costCard).getByText("—")).not.toBeNull();
    expect(within(costCard).queryByText(/≈/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Usage outlook" })).not.toBeNull();
    expect(screen.getByText("Biggest electricity consumers")).not.toBeNull();
    expect(screen.getAllByText("Water heater").length).toBeGreaterThan(1);
    expect(screen.getByText("5 kWh · 100%")).not.toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Running cost interval" }), "1h");
    await waitFor(() => expect(api.houseEnergySummary).toHaveBeenCalledWith(house.id, expect.any(String), expect.any(String), expect.anything()));
    expect(within(costCard).queryByText(/≈/)).toBeNull();
    expect(screen.getByText("5 kWh · 100%")).not.toBeNull();
  });

  it("uses the Home-safe effective Property price without exposing contract controls", async () => {
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
    const projectedPrice = {
      startAt: "2026-07-16T11:00:00.000Z",
      endAt: "2026-07-16T13:00:00.000Z",
      effectivePriceCentsPerKwh: 15,
      effectivePriceEurPerKwh: 0.15,
      fetchedAt: "2026-07-16T11:55:00.000Z",
    };
    const homeProjection = vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({
      current: projectedPrice,
      prices: [projectedPrice],
    });

    const view = render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    expect(await screen.findByText("0.150 €/kWh")).not.toBeNull();
    expect(screen.queryByText("216.00 €")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Electricity contract" })).toBeNull();
    expect(screen.queryByLabelText("Retailer")).toBeNull();
    expect(homeProjection).toHaveBeenCalledWith(house.id, undefined, undefined, expect.any(AbortSignal));
    expect(propertyContract).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Electricity price" }));
    expect(await screen.findByRole("heading", { name: "Property electricity price" })).not.toBeNull();
    expect(view.container.querySelector(".sensor-electricity-price-line")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "1 year" }));
    await waitFor(() => expect(homeProjection).toHaveBeenLastCalledWith(
      house.id,
      expect.any(String),
      expect.any(String),
      expect.any(AbortSignal),
    ));
    const oneYearCall = homeProjection.mock.calls.at(-1)!;
    expect(Date.parse(oneYearCall[2]!) - Date.parse(oneYearCall[1]!)).toBe(365 * 24 * 3_600_000);
  });

  it("recovers the spot price card by polling after a failed load", async () => {
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
    vi.spyOn(api, "houseEnergySummary").mockImplementation(async (houseId, from, to) => (
      combinedSummary(houseId, from, to, 8.42)
    ));
    const priceRequest = vi.spyOn(api, "houseElectricityPrice")
      .mockRejectedValueOnce(new Error("price offline"))
      .mockRejectedValueOnce(new Error("price offline"))
      .mockResolvedValue({
        current: {
          startAt: "2026-07-16T12:00:00.000Z",
          endAt: "2026-07-16T12:15:00.000Z",
          effectivePriceCentsPerKwh: 15,
          effectivePriceEurPerKwh: 0.15,
          fetchedAt: "2026-07-16T11:55:00.000Z",
        },
      });

    const view = render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);
    const priceCard = view.container.querySelector<HTMLElement>(".energy-summary-card.electricity_price")!;

    // The initial attempt and its retry both fail: the card degrades to a
    // placeholder instead of an error and keeps polling in the background.
    await waitFor(() => expect(priceRequest).toHaveBeenCalled());
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(priceRequest).toHaveBeenCalledTimes(2);
    expect(within(priceCard).getByText("—")).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(await within(priceCard).findByText("0.150 €/kWh")).not.toBeNull();
  });

  it("combines every electricity sensor and offers single, multiple, and combined charts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const state = createDemoState();
    const house = state.houses[0]!;
    const first: Sensor = {
      ...state.sensors[0]!,
      id: "meter-first",
      houseId: house.id,
      name: "Kitchen plug",
      measurementEntityIds: { power: "sensor.kitchen_power", energy: "sensor.kitchen_energy" },
    };
    const second: Sensor = {
      ...state.sensors[0]!,
      id: "meter-second",
      houseId: house.id,
      name: "Office plug",
      measurementEntityIds: { power: "sensor.office_power", energy: "sensor.office_energy" },
    };
    const powerHistory = (sensorId: string, firstValue: number, lastValue: number) => [
      { ...sample(firstValue, "2026-07-16T11:30:00.000Z"), sensorId, metric: "power" as const, canonicalUnit: "W" },
      { ...sample(lastValue, "2026-07-16T11:59:00.000Z"), sensorId, metric: "power" as const, canonicalUnit: "W" },
    ];
    const firstEnergy = [
      { ...sample(10, "2026-07-15T13:00:00.000Z"), sensorId: first.id },
      { ...sample(12, "2026-07-16T11:59:00.000Z"), sensorId: first.id },
    ];
    const secondEnergy = [
      { ...sample(20, "2026-07-15T13:00:00.000Z"), sensorId: second.id },
      { ...sample(23, "2026-07-16T11:59:00.000Z"), sensorId: second.id },
    ];
    const firstPower = powerHistory(first.id, 80, 100);
    const secondPower = powerHistory(second.id, 180, 200);
    state.sensors = [first, second];
    state.latestMeasurements = {
      [first.id]: { energy: firstEnergy.at(-1)! },
      [second.id]: { energy: secondEnergy.at(-1)! },
    };
    state.measurementHistory = {
      [first.id]: { power: firstPower, energy: firstEnergy },
      [second.id]: { power: secondPower, energy: secondEnergy },
    };
    state.measurementForecasts = { [first.id]: {}, [second.id]: {} };
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null });
    const summaryRequest = vi.spyOn(api, "houseEnergySummary").mockImplementation(async (houseId, from, to) => (
      combinedSummary(houseId, from, to, 3.5, [first.id, second.id])
    ));

    const view = render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenSensors={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    const powerCard = view.container.querySelector<HTMLElement>(".energy-summary-card.power")!;
    expect(within(powerCard).getByText("300 W")).not.toBeNull();
    expect(within(powerCard).getByText("2 of 2 sensors combined")).not.toBeNull();
    const energyCard = view.container.querySelector<HTMLElement>(".energy-summary-card.energy")!;
    expect(await within(energyCard).findByText("5.00 kWh")).not.toBeNull();
    expect(within(energyCard).getByText("2 of 2 sensors combined")).not.toBeNull();
    expect(await screen.findByText("3.50 €")).not.toBeNull();
    await waitFor(() => expect(summaryRequest).toHaveBeenCalledTimes(2));
    await user.selectOptions(screen.getByRole("combobox", { name: "Running cost interval" }), "1h");
    await waitFor(() => expect(summaryRequest).toHaveBeenCalledTimes(3));
    const hourlyCall = summaryRequest.mock.calls.at(-1)!;
    expect(Date.parse(hourlyCall[2]) - Date.parse(hourlyCall[1])).toBe(3_600_000);
    expect(await screen.findByText("3.50 €")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Combined" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelectorAll(".sensor-aggregate-line")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Multiple" }));
    expect(view.container.querySelectorAll(".sensor-series-line")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Single" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Data source" }), second.id);
    expect(screen.getByRole("heading", { name: second.name })).not.toBeNull();
  });

  it("shows server-derived consumption for a power-only plug", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const state = createDemoState();
    const house = state.houses[0]!;
    const plug: Sensor = {
      ...state.sensors[0]!,
      id: "power-only-plug",
      houseId: house.id,
      name: "Bathroom plug",
      measurementEntityIds: { power: "sensor.bathroom_power" },
    };
    const power = { ...sample(500, "2026-07-16T11:59:00.000Z"), sensorId: plug.id, metric: "power" as const, canonicalUnit: "W" };
    state.sensors = [plug];
    state.latestMeasurements = { [plug.id]: { power } };
    state.measurementHistory = { [plug.id]: { power: [power] } };
    state.measurementForecasts = { [plug.id]: {} };
    const summaryRequest = vi.spyOn(api, "houseEnergySummary").mockImplementation(async (houseId, from, to) => (
      combinedSummary(houseId, from, to, 0.5, [plug.id], "integrated_power")
    ));
    const legacyCostRequest = vi.spyOn(api, "houseEnergyCost");
    const onLoadSeries = vi.fn();

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={onLoadSeries} onOpenAlerts={vi.fn()} /></I18nProvider>);

    expect(await screen.findByText("5.00 kWh")).not.toBeNull();
    expect(await screen.findByText("0.50 €")).not.toBeNull();
    expect(summaryRequest).toHaveBeenCalled();
    expect(legacyCostRequest).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Energy used" }));
    await user.click(screen.getByRole("button", { name: "Multiple" }));
    expect(screen.getByRole("checkbox", { name: "Bathroom plug" })).toBeChecked();
    await waitFor(() => expect(onLoadSeries).toHaveBeenCalledWith(plug.id, "power", "24h", false));
  });

  it("does not substitute a lifetime counter when the 24-hour summary fails", async () => {
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
    const powerOnlyMeter: Sensor = {
      ...meter,
      id: "power-only-meter",
      name: "Power-only meter",
      measurementEntityIds: { power: "sensor.power_only" },
    };
    const shortHistory = [
      sample(1, "2026-07-16T06:00:00.000Z"),
      sample(3, "2026-07-16T12:00:00.000Z"),
    ];
    const power = { ...sample(500, "2026-07-16T11:59:00.000Z"), sensorId: powerOnlyMeter.id, metric: "power" as const, canonicalUnit: "W" };
    state.sensors = [meter, powerOnlyMeter];
    state.latestMeasurements = { meter: { energy: shortHistory.at(-1)! }, [powerOnlyMeter.id]: { power } };
    state.measurementHistory = { meter: { energy: shortHistory }, [powerOnlyMeter.id]: { power: [power] } };
    state.measurementForecasts = { meter: {}, [powerOnlyMeter.id]: {} };
    const summaryRequest = vi.spyOn(api, "houseEnergySummary").mockRejectedValue(new Error("Summary unavailable"));

    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenSensors={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    await waitFor(() => expect(summaryRequest).toHaveBeenCalled());
    expect(screen.getByText("Consumption · 24 hours")).not.toBeNull();
    const energyCard = document.querySelector<HTMLElement>(".energy-summary-card.energy")!;
    expect(within(energyCard).getByText("—")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(within(energyCard).getByText(/Usage could not be fully calculated/)).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
    expect(within(energyCard).queryByText("3.00 kWh")).toBeNull();
  });

  it("automatically recovers an annual cost that is preparing without calling it unavailable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const state = createDemoState();
    const house = state.houses[0]!;
    const meter = { ...state.sensors[0]!, id: "meter", houseId: house.id,
      name: "Main meter", measurementEntityIds: { energy: "sensor.main_energy" } };
    state.sensors = [meter];
    state.latestMeasurements = { meter: { energy: sample(12, "2026-07-16T11:59:00.000Z") } };
    state.measurementHistory = {};
    let ready = false;
    const request = vi.spyOn(api, "houseEnergySummary").mockImplementation(async (id, from, to) => {
      if (!ready) throw new ApiRequestError(503, "TELEMETRY_ROLLUPS_MATERIALIZING", "Preparing history");
      return combinedSummary(id, from, to, 1);
    });
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null, prices: [] });
    window.history.replaceState(null, "", `/properties/${house.propertyId}/homes/${house.id}/electricity?cost=year`);
    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const card = document.querySelector<HTMLElement>(".running_cost")!;
    expect(within(card).getByText("Calculating from stored history…")).not.toBeNull();
    expect(screen.queryByText(/Usage could not be fully calculated/)).toBeNull();
    expect(screen.getByRole("combobox", { name: "Running cost interval" })).toHaveValue("year");
    const count = request.mock.calls.length;
    ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    await waitFor(() => expect(within(card).getByText("1.00 €")).not.toBeNull());
    expect(request.mock.calls.length).toBeGreaterThan(count);
    expect(screen.getByRole("combobox", { name: "Running cost interval" })).toHaveValue("year");
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
    expect(within(summary).getByText("1 of 2 sensors combined")).not.toBeNull();
    expect(within(summary).queryByText("9000 W")).toBeNull();
  });

  it("deep-links the evidence range and restores it without losing unrelated query state", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const meter: Sensor = {
      ...state.sensors[0]!,
      id: "history-meter",
      houseId: house.id,
      name: "History meter",
      measurementEntityIds: { power: "sensor.history_power" },
    };
    const power = {
      ...sample(800, new Date().toISOString()),
      sensorId: meter.id,
      metric: "power" as const,
      canonicalUnit: "W",
    };
    state.sensors = [meter];
    state.latestMeasurements = { [meter.id]: { power } };
    state.measurementHistory = { [meter.id]: { power: [power] } };
    state.measurementForecasts = { [meter.id]: {} };
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null, prices: [] });
    vi.spyOn(api, "houseEnergySummary").mockImplementation(async (houseId, from, to) => combinedSummary(houseId, from, to, 1));
    window.history.replaceState(null, "", `/properties/${house.propertyId}/homes/${house.id}/electricity?source=retained&range=7d&metric=energy&cost=7d#history`);

    const user = userEvent.setup();
    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onLoadSeries={vi.fn()} onOpenAlerts={vi.fn()} /></I18nProvider>);

    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Energy used" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Running cost interval" })).toHaveValue("7d");
    await user.click(screen.getByRole("button", { name: "30 days" }));
    expect(new URLSearchParams(window.location.search).get("range")).toBe("30d");
    expect(new URLSearchParams(window.location.search).get("source")).toBe("retained");
    expect(new URLSearchParams(window.location.search).get("metric")).toBe("energy");
    expect(new URLSearchParams(window.location.search).get("cost")).toBe("7d");
    expect(window.location.hash).toBe("#history");

    await user.click(screen.getByRole("button", { name: "24 hours" }));
    expect(new URLSearchParams(window.location.search).has("range")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("source")).toBe("retained");

    await user.click(screen.getByRole("button", { name: "Power" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Running cost interval" }), "month");
    expect(new URLSearchParams(window.location.search).has("metric")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("cost")).toBe(false);

    act(() => {
      window.history.pushState(null, "", `?source=retained&range=invalid&metric=invalid&cost=invalid#history`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "24 hours" })).toHaveAttribute("aria-pressed", "true"));
    expect(new URLSearchParams(window.location.search).has("range")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("metric")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("cost")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("source")).toBe("retained");

    act(() => {
      window.history.pushState(null, "", `?source=retained&range=6h&metric=electricity_price&cost=1h#history`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "6 hours" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "Electricity price" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Running cost interval" })).toHaveValue("1h");

    act(() => {
      window.history.pushState(null, "", `/properties/${house.propertyId}/homes/${house.id}/analytics?range=90d&metric=humidity#evidence`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(window.location.search).toBe("?range=90d&metric=humidity");
    expect(window.location.hash).toBe("#evidence");
  });
});
