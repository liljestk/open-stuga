import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { HomeEnergyCost, HomeEnergyProjection, HomeEnergySummary, MeasurementSample } from "@climate-twin/contracts";
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
      state: chartState, sensors: [sensor], projection: null,
      rollingSummary: summary,
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
it("explains a backtested weather projection and its range", () => {
  const projection: HomeEnergyProjection = {
    houseId: "house-main", generatedAt: "2026-10-26T12:00:00.000Z", algorithmVersion: "energy-projection/v1",
    horizonStart: "2026-10-27T00:00:00.000Z", horizonDays: 30, method: "weather-regression",
    next30DaysKwh: 420, lowKwh: 390, highKwh: 455, dailyKwh: 14, baseLoadKwhPerDay: 7.2,
    heatingSlopeKwhPerDegreeHour: 0.006, heatingBaseTemperatureC: 17, forecastDays: 10, observedDays: 118,
    confidence: "high",
    backtest: { origins: 24, meanAbsolutePercentError: 3.1, baselineMeanAbsolutePercentError: 7.8, skill: 0.6 },
    estimatedCostEur: 63, lowCostEur: 58.5, highCostEur: 68.25, priceBasis: "historical",
  };
  render(<I18nProvider><EnergyPlanningPanel sensors={[]} projection={projection} rollingSummary={null} /></I18nProvider>);
  expect(screen.getByText("High confidence")).toBeInTheDocument();
  expect(screen.getByText(/Tested on 24 past 30-day periods, it missed by 3% on average, against 8% for repeating the last 30 days/)).toBeInTheDocument();
  expect(screen.getByText(/390/)).toBeInTheDocument();
});
