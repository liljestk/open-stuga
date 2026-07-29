import axe from "axe-core";
import type {
  CalendarComparisonPeriod,
  CalendarComparisonResponse,
  CalendarComparisonSeries,
} from "@climate-twin/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { ServerStateProvider, queryClient } from "../data/queryClient";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { CalendarPeriodComparison } from "./CalendarPeriodComparison";

function period(year: number): CalendarComparisonPeriod {
  return {
    key: `${year}-10`,
    unit: "month",
    start: `${year}-09-30T21:00:00.000Z`,
    end: `${year}-10-31T22:00:00.000Z`,
    naturalEnd: `${year}-10-31T22:00:00.000Z`,
    year,
    month: 10,
    day: null,
    week: null,
    decade: null,
    partial: false,
  };
}

function series(
  selected: CalendarComparisonPeriod,
  sourceId: string,
  sourceLabel: string,
  offset: number,
): CalendarComparisonSeries {
  const points = Array.from({ length: 5 }, (_, index) => ({
    bucket: {
      key: `${selected.key}:week-${index + 1}`,
      slot: `week-${index + 1}`,
      order: index,
      index,
      start: new Date(Date.parse(selected.start) + index * 7 * 86_400_000).toISOString(),
      end: new Date(Math.min(
        Date.parse(selected.end),
        Date.parse(selected.start) + (index + 1) * 7 * 86_400_000,
      )).toISOString(),
      partial: false,
    },
    value: offset + index,
    minimum: offset + index - 1,
    maximum: offset + index + 1,
    sampleCount: 24,
    coverage: 1,
  }));
  return {
    id: `${selected.key}:${sourceId}`,
    sourceId,
    sourceLabel,
    combination: sourceId === "combined" ? "mean" : "single",
    period: selected,
    aggregation: "mean",
    points,
    summary: {
      value: offset + 2,
      minimum: offset - 1,
      maximum: offset + 5,
      sampleCount: 120,
      coverage: 1,
      bucketCount: 5,
    },
  };
}

function response(sensorIds: string[], sensorNames: string[]): CalendarComparisonResponse {
  const current = period(2024);
  const baseline = period(2023);
  const combinedCurrent = series(current, "combined", "Combined sensors", 20);
  const combinedBaseline = series(baseline, "combined", "Combined sensors", 18);
  const singles = sensorIds.flatMap((sensorId, index) => [
    series(current, sensorId, sensorNames[index]!, 20 + index),
    series(baseline, sensorId, sensorNames[index]!, 18 + index),
  ]);
  return {
    apiVersion: "1.0",
    requestId: "calendar-response",
    houseId: "house-main",
    dataMode: "demo",
    measurementId: "temperature",
    unit: "month",
    anchor: { month: 10, day: 15, week: 42 },
    aggregation: "default",
    qualityFilter: { include: ["good", "estimated"] },
    candidates: [baseline, current],
    selectedPeriods: [current, baseline],
    series: [combinedCurrent, combinedBaseline, ...singles],
    comparisons: [{
      sourceId: "combined",
      currentSeriesId: combinedCurrent.id,
      baselineSeriesId: combinedBaseline.id,
      commonCompletedBucketCount: 5,
      difference: 2,
    }, ...sensorIds.map((sensorId) => ({
      sourceId: sensorId,
      currentSeriesId: `${current.key}:${sensorId}`,
      baselineSeriesId: `${baseline.key}:${sensorId}`,
      commonCompletedBucketCount: 5,
      difference: 2,
    }))],
    archiveState: "not-configured",
    generatedAt: "2026-07-29T00:00:00.000Z",
    evaluatedAt: "2026-07-29T00:00:00.000Z",
    completeness: "complete",
    warnings: [],
    provenance: {
      algorithmKey: "calendar-comparison",
      algorithmVersion: "calendar-comparison-v1.0.0",
      evaluatedAt: "2026-07-29T00:00:00.000Z",
      sourceIds: sensorIds,
      archiveState: "not-configured",
    },
  };
}

beforeEach(() => queryClient.clear());
afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("CalendarPeriodComparison", () => {
  it("renders the authoritative response with one request and does not refetch for source display", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors
      .filter((sensor) => sensor.houseId === house.id && sensor.enabled)
      .slice(0, 2);
    const definition = state.measurementDefinitions
      .find((item) => item.id === "temperature")!;
    const calendarComparison = vi.spyOn(api, "calendarComparison")
      .mockResolvedValue(response(
        sensors.map((sensor) => sensor.id),
        sensors.map((sensor) => sensor.name),
      ));
    const analyticsCoverage = vi.spyOn(api, "analyticsCoverage");
    const analyticsQuery = vi.spyOn(api, "analyticsQuery");

    const view = render(
      <ServerStateProvider>
        <I18nProvider>
          <CalendarPeriodComparison
            houseId={house.id}
            timeZone="Europe/Helsinki"
            dataMode="demo"
            sensors={sensors}
            metric="temperature"
            definition={definition}
            units="metric"
          />
        </I18nProvider>
      </ServerStateProvider>,
    );

    await user.click(screen.getByText("Compare calendar periods"));
    const chartName = "Temperature for Selected sensors average across 2 selected calendar periods.";
    const chart = await screen.findByRole("img", { name: chartName });

    expect(calendarComparison).toHaveBeenCalledTimes(1);
    expect(calendarComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        houseId: house.id,
        sensorIds: sensors.map((sensor) => sensor.id),
        measurementId: "temperature",
      }),
      expect.any(AbortSignal),
    );
    expect(analyticsCoverage).not.toHaveBeenCalled();
    expect(analyticsQuery).not.toHaveBeenCalled();
    expect((screen.getByRole("combobox", { name: "Period A" }) as HTMLSelectElement).value)
      .toBe("2024-10");
    expect((screen.getByRole("combobox", { name: "Period B" }) as HTMLSelectElement).value)
      .toBe("2023-10");
    expect(chart.querySelectorAll(".calendar-comparison-series > path")).toHaveLength(2);
    expect(screen.getAllByText("+2.0°C").length).toBeGreaterThan(0);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sensor scope" }),
      sensors[0]!.id,
    );
    await waitFor(() => expect(screen.getAllByText("+2.0°C").length).toBeGreaterThan(0));
    expect(calendarComparison).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Every bucket uses the same/)).toBeNull();

    const accessibility = await axe.run(view.container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });
});
