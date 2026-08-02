import axe from "axe-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsQueryRequest, AnalyticsQueryResponse } from "@climate-twin/contracts";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { DataExportPanel } from "./DataExportPanel";

function responseFor(input: AnalyticsQueryRequest): AnalyticsQueryResponse {
  const state = createDemoState();
  const sensors = state.sensors.filter((sensor) => input.scope.entityIds?.includes(sensor.id));
  const definitions = state.measurementDefinitions.filter((definition) => input.measurementIds.includes(definition.id));
  const timestamp = input.range.start;
  const provenance = {
    algorithmKey: "analytics-bucket-rollup",
    algorithmVersion: "1.0.0",
    generatedAt: input.range.end,
    inputStart: input.range.start,
    inputEnd: input.range.end,
    sourceIds: sensors.map((sensor) => sensor.id),
    archiveState: "not-configured" as const,
  };
  const series = sensors.flatMap((sensor, sensorIndex) => definitions.map((definition, definitionIndex) => {
    const value = definition.id === "temperature" ? 20 + sensorIndex / 10 : definition.id === "humidity" ? 50 + sensorIndex : 1 + definitionIndex;
    const summary = {
      entityId: sensor.id,
      measurementId: definition.id,
      canonicalUnit: definition.unit,
      count: 1,
      coverage: 1,
      minimum: value,
      maximum: value,
      mean: value,
      median: value,
      standardDeviation: 0,
      medianAbsoluteDeviation: 0,
      p05: value,
      p95: value,
    };
    return {
      entityId: sensor.id,
      entityLabel: sensor.name,
      measurementId: definition.id,
      canonicalUnit: definition.unit,
      truthClass: "derived" as const,
      aggregation: input.resolution === "raw" ? "raw" as const : (input.aggregation === "default" ? "mean" as const : input.aggregation),
      resolution: input.resolution === "auto" ? "15m" as const : input.resolution,
      points: [{ timestamp, value, minimum: value, maximum: value, sampleCount: 1, coverage: 1, qualityFlags: [] }],
      summary,
      provenance,
    };
  }));
  return {
    apiVersion: "1.0",
    requestId: input.requestId,
    dataMode: input.dataMode,
    resolvedRange: input.range,
    resolution: input.resolution === "auto" ? "15m" : input.resolution,
    series,
    summaries: series.map((item) => item.summary),
    quality: { coverage: 1, seriesCount: series.length, sampleCount: series.length, excludedSampleCount: 0, includedQualities: ["good", "estimated"], lowCoverageSeries: 0 },
    provenance: series.map(() => provenance),
    warnings: [],
    generatedAt: input.range.end,
    cache: { hit: false, keyVersion: "analytics-query-v1" },
  };
}

describe("DataExportPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("previews the requested 30-day, all-sensor, temperature and humidity export before download", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockImplementation(async (input) => responseFor(input));
    const user = userEvent.setup();
    const { container } = render(<I18nProvider><DataExportPanel state={state} house={house} units="metric" dataMode="demo" /></I18nProvider>);

    await user.click(screen.getByText("Export sensor data").closest("summary")!);
    await waitFor(() => expect(analyticsQuery).toHaveBeenCalled());
    const firstInput = analyticsQuery.mock.calls[0]![0];
    expect(firstInput).toMatchObject({
      dataMode: "demo",
      measurementIds: ["temperature", "humidity"],
      resolution: "15m",
      aggregation: "mean",
      qualityFilter: { include: ["good", "estimated"] },
    });
    expect(firstInput.scope.entityIds).toEqual(state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled).map((sensor) => sensor.id));
    expect(Date.parse(firstInput.range.end) - Date.parse(firstInput.range.start)).toBe(30 * 86_400_000);

    const preview = await screen.findByRole("region", { name: "Sensor data export preview" });
    expect(screen.getByRole("columnheader", { name: "Home time" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "UTC timestamp" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Sensor name" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Sensor ID" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Temperature °C" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Humidity %" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download Excel (.xlsx)" })).toBeEnabled();
    const accessibility = await axe.run(preview, { rules: { "color-contrast": { enabled: false } } });
    expect(accessibility.violations).toEqual([]);

    await user.selectOptions(screen.getByRole("combobox", { name: "Time interval" }), "7d");
    await user.selectOptions(screen.getByRole("combobox", { name: "Data granularity" }), "custom");
    await user.clear(screen.getByRole("spinbutton", { name: /Minutes per bucket/ }));
    await user.type(screen.getByRole("spinbutton", { name: /Minutes per bucket/ }), "7");
    await user.click(screen.getByRole("button", { name: "Update preview" }));
    await waitFor(() => expect(analyticsQuery.mock.calls.at(-1)?.[0]).toMatchObject({ resolution: "7m", aggregation: "mean" }));
  });
});
