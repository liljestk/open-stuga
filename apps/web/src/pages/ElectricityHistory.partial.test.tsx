import { render, screen } from "@testing-library/react";
import type { AnalyticsQueryResponse } from "@climate-twin/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { queryClient } from "../data/queryClient";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { ElectricityHistory } from "./ElectricityHistory";

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

it("explains unavailable consumption without assigning every cause to signed power", async () => {
  const state = createDemoState();
  const sensor = { ...state.sensors[0]!, measurementEntityIds: { energy: "fixture.energy" } };
  state.sensors = [sensor]; state.latestMeasurements = {}; state.measurementHistory = {};
  const now = Date.now();
  vi.spyOn(api, "analyticsQuery").mockResolvedValue({
    resolvedRange: { start: new Date(now - 3_600_000).toISOString(), end: new Date(now).toISOString() }, warnings: [],
    series: [{ entityId: sensor.id, measurementId: "energy", resolution: "5m", summary: { count: 3 },
      points: [0.1, null, 0.2].map((consumptionKwh, index) => ({
        timestamp: new Date(now - (3 - index) * 300_000).toISOString(), value: 10 + index,
        consumptionKwh, sampleCount: 1,
      })) }],
  } as unknown as AnalyticsQueryResponse);
  render(<I18nProvider><ElectricityHistory state={state} sensors={[sensor]} metric="energy"
    onMetric={vi.fn()} units="metric" range="24h" onRange={vi.fn()} timeZone="UTC" /></I18nProvider>);
  expect(await screen.findByText("Some consumption could not be calculated reliably. Only intervals with usable readings are included.")).toBeInTheDocument();
  expect(screen.queryByText(/Signed net-power readings/)).not.toBeInTheDocument();
  expect(screen.getByRole("img")).toBeInTheDocument();
});
