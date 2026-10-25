import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { HomeEnergyCost, HomeEnergySummary, MeasurementSample } from "@climate-twin/contracts";
import { createDemoState, type ClimateState } from "../domain";
import { I18nProvider } from "../i18n";
import { EnergyPlanningPanel } from "./EnergyPlanningPanel";

it("keeps measured consumer insights unchanged when chart history is replaced", () => {
  const state = createDemoState();
  const sensor = { ...state.sensors[0]!, id: "water-heater", name: "Water heater" };
  const from = "2026-09-01T00:00:00.000Z";
  const to = "2026-09-28T00:00:00.000Z";
  const cost: HomeEnergyCost = {
    houseId: sensor.houseId, sensorId: sensor.id, from, to,
    consumptionKwh: 30, pricedConsumptionKwh: 30, costEur: 6, costBreakdown: null,
    priceCoveragePercent: 100, measurementBasis: "energy_counter",
    measurementCoverageFrom: from, measurementCoverageUntil: to,
    quality: "measured", archiveState: "local-only", complete: true, calculatedAt: to,
  };
  const summary: HomeEnergySummary = {
    schemaVersion: 3, algorithmVersion: "home-energy-summary/v3", tariffRevision: 0,
    houseId: sensor.houseId, from, to, consumptionKwh: 30,
    pricedConsumptionKwh: 30, costEur: 6, totalCostEur: 6, costBreakdown: null, priceCoveragePercent: 100,
    quality: "measured", archiveState: "local-only", complete: true,
    aggregationMode: "independent_sources", sourceCount: 1, totalSources: 1,
    excludedSourceCount: 0, failedSourceCount: 0, contributions: [cost], calculatedAt: to,
  };
  const power: MeasurementSample[] = [0, 15, 30, 45].map((minute) => ({
    sensorId: sensor.id, metric: "power", value: 1_000, canonicalUnit: "W",
    timestamp: new Date(Date.parse(from) + minute * 60_000).toISOString(), source: "api", quality: "good",
  }));
  const renderPanel = (chartState: ClimateState) => {
    // Include the former global-state input to exercise the exact regression:
    // chart cache replacement must not become consumer-pattern evidence.
    const callerProps = {
      state: chartState, sensors: [sensor], recentSummary: null,
      rollingSummary: summary, currentPriceEurPerKwh: 0.2,
    };
    return <I18nProvider><EnergyPlanningPanel {...callerProps} /></I18nProvider>;
  };
  const initial = { ...state, measurementHistory: { [sensor.id]: { power } }, latestMeasurements: {} };
  const { rerender } = render(renderPanel(initial));
  const before = screen.getByRole("list").textContent;
  expect(within(screen.getByRole("list")).getByText("Water heater")).toBeInTheDocument();
  expect(before).toContain("30");
  expect(before).toContain("100");

  rerender(renderPanel({ ...initial, measurementHistory: {} }));

  expect(screen.getByRole("list").textContent).toBe(before);
  expect(screen.queryByText(/Steady load|Learning pattern|Average .*peak/i)).not.toBeInTheDocument();
});