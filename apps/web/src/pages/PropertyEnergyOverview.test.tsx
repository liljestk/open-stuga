import { render, screen } from "@testing-library/react";
import type { HomeEnergySummary, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { queryClient } from "../data/queryClient";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { PropertyEnergyOverview } from "./PropertyEnergyOverview";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");

function powerSample(sensorId: string, value: number): MeasurementSample {
  return {
    sensorId,
    metric: "power",
    value,
    canonicalUnit: "W",
    timestamp: "2026-07-31T11:59:00.000Z",
    source: "home-assistant",
    quality: "good",
  };
}

function summary(houseId: string, sensorId: string, consumptionKwh: number, costEur: number): HomeEnergySummary {
  const from = "2026-07-30T12:00:00.000Z";
  const to = "2026-07-31T12:00:00.000Z";
  return {
    schemaVersion: 2,
    algorithmVersion: "home-energy-summary/v2",
    houseId,
    from,
    to,
    consumptionKwh,
    pricedConsumptionKwh: consumptionKwh,
    costEur,
    priceCoveragePercent: 100,
    quality: "measured",
    archiveState: "archived",
    aggregationMode: "whole_home",
    complete: true,
    sourceCount: 1,
    totalSources: 1,
    excludedSourceCount: 0,
    failedSourceCount: 0,
    contributions: [{
      houseId,
      sensorId,
      from,
      to,
      measurementBasis: "energy_counter",
      consumptionKwh,
      pricedConsumptionKwh: consumptionKwh,
      costEur,
      priceCoveragePercent: 100,
      measurementCoverageFrom: from,
      measurementCoverageUntil: to,
      quality: "measured",
      archiveState: "archived",
      complete: true,
      calculatedAt: to,
    }],
    calculatedAt: to,
  };
}

describe("PropertyEnergyOverview", () => {
  afterEach(() => {
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it("combines current power, 24-hour consumption, cost, and Home coverage", async () => {
    const state = createDemoState();
    const firstHome = state.houses[0]!;
    const secondHome = { ...firstHome, id: "house-sauna", name: "Sauna" };
    const baseSensor = state.sensors[0]!;
    const firstMeter: Sensor = {
      ...baseSensor,
      id: "meter-main",
      houseId: firstHome.id,
      name: "Main meter",
      energyMeterRole: "whole_home",
      measurementEntityIds: { power: "sensor.main_power", energy: "sensor.main_energy" },
    };
    const secondMeter: Sensor = {
      ...baseSensor,
      id: "meter-sauna",
      houseId: secondHome.id,
      name: "Sauna meter",
      energyMeterRole: "whole_home",
      measurementEntityIds: { power: "sensor.sauna_power", energy: "sensor.sauna_energy" },
    };
    state.houses = [firstHome, secondHome];
    state.sensors = [firstMeter, secondMeter];
    state.latestMeasurements = {
      [firstMeter.id]: { power: powerSample(firstMeter.id, 1_000) },
      [secondMeter.id]: { power: powerSample(secondMeter.id, 500) },
    };
    state.measurementHistory = { [firstMeter.id]: {}, [secondMeter.id]: {} };
    const request = vi.spyOn(api, "houseEnergySummary").mockImplementation(async (houseId) => houseId === firstHome.id
      ? summary(firstHome.id, firstMeter.id, 6, 1.2)
      : summary(secondHome.id, secondMeter.id, 4, 0.8));

    render(<I18nProvider><PropertyEnergyOverview
      state={state}
      propertyId={firstHome.propertyId}
      propertyName="Forest Property"
      units="metric"
      now={NOW}
    /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Property consumption" })).not.toBeNull();
    expect(await screen.findByText("10.00 kWh")).not.toBeNull();
    expect(screen.getByText("1500 W")).not.toBeNull();
    expect(screen.getByText("2.00 €")).not.toBeNull();
    expect(screen.getByText("2 / 2")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Pine House" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Sauna" })).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps the contract useful before the Property has a Home", () => {
    const state = createDemoState();
    state.houses = [];
    state.sensors = [];
    const request = vi.spyOn(api, "houseEnergySummary");

    render(<I18nProvider><PropertyEnergyOverview
      state={state}
      propertyId={state.properties[0]!.id}
      propertyName={state.properties[0]!.name}
      units="metric"
      now={NOW}
    /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "No Homes on this Property" })).not.toBeNull();
    expect(screen.getByText(/contract remains ready/i)).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
