import axe from "axe-core";
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
    resolution: "15m",
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
  it("compares two explicit Octobers as aligned weekly buckets and can isolate one sensor", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled).slice(0, 2);
    const definition = state.measurementDefinitions.find((item) => item.id === "temperature")!;
    const coverage = vi.spyOn(api, "analyticsCoverage").mockResolvedValue({
      apiVersion: "1.0",
      requestId: "coverage",
      dataMode: "demo",
      range: { start: "2022-09-01T00:00:00.000Z", end: "2024-11-02T00:00:00.000Z" },
      series: sensors.map((sensor) => ({
        entityId: sensor.id,
        entityLabel: sensor.name,
        measurementId: "temperature",
        start: "2022-09-01T00:00:00.000Z",
        end: "2024-11-02T00:00:00.000Z",
      })),
      complete: true,
      archiveState: "not-configured",
      generatedAt: "2026-07-21T00:00:00.000Z",
    });
    const query = vi.spyOn(api, "analyticsQuery").mockImplementation(async (request): Promise<AnalyticsQueryResponse> => {
      const year = Number(request.requestId.match(/calendar-month-(\d{4})-10/)?.[1] ?? 0);
      const bucket = Number(request.requestId.match(/week-(\d)/)?.[1] ?? 0);
      const responseSeries = (request.scope.entityIds ?? []).map((sensorId, index) => {
        const sensor = sensors.find((candidate) => candidate.id === sensorId)!;
        return analyticsSeries(sensorId, sensor.name, request.range.start, (year === 2024 ? 20 : 18) + bucket + index);
      });
      return {
        apiVersion: "1.0",
        requestId: request.requestId,
        dataMode: "demo",
        resolvedRange: request.range,
        resolution: "15m",
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

    const view = render(<I18nProvider><CalendarPeriodComparison
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

    const chartName = "Temperature for Selected sensors average across 2 selected calendar periods.";
    const chart = await screen.findByRole("img", { name: chartName });
    expect(screen.getByRole("region", { name: chartName }).getAttribute("tabindex")).toBe("0");
    expect(screen.getAllByText("Selected sensors average").length).toBeGreaterThan(0);
    expect((screen.getByRole("combobox", { name: "Period A" }) as HTMLSelectElement).value).toBe("2024-10");
    expect((screen.getByRole("combobox", { name: "Period B" }) as HTMLSelectElement).value).toBe("2023-10");
    await waitFor(() => expect(query).toHaveBeenCalledTimes(10));
    expect(query.mock.calls.every(([request]) => request.scope.entityIds?.length === 2)).toBe(true);
    expect(query.mock.calls.map(([request]) => request.range)).toContainEqual({
      start: "2024-09-30T21:00:00.000Z",
      end: "2024-10-07T21:00:00.000Z",
      timezone: "Europe/Helsinki",
    });
    expect(query.mock.calls.map(([request]) => request.range)).toContainEqual({
      start: "2023-10-28T21:00:00.000Z",
      end: "2023-10-31T22:00:00.000Z",
      timezone: "Europe/Helsinki",
    });
    expect(chart.querySelectorAll(".calendar-comparison-series > path")).toHaveLength(2);
    expect(screen.getAllByText("+2.0°C").length).toBeGreaterThan(0);
    const accessibility = await axe.run(view.container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);

    await user.click(screen.getByText("Show accessible comparison table (5 buckets)"));
    const table = within(screen.getByRole("region", { name: "Calendar period comparison data" })).getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getByText("1–7")).not.toBeNull();

    query.mockClear();
    await user.selectOptions(screen.getByRole("combobox", { name: "Sensor scope" }), sensors[0]!.id);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(10));
    expect(query.mock.calls.every(([request]) => request.scope.entityIds?.length === 1)).toBe(true);
    expect(screen.queryByText(/Every bucket uses the same/)).toBeNull();

    const coverageCalls = coverage.mock.calls.length;
    view.rerender(<I18nProvider><CalendarPeriodComparison
      houseId={house.id}
      timeZone="Europe/Helsinki"
      dataMode="demo"
      sensors={sensors.map((sensor) => ({ ...sensor }))}
      metric="temperature"
      definition={definition}
      units="metric"
    /></I18nProvider>);
    expect(coverage).toHaveBeenCalledTimes(coverageCalls);
  });
});
