import type { AnalyticsQueryResponse, AnalyticsSeries } from "@climate-twin/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { CalendarPeriodComparison } from "./CalendarPeriodComparison";

function analyticsSeries(entityId: string, entityLabel: string, timestamp: string, value: number): AnalyticsSeries {
  return {
    entityId,
    entityLabel,
    measurementId: "temperature",
    canonicalUnit: "°C",
    truthClass: "derived",
    aggregation: "mean",
    resolution: "1d",
    points: [{ timestamp, value, minimum: value - 1, maximum: value + 1, sampleCount: 24, coverage: 1, qualityFlags: [] }],
    summary: {
      entityId, measurementId: "temperature", canonicalUnit: "°C", count: 24, coverage: 1,
      minimum: value - 1, maximum: value + 1, mean: value, median: value,
      standardDeviation: 0, medianAbsoluteDeviation: 0, p05: value, p95: value,
    },
    provenance: {
      algorithmKey: "analytics-bucket-rollup", algorithmVersion: "1.0.0", generatedAt: timestamp,
      inputStart: timestamp, inputEnd: timestamp, sourceIds: [entityId], archiveState: "not-configured",
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("CalendarPeriodComparison", () => {
  it("compares every recorded October for the currently selected sensors", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled).slice(0, 2);
    const definition = state.measurementDefinitions.find((item) => item.id === "temperature")!;
    vi.spyOn(api, "analyticsCoverage").mockResolvedValue({
      apiVersion: "1.0",
      requestId: "coverage",
      dataMode: "demo",
      range: { start: "2022-10-10T00:00:00.000Z", end: "2024-10-20T00:00:00.000Z" },
      series: sensors.map((sensor) => ({
        entityId: sensor.id,
        entityLabel: sensor.name,
        measurementId: "temperature",
        start: "2022-10-10T00:00:00.000Z",
        end: "2024-10-20T00:00:00.000Z",
      })),
      complete: true,
      archiveState: "not-configured",
      generatedAt: "2026-07-21T00:00:00.000Z",
    });
    const query = vi.spyOn(api, "analyticsQuery").mockImplementation(async (request): Promise<AnalyticsQueryResponse> => {
      const year = Number(request.range.start.slice(0, 4));
      const availableSensorIds = (request.scope.entityIds ?? [])
        .filter((sensorId) => year !== 2023 || sensorId === sensors[1]!.id);
      const responseSeries = availableSensorIds.map((sensorId, index) => {
        const sensor = sensors.find((candidate) => candidate.id === sensorId)!;
        return analyticsSeries(sensorId, sensor.name, request.range.start, year === 2022 ? 18 + index : 20 + index);
      });
      return {
        apiVersion: "1.0",
        requestId: request.requestId,
        dataMode: "demo",
        resolvedRange: request.range,
        resolution: "1d",
        series: responseSeries,
        summaries: responseSeries.map((item) => item.summary),
        quality: {
          coverage: 1, seriesCount: responseSeries.length, sampleCount: responseSeries.length * 24,
          excludedSampleCount: 0, includedQualities: ["good", "estimated"], lowCoverageSeries: 0,
        },
        provenance: responseSeries.map((item) => item.provenance),
        warnings: [],
        generatedAt: "2026-07-21T00:00:00.000Z",
        cache: { hit: false, keyVersion: "analytics-query-v1" },
      };
    });

    render(<I18nProvider><CalendarPeriodComparison
      houseId={house.id}
      timeZone="Europe/Helsinki"
      dataMode="demo"
      sensors={sensors}
      metric="temperature"
      definition={definition}
      units="metric"
    /></I18nProvider>);

    await user.click(screen.getByText("Compare calendar periods"));
    await waitFor(() => expect(query).toHaveBeenCalled());
    query.mockClear();
    await user.selectOptions(screen.getByRole("combobox", { name: "Month of year" }), "10");

    const chartName = "Temperature across 3 matching calendar periods.";
    const chart = await screen.findByRole("img", { name: chartName });
    expect(screen.getByRole("region", { name: chartName }).getAttribute("tabindex")).toBe("0");
    expect(screen.getAllByText("Selected sensors average").length).toBeGreaterThan(0);
    expect(screen.getByText("matching periods").textContent).toBe("3matching periods");
    await waitFor(() => expect(query).toHaveBeenCalledTimes(3));
    expect(query.mock.calls.map(([request]) => request.scope.entityIds)).toEqual(Array.from(
      { length: 3 },
      () => sensors.map((sensor) => sensor.id),
    ));
    expect(query.mock.calls.map(([request]) => request.range)).toEqual([
      { start: "2022-09-30T21:00:00.000Z", end: "2022-10-31T22:00:00.000Z", timezone: "Europe/Helsinki" },
      { start: "2023-09-30T21:00:00.000Z", end: "2023-10-31T22:00:00.000Z", timezone: "Europe/Helsinki" },
      { start: "2024-09-30T21:00:00.000Z", end: "2024-10-31T22:00:00.000Z", timezone: "Europe/Helsinki" },
    ]);

    const combinedPath = chart.querySelector(".calendar-comparison-series.combined > path")?.getAttribute("d") ?? "";
    expect(combinedPath.match(/M/g)).toHaveLength(2);
    expect(combinedPath).not.toContain("L");

    await user.click(screen.getByText("Show accessible comparison table (3 periods)"));
    const table = within(screen.getByRole("region", { name: "Calendar period comparison data" })).getByRole("table");
    expect(within(table).getAllByText("Selected sensors average")).toHaveLength(2);
    expect(within(table).getAllByRole("row")).toHaveLength(8);
  });
});
