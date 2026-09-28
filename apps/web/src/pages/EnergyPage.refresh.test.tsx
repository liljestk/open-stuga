import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { queryClient } from "../data/queryClient";
import { currentElectricityPrice } from "../data/energy/electricityQueries";
import { EnergyPage } from "./EnergyPage";

const start = "2026-09-28T12:00:00.000Z";
function result(propertyId: string, price = 10) {
  return {
    config: { propertyId, provider: "porssisahko" as const, endpointUrl: "https://api.porssisahko.net/v2/latest-prices.json", enabled: true,
      contractType: "spot" as const, marginCentsPerKwh: 0, retailer: "Sample retailer", contractName: null, monthlyFeeEur: null,
      lastFetchedAt: start, lastError: null, updatedAt: start },
    current: { propertyId, startAt: start, endAt: "2026-09-28T12:15:00.000Z", rawPriceCentsPerKwh: price,
      effectivePriceCentsPerKwh: price, effectivePriceEurPerKwh: price / 100, fetchedAt: start }, prices: [],
  };
}

describe("electricity freshness", () => {
  afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); vi.useRealTimers(); window.history.replaceState(null, "", "/"); });

  it("rejects expired, future, invalid and nonfinite current prices", () => {
    const point = result("sample").current;
    expect(currentElectricityPrice(point, Date.parse(start))).toBe(point);
    expect(currentElectricityPrice(point, Date.parse(point.endAt))).toBeNull();
    expect(currentElectricityPrice(point, Date.parse(start) - 1)).toBeNull();
    expect(currentElectricityPrice({ ...point, endAt: "invalid" }, Date.parse(start))).toBeNull();
    expect(currentElectricityPrice({ ...point, effectivePriceEurPerKwh: NaN }, Date.parse(start))).toBeNull();
  });

  it("refreshes the Property price without overwriting an unsaved contract edit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date(start));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const state = createDemoState(); state.houses = []; state.sensors = [];
    const propertyId = state.properties[0]!.id;
    const request = vi.spyOn(api, "propertyElectricity").mockResolvedValueOnce(result(propertyId)).mockResolvedValue(result(propertyId, 12));
    const optimizer = vi.spyOn(api, "energyOptimization");
    render(<I18nProvider><EnergyPage state={state} propertyId={propertyId} units="metric" onOpenAlerts={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText(/10.000 c\/kWh/)).not.toBeNull();
    await user.click(screen.getByText("Edit electricity contract"));
    await user.clear(screen.getByLabelText("Retailer")); await user.type(screen.getByLabelText("Retailer"), "Unsaved retailer");
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(await screen.findByText(/12.000 c\/kWh/)).not.toBeNull();
    expect(screen.getByLabelText("Retailer")).toHaveValue("Unsaved retailer");
    expect(optimizer).not.toHaveBeenCalled();
  });

  it("removes an expired cached Home price and recovers it in place", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-09-28T12:14:30.000Z"));
    const state = createDemoState(); const house = state.houses[0]!;
    state.sensors = [{ ...state.sensors[0]!, id: "sample-meter", houseId: house.id, measurementEntityIds: { power: "sensor.sample" } }];
    state.latestMeasurements = { "sample-meter": { electricity_price: {
      sensorId: "sample-meter", metric: "electricity_price", canonicalUnit: "\u20ac/kWh", value: 0.1,
      timestamp: "2026-09-28T12:14:00.000Z", source: "home-assistant", quality: "good",
    } } }; state.measurementHistory = {}; state.measurementForecasts = {};
    vi.spyOn(api, "houseEnergySummary").mockImplementation(() => new Promise(() => {}));
    const current = result(house.propertyId).current;
    const request = vi.spyOn(api, "houseElectricityPrice").mockResolvedValueOnce({ current }).mockRejectedValue(new Error("temporarily offline"));
    const view = render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onOpenAlerts={vi.fn()} /></I18nProvider>);
    const card = view.container.querySelector<HTMLElement>(".electricity_price")!;
    expect(await within(card).findByText("0.100 \u20ac/kWh")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(62_000); });
    expect(within(card).queryByText("0.100 \u20ac/kWh")).toBeNull();
    expect(screen.getByText("Could not load the property electricity price.")).not.toBeNull();
    request.mockResolvedValue({ current: { ...current, startAt: current.endAt, endAt: "2026-09-28T12:30:00.000Z", effectivePriceEurPerKwh: 0.2 } });
    await act(async () => { screen.getByRole("button", { name: "Try again" }).click(); });
    await waitFor(() => expect(within(card).getByText("0.200 \u20ac/kWh")).not.toBeNull());
  });
});
