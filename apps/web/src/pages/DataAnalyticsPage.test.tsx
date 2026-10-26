import axe from "axe-core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsQueryResponse, House, Sensor } from "@climate-twin/contracts";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { queryClient } from "../data/queryClient";
import { analyticsCsv, DataAnalyticsPage } from "./DataAnalyticsPage";

const refreshWeather = vi.fn();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function analyticsResponseFor(house: House, sensors: Sensor[], requestId = "batched-sensors"): AnalyticsQueryResponse {
  const end = new Date(Date.now() - 60_000).toISOString();
  const start = new Date(Date.now() - 60 * 60_000).toISOString();
  const summaries = sensors.map((sensor, index) => ({
    entityId: sensor.id,
    measurementId: "temperature",
    canonicalUnit: "°C",
    count: 1,
    coverage: 1,
    minimum: 19 + index,
    maximum: 19 + index,
    mean: 19 + index,
    median: 19 + index,
    standardDeviation: 0,
    medianAbsoluteDeviation: 0,
    p05: 19 + index,
    p95: 19 + index,
  }));
  const provenance = sensors.map((sensor) => ({
    algorithmKey: "analytics-bucket-rollup",
    algorithmVersion: "1.0.0",
    generatedAt: end,
    inputStart: start,
    inputEnd: end,
    sourceIds: [sensor.id],
    archiveState: "not-configured" as const,
  }));
  return {
    apiVersion: "1.0",
    requestId,
    dataMode: "demo",
    resolvedRange: { start, end, timezone: house.timezone },
    resolution: "15m",
    series: sensors.map((sensor, index) => ({
      entityId: sensor.id,
      entityLabel: sensor.name,
      measurementId: "temperature",
      canonicalUnit: "°C",
      truthClass: "derived",
      aggregation: "mean",
      resolution: "15m",
      points: [{
        timestamp: end,
        value: 19 + index,
        minimum: 19 + index,
        maximum: 19 + index,
        sampleCount: 1,
        coverage: 1,
        qualityFlags: [],
      }],
      summary: summaries[index]!,
      provenance: provenance[index]!,
    })),
    summaries,
    quality: {
      coverage: 1,
      seriesCount: sensors.length,
      sampleCount: sensors.length,
      excludedSampleCount: 0,
      includedQualities: ["good", "estimated"],
      lowCoverageSeries: 0,
    },
    provenance,
    warnings: [],
    generatedAt: end,
    cache: { hit: false, keyVersion: "analytics-query-v2" },
  };
}

function stateWithTemperatureSensors(count: number) {
  const state = createDemoState();
  const house = state.houses[0]!;
  const base = state.sensors.find((sensor) => sensor.houseId === house.id && sensor.enabled
    && Boolean(state.latestMeasurements[sensor.id]?.temperature))!;
  const baseLatest = state.latestMeasurements[base.id]!.temperature!;
  const baseHistory = state.measurementHistory[base.id]!.temperature!;
  const baseForecast = state.measurementForecasts[base.id]?.temperature ?? [];
  const sensors = Array.from({ length: count }, (_, index) => ({
    ...base,
    id: `batch-sensor-${index + 1}`,
    name: `Batch sensor ${index + 1}`,
    enabled: true,
  }));
  state.sensors = [...state.sensors.filter((sensor) => sensor.houseId !== house.id), ...sensors];
  for (const sensor of sensors) {
    state.latestMeasurements[sensor.id] = {
      temperature: { ...baseLatest, sensorId: sensor.id },
    };
    state.measurementHistory[sensor.id] = {
      temperature: baseHistory.map((sample) => ({ ...sample, sensorId: sensor.id })),
    };
    state.measurementForecasts[sensor.id] = { temperature: [...baseForecast] };
  }
  return { state, house, sensors };
}

