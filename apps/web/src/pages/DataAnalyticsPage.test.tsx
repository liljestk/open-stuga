import axe from "axe-core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
    window.history.replaceState(null, "", "/");
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
    const thermalIsolation = vi.spyOn(api, "cachedThermalIsolation").mockRejectedValue(new Error("Unavailable"));
    vi.spyOn(api, "openingStateHistory").mockResolvedValue([]);
    vi.spyOn(api, "actionRuns").mockResolvedValue([]);
    vi.spyOn(api, "sensorDataGaps").mockResolvedValue([{
      id: 1,
      sensorId: sensor.id,
      metric: "temperature",
      source: "tp-link",
      startedAt: beforeGap,
      detectedAt: afterGap,
      endedAt: afterGap,
      recoverableUntil: null,
      recoveryState: "not-supported",
      recoveryCompleteness: "none",
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
    expect(screen.getByRole("heading", { name: "Explore further", level: 2 })).not.toBeNull();
    expect(screen.queryByRole("region", { name: "How the Home has been performing" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Home sensor analytics" })).toBeNull();
    const performanceSummary = screen.getByText("How the Home has been performing").closest("summary")!;
    const openingSummary = screen.getByText("Door & window activity").closest("summary")!;
    const sensorsSummary = screen.getByText("Home sensor analytics").closest("summary")!;
    expect(performanceSummary.closest("details")?.open).toBe(false);
    expect(openingSummary.closest("details")?.open).toBe(false);
    expect(sensorsSummary.closest("details")?.open).toBe(false);
    await user.click(performanceSummary);
    const performancePanel = await screen.findByRole("region", { name: "How the Home has been performing" });
    expect(screen.getAllByText("How the Home has been performing")).toHaveLength(1);
    expect(screen.getAllByText("A calm recent view of comfort exposure, recovery, openings, energy, completed actions, and monitoring confidence.")).toHaveLength(1);
    await user.click(sensorsSummary);
    expect(await screen.findByRole("heading", { name: "Home sensor analytics" })).not.toBeNull();
    expect(new URLSearchParams(window.location.search).get("tools")).toBe("performance,sensors");
    await waitFor(() => expect(screen.getByText("Source has no history")).not.toBeNull());
    const accessibility = await axe.run(performancePanel, {
      rules: {
        // jsdom does not compute the visual styles needed for a reliable contrast result.
        "color-contrast": { enabled: false },
      },
    });
    expect(accessibility.violations).toEqual([]);
    expect(screen.getByText("Missing TP-Link history?")).not.toBeNull();
    expect(screen.getByText(/History → View All → Download/)).not.toBeNull();
    expect(screen.getAllByText(sensor.name).length).toBeGreaterThan(0);
    expect(thermalIsolation).not.toHaveBeenCalled();
    expect(vi.mocked(api.analyticsQuery).mock.calls.some(([input]) => input.requestId.startsWith("explorer-"))).toBe(false);
    const isolationSummary = screen.getByText("Thermal isolation comparison").closest("summary");
    await user.click(isolationSummary!);
    await waitFor(() => expect(thermalIsolation).toHaveBeenCalledOnce());
    const isolationSignal = thermalIsolation.mock.calls[0]?.[2];
    expect(isolationSignal?.aborted).toBe(false);
    await user.click(isolationSummary!);
    await waitFor(() => expect(isolationSignal?.aborted).toBe(true));
    const evidenceSummary = screen.getByText("Summary and source data").closest("summary");
    expect(evidenceSummary?.closest("details")?.open).toBe(false);
    await user.click(evidenceSummary!);
    expect(evidenceSummary?.closest("details")?.open).toBe(true);
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

  it("deep-links analytics evidence controls and canonicalizes defaults on popstate", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const firstSensor = state.sensors.find((sensor) => sensor.houseId === house.id && sensor.enabled)!;
    const secondSensor = { ...firstSensor, id: "analytics-second", name: "Second analytics sensor" };
    state.sensors = [...state.sensors, secondSensor];
    state.latestMeasurements[secondSensor.id] = { ...state.latestMeasurements[firstSensor.id] };
    state.measurementHistory[secondSensor.id] = { ...state.measurementHistory[firstSensor.id] };
    state.measurementForecasts[secondSensor.id] = { ...state.measurementForecasts[firstSensor.id] };
    vi.spyOn(api, "outdoorTemperatureHistory").mockResolvedValue({ samples: [], from: "", to: "", truncated: false });
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null, prices: [] });
    vi.spyOn(api, "sensorDataGaps").mockResolvedValue([]);
    window.history.replaceState(null, "", `/properties/${house.propertyId}/homes/${house.id}/analytics?keep=yes&range=7d&resolution=1h&aggregation=max&quality=good&sensors=${firstSensor.id}&weather=none#evidence`);

    const user = userEvent.setup();
    render(<I18nProvider><DataAnalyticsPage
      state={state}
      house={house}
      units="metric"
      dataMode="demo"
      onLoadSeries={vi.fn()}
    /></I18nProvider>);

    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveValue("1h");
    expect(screen.getByRole("combobox", { name: "Aggregation" })).toHaveValue("max");
    expect(screen.getByRole("combobox", { name: "Source quality" })).toHaveValue("good");
    expect(screen.getByRole("combobox", { name: "Measurement" })).toHaveValue("temperature");
    const sourcePicker = screen.getByLabelText("Choose data series").closest("details")!;
    expect(within(sourcePicker).getByLabelText(firstSensor.name)).toBeChecked();
    expect(within(sourcePicker).getByLabelText(secondSensor.name)).not.toBeChecked();
    expect(within(sourcePicker).getByLabelText("FMI observations")).not.toBeChecked();
    expect(within(sourcePicker).getByLabelText("FMI forecast")).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "30 days" }));
    expect(new URLSearchParams(window.location.search).get("range")).toBe("30d");
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");
    expect(new URLSearchParams(window.location.search).get("sensors")).toBe(firstSensor.id);
    expect(new URLSearchParams(window.location.search).get("weather")).toBe("none");
    expect(window.location.hash).toBe("#evidence");

    await user.selectOptions(screen.getByRole("combobox", { name: "Resolution" }), "raw");
    expect(new URLSearchParams(window.location.search).get("resolution")).toBe("raw");
    expect(new URLSearchParams(window.location.search).has("aggregation")).toBe(false);
    expect(screen.getByRole("combobox", { name: "Aggregation" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Aggregation" })).toHaveValue("default");

    await user.selectOptions(screen.getByRole("combobox", { name: "Measurement" }), "humidity");
    expect(new URLSearchParams(window.location.search).get("metric")).toBe("humidity");
    await user.selectOptions(screen.getByRole("combobox", { name: "Measurement" }), "temperature");
    expect(new URLSearchParams(window.location.search).has("metric")).toBe(false);
    await user.click(within(sourcePicker).getByLabelText(secondSensor.name));
    expect(new URLSearchParams(window.location.search).get("sensors")).toBe(
      [firstSensor.id, secondSensor.id].sort().join(","),
    );
    await user.click(within(sourcePicker).getByLabelText("FMI observations"));
    expect(new URLSearchParams(window.location.search).get("weather")).toBe("observations");
    await user.click(within(sourcePicker).getByLabelText("FMI forecast"));
    expect(new URLSearchParams(window.location.search).has("weather")).toBe(false);
    await user.click(within(sourcePicker).getByRole("button", { name: "Clear" }));
    expect(new URLSearchParams(window.location.search).get("sensors")).toBe("none");
    expect(new URLSearchParams(window.location.search).get("weather")).toBe("none");

    await user.selectOptions(screen.getByRole("combobox", { name: "Resolution" }), "auto");
    await user.selectOptions(screen.getByRole("combobox", { name: "Source quality" }), "reliable");
    await user.click(screen.getByRole("button", { name: "24 hours" }));
    await user.click(within(sourcePicker).getByRole("button", { name: "Select all" }));
    expect(window.location.search).toBe("?keep=yes");

    act(() => {
      window.history.pushState(null, "", "?keep=yes&range=invalid&resolution=invalid&aggregation=invalid&quality=invalid&metric=invalid&sensors=missing&weather=invalid#evidence");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "24 hours" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveValue("auto");
    expect(screen.getByRole("combobox", { name: "Aggregation" })).toHaveValue("default");
    expect(screen.getByRole("combobox", { name: "Source quality" })).toHaveValue("reliable");
    expect(screen.getByRole("combobox", { name: "Measurement" })).toHaveValue("temperature");
    expect(window.location.search).toBe("?keep=yes");

    act(() => {
      window.history.pushState(null, "", `?keep=yes&range=90d&resolution=1d&aggregation=mean&quality=all&sensors=${firstSensor.id}&weather=forecast#evidence`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "90 days" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveValue("1d");
    expect(screen.getByRole("combobox", { name: "Aggregation" })).toHaveValue("mean");
    expect(screen.getByRole("combobox", { name: "Source quality" })).toHaveValue("all");
    expect(within(sourcePicker).getByLabelText(firstSensor.name)).toBeChecked();
    expect(within(sourcePicker).getByLabelText(secondSensor.name)).not.toBeChecked();
    expect(within(sourcePicker).getByLabelText("FMI observations")).not.toBeChecked();
    expect(within(sourcePicker).getByLabelText("FMI forecast")).toBeChecked();

    act(() => {
      window.history.pushState(null, "", `/properties/${house.propertyId}/homes/${house.id}/electricity?range=7d&metric=energy&cost=7d#history`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(window.location.search).toBe("?range=7d&metric=energy&cost=7d");
    expect(window.location.hash).toBe("#history");
  });

  it("offers archived history for explicit analysis without treating it as live", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const live = state.sensors.find((sensor) => sensor.houseId === house.id && sensor.enabled)!;
    const archived = {
      ...live,
      id: "analytics-archived",
      name: "Archived analytics sensor",
      enabled: false,
      recordedMeasurementIds: ["temperature"],
    };
    state.sensors = [...state.sensors, archived];
    vi.spyOn(api, "outdoorTemperatureHistory").mockResolvedValue({ samples: [], from: "", to: "", truncated: false });
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null, prices: [] });
    vi.spyOn(api, "sensorDataGaps").mockResolvedValue([]);
    const onLoadSeries = vi.fn();
    const user = userEvent.setup();

    render(<I18nProvider><DataAnalyticsPage
      state={state}
      house={house}
      units="metric"
      dataMode="demo"
      onLoadSeries={onLoadSeries}
    /></I18nProvider>);

    await user.click(screen.getByText("Home sensor analytics").closest("summary")!);
    const sourcePicker = screen.getByLabelText("Choose data series").closest("details")!;
    const archivedChoice = within(sourcePicker).getByLabelText("Archived analytics sensor · Archived");
    expect(archivedChoice).not.toBeChecked();

    await user.click(archivedChoice);
    await waitFor(() => expect(within(sourcePicker).getByLabelText("Archived analytics sensor · Archived")).toBeChecked());
    expect(new URLSearchParams(window.location.search).get("sensors")?.split(",")).toContain(archived.id);
    await waitFor(() => expect(onLoadSeries).toHaveBeenCalledWith(
      archived.id,
      "temperature",
      "24h",
      false,
    ));

    await user.selectOptions(screen.getByRole("combobox", { name: "Measurement" }), "energy");
    await waitFor(() => expect(within(sourcePicker).queryByLabelText("Archived analytics sensor · Archived")).toBeNull());
  });
});
