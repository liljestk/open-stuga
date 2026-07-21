import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsQueryResponse } from "@climate-twin/contracts";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { analyticsCsv, DataAnalyticsPage } from "./DataAnalyticsPage";

const refreshWeather = vi.fn();

vi.mock("../useHouseWeather", () => ({
  useHouseWeather: () => ({ weather: null, loading: false, error: null, refresh: refreshWeather }),
}));

describe("DataAnalyticsPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    refreshWeather.mockReset();
  });

  it("combines sensor analytics with outdoor history and durable gap recovery state", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensor = state.sensors.find((candidate) => candidate.houseId === house.id && candidate.enabled)!;
    const now = Date.now();
    const beforeGap = new Date(now - 10 * 60 * 60_000).toISOString();
    const beforeGapNext = new Date(now - 10 * 60 * 60_000 + 5 * 60_000).toISOString();
    const afterGap = new Date(now - 2 * 60 * 60_000).toISOString();
    const afterGapNext = new Date(now - 2 * 60 * 60_000 + 5 * 60_000).toISOString();
    state.measurementHistory[sensor.id] = {
      ...state.measurementHistory[sensor.id],
      temperature: [
        { sensorId: sensor.id, metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: beforeGap, source: "tp-link", quality: "good" },
        { sensorId: sensor.id, metric: "temperature", value: 20.1, canonicalUnit: "°C", timestamp: beforeGapNext, source: "tp-link", quality: "good" },
        { sensorId: sensor.id, metric: "temperature", value: 19, canonicalUnit: "°C", timestamp: afterGap, source: "tp-link", quality: "good" },
        { sensorId: sensor.id, metric: "temperature", value: 19.1, canonicalUnit: "°C", timestamp: afterGapNext, source: "tp-link", quality: "good" },
      ],
    };
    vi.spyOn(api, "outdoorTemperatureHistory").mockResolvedValue({
      samples: [
        { houseId: house.id, locationKey: "test", timestamp: beforeGap, temperatureC: 12, source: "fmi-observation", fetchedAt: beforeGap, stationId: "1", stationName: "Test" },
        { houseId: house.id, locationKey: "test", timestamp: beforeGapNext, temperatureC: 12.1, source: "fmi-observation", fetchedAt: beforeGapNext, stationId: "1", stationName: "Test" },
        { houseId: house.id, locationKey: "test", timestamp: afterGap, temperatureC: 11, source: "fmi-backfill", fetchedAt: afterGap, stationId: "1", stationName: "Test" },
        { houseId: house.id, locationKey: "test", timestamp: afterGapNext, temperatureC: 11.1, source: "fmi-backfill", fetchedAt: afterGapNext, stationId: "1", stationName: "Test" },
      ],
      from: beforeGap,
      to: afterGap,
      truncated: false,
    });
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null, prices: [] });
    const analyticsResponse = {
      apiVersion: "1.0",
      requestId: "test-query",
      dataMode: "demo",
      resolvedRange: { start: beforeGap, end: afterGapNext, timezone: house.timezone },
      resolution: "15m",
      series: [{
        entityId: sensor.id,
        entityLabel: sensor.name,
        measurementId: "temperature",
        canonicalUnit: "°C",
        truthClass: "derived",
        aggregation: "mean",
        resolution: "15m",
        points: [{ timestamp: afterGap, value: 19.05, minimum: 19, maximum: 19.1, sampleCount: 2, coverage: 1, qualityFlags: [] }],
        summary: { entityId: sensor.id, measurementId: "temperature", canonicalUnit: "°C", count: 4, coverage: 1, minimum: 19, maximum: 20.1, mean: 19.55, median: 19.55, standardDeviation: .5, medianAbsoluteDeviation: .5, p05: 19, p95: 20.1 },
        provenance: { algorithmKey: "analytics-bucket-rollup", algorithmVersion: "1.0.0", generatedAt: afterGapNext, inputStart: beforeGap, inputEnd: afterGapNext, sourceIds: [sensor.id], archiveState: "not-configured" },
      }],
      summaries: [{ entityId: sensor.id, measurementId: "temperature", canonicalUnit: "°C", count: 4, coverage: 1, minimum: 19, maximum: 20.1, mean: 19.55, median: 19.55, standardDeviation: .5, medianAbsoluteDeviation: .5, p05: 19, p95: 20.1 }],
      quality: {
        coverage: 1,
        seriesCount: 1,
        sampleCount: 4,
        excludedSampleCount: 0,
        includedQualities: ["good", "estimated"],
        lowCoverageSeries: 0,
      },
      provenance: [{ algorithmKey: "analytics-bucket-rollup", algorithmVersion: "1.0.0", generatedAt: afterGapNext, inputStart: beforeGap, inputEnd: afterGapNext, sourceIds: [sensor.id], archiveState: "not-configured" }],
      warnings: [],
      generatedAt: afterGapNext,
      cache: { hit: false, keyVersion: "analytics-query-v1" },
    } satisfies AnalyticsQueryResponse;
    vi.spyOn(api, "analyticsQuery").mockResolvedValue(analyticsResponse);
    vi.spyOn(api, "sensorDataGaps").mockResolvedValue([{
      id: 1,
      sensorId: sensor.id,
      metric: "temperature",
      source: "tp-link",
      startedAt: beforeGap,
      detectedAt: afterGap,
      endedAt: afterGap,
      recoveryState: "not-supported",
      recoveredPoints: 0,
      attemptCount: 1,
      lastAttemptAt: afterGap,
      nextAttemptAt: null,
      recoveryError: "The local device API does not expose history",
    }]);

    const user = userEvent.setup();
    const onLoadSeries = vi.fn();
    const { container } = render(<I18nProvider><DataAnalyticsPage
      state={state}
      house={house}
      units="metric"
      dataMode="demo"
      onLoadSeries={onLoadSeries}
    /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Data & analytics", level: 1 })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Home sensor analytics" })).not.toBeNull();
    await waitFor(() => expect(screen.getByText("Source has no history")).not.toBeNull());
    expect(screen.getByText("Missing TP-Link history?")).not.toBeNull();
    expect(screen.getByText(/History → View All → Download/)).not.toBeNull();
    expect(screen.getAllByText(sensor.name).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("4 samples")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Export CSV" })).not.toBeNull();
    const csv = analyticsCsv({
      ...analyticsResponse,
      series: analyticsResponse.series.map((series) => ({ ...series, entityLabel: "=formula" })),
    });
    expect(csv).toContain("api_version,data_mode,request_id,timezone,range_start,range_end,generated_at");
    expect(csv).toContain("quality_filter,excluded_source_samples");
    expect(csv).toContain("good|estimated,0");
    expect(csv).toContain("'=formula");
    expect(container.querySelector(".sensor-outdoor-line")).not.toBeNull();
    expect(api.outdoorTemperatureHistory).toHaveBeenCalledWith(
      house.id,
      expect.any(String),
      expect.any(String),
      100_000,
      expect.any(AbortSignal),
    );

    expect(screen.getByRole("button", { name: "1 year" })).not.toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Resolution" }), "1h");
    await user.selectOptions(screen.getByRole("combobox", { name: "Aggregation" }), "max");
    await user.selectOptions(screen.getByRole("combobox", { name: "Source quality" }), "good");
    await waitFor(() => expect(api.analyticsQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolution: "1h",
        aggregation: "max",
        qualityFilter: { include: ["good"] },
      }),
      expect.any(AbortSignal),
    ));
  });
});