function stubAncillaryAnalyticsRequests() {
  vi.spyOn(api, "outdoorTemperatureHistory").mockResolvedValue({ samples: [], from: "", to: "", truncated: false });
  vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null, prices: [] });
  vi.spyOn(api, "sensorDataGaps").mockResolvedValue([]);
}

vi.mock("../useHouseWeather", () => ({
  useHouseWeather: () => ({ weather: null, loading: false, error: null, refresh: refreshWeather }),
}));

describe("DataAnalyticsPage", () => {
  beforeEach(() => {
    // Explorer data lives in the shared query cache; each test starts without it.
    queryClient.clear();
    vi.restoreAllMocks();
    refreshWeather.mockReset();
    window.history.replaceState(null, "", "/");
  });

  it("defers auxiliary history until sensor analytics or continuity is opened", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockResolvedValue(analyticsResponseFor(house, state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled)));
    const outdoor = vi.spyOn(api, "outdoorTemperatureHistory").mockResolvedValue({
      samples: [], from: "", to: "", truncated: false,
    });
    const gaps = vi.spyOn(api, "sensorDataGaps").mockResolvedValue([]);
    const prices = vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null, prices: [] });
    const user = userEvent.setup();

    render(<I18nProvider><DataAnalyticsPage
      state={state}
      house={house}
      units="metric"
      dataMode="demo"
      onLoadSeries={vi.fn()}
    /></I18nProvider>);

    await act(async () => Promise.resolve());
    expect(outdoor).not.toHaveBeenCalled();
    expect(gaps).not.toHaveBeenCalled();
    expect(prices).not.toHaveBeenCalled();

    const continuitySummary = screen.getByText("Gaps and recovery").closest("summary")!;
    await user.click(continuitySummary);
    expect(continuitySummary.closest("details")).toHaveAttribute("open");
    await waitFor(() => expect(outdoor).toHaveBeenCalledOnce());
    expect(gaps).toHaveBeenCalledOnce();
    expect(prices).toHaveBeenCalledOnce();
    expect(analyticsQuery).toHaveBeenCalledOnce();
  });

  it("waits for full history before judging gaps and ignores stale outage records over recorded data", async () => {
    const { state, house, sensors } = stateWithTemperatureSensors(1);
    window.history.replaceState(null, "", "/?weather=none");
    const response = analyticsResponseFor(house, sensors);
    response.series[0]!.points = Array.from({ length: 289 }, (_, index) => ({
      ...response.series[0]!.points[0]!,
      timestamp: new Date(Date.now() - (288 - index) * 300_000).toISOString(),
    }));
    const pending = deferred<AnalyticsQueryResponse>();
    vi.spyOn(api, "analyticsQuery").mockReturnValue(pending.promise);
    vi.spyOn(api, "outdoorTemperatureHistory").mockResolvedValue({ samples: [], from: "", to: "", truncated: false });
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null, prices: [] });
    vi.spyOn(api, "sensorDataGaps").mockResolvedValue([{
      id: 999, sensorId: sensors[0]!.id, metric: "temperature", source: "tp-link",
      startedAt: new Date(Date.now() - 30 * 86400_000).toISOString(), endedAt: null,
      recoveryState: "open", recoveredPoints: 0, attemptCount: 0, recoveryError: null,
      detectedAt: new Date().toISOString(), recoverableUntil: null, recoveryCompleteness: "unknown",
      lastAttemptAt: null, nextAttemptAt: null,
    }]);
    const user = userEvent.setup();
    const { container } = render(<I18nProvider><DataAnalyticsPage state={state} house={house}
      units="metric" dataMode="demo" onLoadSeries={vi.fn()} /></I18nProvider>);
    await user.click(screen.getByText("Gaps and recovery").closest("summary")!);
    expect(container.querySelector(".analytics-gap-count")).toBeNull();
    expect(screen.queryByText("No gaps are visible or recorded in this time range.")).toBeNull();
    await act(async () => pending.resolve(response));
    expect(await screen.findByText("0 visible gaps")).toBeVisible();
    expect(screen.getByText("No gaps are visible or recorded in this time range.")).toBeVisible();
  });

  it("keeps last received continuity data visibly stale after a failed refresh and collapse", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockResolvedValue(analyticsResponseFor(house, state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled)));
    vi.spyOn(api, "outdoorTemperatureHistory").mockResolvedValue({ samples: [], from: "", to: "", truncated: false });
    const gaps = vi.spyOn(api, "sensorDataGaps").mockResolvedValue([]);
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: null, prices: [] });
    const user = userEvent.setup();
    const { container } = render(<I18nProvider><DataAnalyticsPage
      state={state}
      house={house}
      units="metric"
      dataMode="demo"
      onLoadSeries={vi.fn()}
    /></I18nProvider>);

    const continuitySummary = screen.getByText("Gaps and recovery").closest("summary")!;
    await user.click(continuitySummary);
    await waitFor(() => expect(container.querySelector(".analytics-gap-count")).not.toBeNull());
    expect(container.querySelector(".analytics-gap-count")).toHaveTextContent(/visible gaps/);

    gaps.mockRejectedValueOnce(new Error("Gap refresh unavailable"));
    await user.click(container.querySelector<HTMLButtonElement>(".analytics-page-heading > button")!);
    expect(await screen.findByText("Stale · last received data")).toBeVisible();
    expect(screen.queryByText(/visible gaps/)).toBeNull();
    expect(screen.getByText(/Show \d+ gap details/)).toBeVisible();

    await user.click(continuitySummary);
    expect(continuitySummary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Stale · last received data")).toBeVisible();
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
    const outdoorTemperatureHistory = vi.spyOn(api, "outdoorTemperatureHistory").mockResolvedValue({
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
      cache: { hit: false, keyVersion: "analytics-query-v2" },
    } satisfies AnalyticsQueryResponse;
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockResolvedValue(analyticsResponse);
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
    await waitFor(() => expect(api.analyticsQuery).toHaveBeenCalledTimes(1));
    const sensorBatch = vi.mocked(api.analyticsQuery).mock.calls[0]![0];
    expect(sensorBatch.scope.kind).toBe("house");
    expect(sensorBatch.scope.entityIds).toContain(sensor.id);
    expect((sensorBatch.scope.entityIds ?? []).length).toBeGreaterThan(1);
    expect(sensorBatch.measurementIds).toEqual(["temperature"]);
    expect(onLoadSeries).not.toHaveBeenCalled();
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
    expect(vi.mocked(api.analyticsQuery).mock.calls.every(([input]) => input.requestId.startsWith("explorer-"))).toBe(true);
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
    expect(api.analyticsQuery).toHaveBeenCalledTimes(1);
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

    outdoorTemperatureHistory.mockRejectedValueOnce(new Error("Outdoor history unavailable"));
    analyticsQuery.mockRejectedValueOnce(new Error("Evidence refresh unavailable"));
    await user.click(container.querySelector<HTMLButtonElement>(".analytics-page-heading > button")!);
    await waitFor(() => expect(screen.getByText("Outdoor history unavailable")).not.toBeNull());
    const recoveryNotice = screen.getByText("Outdoor history unavailable").closest("[role=alert]");
    expect(recoveryNotice).toHaveTextContent("History could not be refreshed. The last received values remain visible.");
    expect(recoveryNotice).toHaveTextContent("Evidence refresh unavailable");
    expect(screen.getAllByText("Evidence refresh unavailable")).toHaveLength(1);
    expect(screen.getByText("4 samples")).not.toBeNull();
    expect(container.querySelector(".sensor-outdoor-line")).not.toBeNull();

    outdoorTemperatureHistory.mockRejectedValueOnce(new Error("History service unavailable"));
    analyticsQuery.mockRejectedValueOnce(new Error("History service unavailable"));
    await user.click(container.querySelector<HTMLButtonElement>(".analytics-page-heading > button")!);
    await waitFor(() => expect(screen.getAllByText("History service unavailable")).toHaveLength(1));

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

  it("aborts the batched observation request when the selected identity changes and on unmount", async () => {
    const { state, house, sensors } = stateWithTemperatureSensors(3);
    stubAncillaryAnalyticsRequests();
    const signals: AbortSignal[] = [];
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockImplementation((_input, signal) => {
      signals.push(signal!);
      return new Promise<AnalyticsQueryResponse>(() => undefined);
    });
    const onLoadSeries = vi.fn();
    const user = userEvent.setup();
    const view = render(<I18nProvider><DataAnalyticsPage
      state={state}
      house={house}
      units="metric"
      dataMode="demo"
      onLoadSeries={onLoadSeries}
    /></I18nProvider>);

    await user.click(screen.getByText("Home sensor analytics").closest("summary")!);
    await waitFor(() => expect(analyticsQuery).toHaveBeenCalledTimes(1));
    expect(analyticsQuery.mock.calls[0]![0].scope.entityIds).toEqual(sensors.map((sensor) => sensor.id));
    expect(signals[0]!.aborted).toBe(false);
    expect(onLoadSeries).not.toHaveBeenCalled();

    const sourcePicker = screen.getByLabelText("Choose data series").closest("details")!;
    await user.click(within(sourcePicker).getByLabelText(sensors[0]!.name));

    await waitFor(() => expect(analyticsQuery).toHaveBeenCalledTimes(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(analyticsQuery.mock.calls[1]![0].scope.entityIds).toEqual(sensors.slice(1).map((sensor) => sensor.id));
    expect(analyticsQuery.mock.calls[1]![0].requestId).not.toBe(analyticsQuery.mock.calls[0]![0].requestId);
    expect(signals[1]!.aborted).toBe(false);

    view.unmount();
    expect(signals[1]!.aborted).toBe(true);
  });

  it("starts at most two optional forecasts after the observed batch without holding observed loading", async () => {
    const { state, house, sensors } = stateWithTemperatureSensors(4);
    stubAncillaryAnalyticsRequests();
    const observed = deferred<AnalyticsQueryResponse>();
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockReturnValue(observed.promise);
    const pendingForecasts: Deferred<{ forecast: [] }>[] = [];
    let activeForecasts = 0;
    let maximumActiveForecasts = 0;
    const measurementForecast = vi.spyOn(api, "measurementForecastWithEvaluation").mockImplementation(() => {
      const pending = deferred<{ forecast: [] }>();
      pendingForecasts.push(pending);
      activeForecasts += 1;
      maximumActiveForecasts = Math.max(maximumActiveForecasts, activeForecasts);
      return pending.promise.finally(() => {
        activeForecasts -= 1;
      });
    });
    const user = userEvent.setup();
    const { container } = render(<I18nProvider><DataAnalyticsPage
      state={state}
      house={house}
      units="metric"
      dataMode="demo"
      onLoadSeries={vi.fn()}
    /></I18nProvider>);

    await user.click(screen.getByText("Home sensor analytics").closest("summary")!);
    await waitFor(() => expect(analyticsQuery).toHaveBeenCalledTimes(1));
    expect(analyticsQuery.mock.calls[0]![0].scope.entityIds).toEqual(sensors.map((sensor) => sensor.id));
    expect(measurementForecast).not.toHaveBeenCalled();

    act(() => observed.resolve(analyticsResponseFor(house, sensors, analyticsQuery.mock.calls[0]![0].requestId)));

    await waitFor(() => expect(measurementForecast).toHaveBeenCalledTimes(2));
    expect(maximumActiveForecasts).toBe(2);
    expect(activeForecasts).toBe(2);
    expect(await screen.findByRole("img", { name: /Combined Temperature history/ })).not.toBeNull();
    const pageRefresh = container.querySelector<HTMLButtonElement>(".analytics-page-heading > button")!;
    await waitFor(() => expect(pageRefresh).not.toBeDisabled());

    act(() => pendingForecasts[0]!.resolve({ forecast: [] }));
    await waitFor(() => expect(measurementForecast).toHaveBeenCalledTimes(3));
    expect(maximumActiveForecasts).toBe(2);
    expect(activeForecasts).toBe(2);

    act(() => pendingForecasts[1]!.resolve({ forecast: [] }));
    await waitFor(() => expect(measurementForecast).toHaveBeenCalledTimes(4));
    expect(maximumActiveForecasts).toBe(2);
    expect(activeForecasts).toBe(2);

    act(() => {
      pendingForecasts.slice(2).forEach((pending) => pending.resolve({ forecast: [] }));
    });
    await waitFor(() => expect(activeForecasts).toBe(0));
  });

  it("invalidates forecast cache entries across selection, data-mode, and explicit refresh identities", async () => {
    const { state, house, sensors } = stateWithTemperatureSensors(2);
    stubAncillaryAnalyticsRequests();
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockImplementation(async (input) => analyticsResponseFor(
      house,
      sensors.filter((sensor) => (input.scope.entityIds ?? []).includes(sensor.id)),
      input.requestId,
    ));
    const measurementForecast = vi.spyOn(api, "measurementForecastWithEvaluation").mockResolvedValue({ forecast: [] });
    const user = userEvent.setup();
    const panel = (dataMode: "demo" | "real") => <I18nProvider><DataAnalyticsPage
      state={state}
      house={house}
      units="metric"
      dataMode={dataMode}
      onLoadSeries={vi.fn()}
    /></I18nProvider>;
    const view = render(panel("demo"));

    await user.click(screen.getByText("Home sensor analytics").closest("summary")!);
    await waitFor(() => expect(analyticsQuery).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(measurementForecast).toHaveBeenCalledTimes(2));
    const firstRequestId = analyticsQuery.mock.calls[0]![0].requestId;

    const sourcePicker = screen.getByLabelText("Choose data series").closest("details")!;
    await user.click(within(sourcePicker).getByLabelText(sensors[0]!.name));

    await waitFor(() => expect(analyticsQuery).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(measurementForecast).toHaveBeenCalledTimes(3));
    const selectionRequestId = analyticsQuery.mock.calls[1]![0].requestId;
    expect(selectionRequestId).not.toBe(firstRequestId);

    view.rerender(panel("real"));

    await waitFor(() => expect(analyticsQuery).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(measurementForecast).toHaveBeenCalledTimes(4));
    const liveRequestId = analyticsQuery.mock.calls[2]![0].requestId;
    expect(analyticsQuery.mock.calls[2]![0].dataMode).toBe("live");
    expect(liveRequestId).not.toBe(selectionRequestId);

    await user.click(view.container.querySelector<HTMLButtonElement>(".analytics-page-heading > button")!);

    await waitFor(() => expect(analyticsQuery).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(measurementForecast).toHaveBeenCalledTimes(5));
    expect(analyticsQuery.mock.calls[3]![0].requestId).not.toBe(liveRequestId);
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
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockImplementation(async (input) => analyticsResponseFor(
      house,
      state.sensors.filter((sensor) => (input.scope.entityIds ?? []).includes(sensor.id)),
      input.requestId,
    ));
    vi.spyOn(api, "measurementForecastWithEvaluation").mockResolvedValue({ forecast: [] });
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
    await waitFor(() => expect(analyticsQuery.mock.calls.at(-1)?.[0].scope.entityIds).toContain(archived.id));
    expect(onLoadSeries).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByRole("combobox", { name: "Measurement" }), "energy");
    await waitFor(() => expect(within(sourcePicker).queryByLabelText("Archived analytics sensor · Archived")).toBeNull());
  });
});
