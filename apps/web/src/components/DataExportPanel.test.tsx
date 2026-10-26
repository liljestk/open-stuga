import axe from "axe-core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsQueryRequest, AnalyticsQueryResponse, Sensor } from "@climate-twin/contracts";
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
    cache: { hit: false, keyVersion: "analytics-query-v2" },
  };
}

function responseWithLeadingGaps(input: AnalyticsQueryRequest): AnalyticsQueryResponse {
  const response = responseFor(input);
  const start = Date.parse(input.range.start);
  const latest = new Date(Date.parse(input.range.end) - 60_000).toISOString();
  return {
    ...response,
    series: response.series.map((series) => {
      const populated = series.points[0]!;
      return {
        ...series,
        points: [
          ...Array.from({ length: 12 }, (_, index) => ({
            ...populated,
            timestamp: new Date(start + index * 15 * 60_000).toISOString(),
            value: null,
            minimum: null,
            maximum: null,
            sampleCount: 0,
            coverage: 0,
          })),
          { ...populated, timestamp: latest },
        ],
      };
    }),
  };
}

describe("DataExportPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "scheduledDataExports").mockResolvedValue([]);
    vi.spyOn(api, "systemStorageStatus").mockResolvedValue({
      settings: { timeseries: { kind: "managed", path: null }, backups: { kind: "nas-path", path: "/mnt/stugu/nas" } },
      revision: "storage-revision",
      allowedRoots: ["/mnt/stugu"],
      capability: { available: true, runtime: "docker", agentLastSeenAt: "2026-08-01T10:00:00.000Z", reason: "ready", detail: null },
      operation: null,
    });
  });

  it("does not load scheduled exports while the export disclosure is closed", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const user = userEvent.setup();

    render(<I18nProvider><DataExportPanel state={state} house={house} units="metric" dataMode="demo" /></I18nProvider>);

    expect(api.scheduledDataExports).not.toHaveBeenCalled();
    expect(api.systemStorageStatus).not.toHaveBeenCalled();

    await user.click(screen.getByText("Export sensor data").closest("summary")!);
    await waitFor(() => expect(api.scheduledDataExports).toHaveBeenCalledOnce());
    expect(api.systemStorageStatus).toHaveBeenCalledOnce();
  });

  it("does not expose installation-owned schedules to a Guest", () => {
    const state = createDemoState();
    state.session = { ...state.session, tenant: { ...state.session.tenant, role: "guest" } };
    const house = state.houses[0]!;

    render(<I18nProvider><DataExportPanel state={state} house={house} units="metric" dataMode="demo" /></I18nProvider>);

    expect(screen.queryByText("Scheduled NAS exports")).toBeNull();
    expect(api.scheduledDataExports).not.toHaveBeenCalled();
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

  it("previews recent readings instead of leading empty buckets", async () => {
    const fullState = createDemoState();
    const state = { ...fullState, sensors: [fullState.sensors[0]!] };
    const house = state.houses[0]!;
    vi.spyOn(api, "analyticsQuery").mockImplementation(async (input) => responseWithLeadingGaps(input));
    const user = userEvent.setup();
    render(<I18nProvider><DataExportPanel state={state} house={house} units="metric" dataMode="demo" /></I18nProvider>);

    await user.click(screen.getByText("Export sensor data").closest("summary")!);

    const preview = await screen.findByRole("region", { name: "Sensor data export preview" });
    expect(within(preview).getByText("20.0")).not.toBeNull();
    expect(within(preview).getByText("50")).not.toBeNull();
    expect(screen.getByText("Showing recent rows with readings (1 of 13 total rows).")).not.toBeNull();
  });

  it("keeps archived sensors available for an explicit historical export", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const live = state.sensors.find((sensor) => sensor.houseId === house.id && sensor.enabled)!;
    const archived = {
      ...live,
      id: "export-archived",
      name: "Archive history",
      enabled: false,
      recordedMeasurementIds: ["temperature", "humidity"],
    };
    state.sensors = [...state.sensors, archived];
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockImplementation(async (input) => responseFor(input));
    const user = userEvent.setup();
    render(<I18nProvider><DataExportPanel state={state} house={house} units="metric" dataMode="demo" /></I18nProvider>);

    await user.click(screen.getByText("Export sensor data").closest("summary")!);
    await waitFor(() => expect(analyticsQuery).toHaveBeenCalled());
    expect(analyticsQuery.mock.calls[0]![0].scope.entityIds).not.toContain(archived.id);

    const sensorPicker = screen.getAllByText("Sensors")
      .find((element) => element.tagName === "SPAN")!
      .closest(".data-export-picker-field") as HTMLElement;
    await user.click(within(sensorPicker).getByText(/sensor.*selected/i));
    const archivedChoice = within(sensorPicker).getByLabelText(/Archive history · Archived/);
    expect(archivedChoice).not.toBeChecked();
    await user.click(archivedChoice);
    expect(screen.getByText("Archived sensors are available for one-time historical exports. Scheduled exports currently use live sensors only.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Schedule weekly export" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Update preview" }));

    await waitFor(() => expect(analyticsQuery.mock.calls.at(-1)?.[0].scope.entityIds).toContain(archived.id));
  });

  it("requires an explicit sensor choice when a Home contains archived sensors only", async () => {
    const fullState = createDemoState();
    const house = fullState.houses[0]!;
    const archived = {
      ...fullState.sensors[0]!,
      id: "only-archive",
      name: "Only archived history",
      enabled: false,
      recordedMeasurementIds: ["temperature", "humidity"],
    };
    const state = { ...fullState, sensors: [archived], latestMeasurements: {}, measurementHistory: {} };
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockImplementation(async (input) => responseFor(input));
    const user = userEvent.setup();

    render(<I18nProvider><DataExportPanel state={state} house={house} units="metric" dataMode="demo" /></I18nProvider>);
    await user.click(screen.getByText("Export sensor data").closest("summary")!);

    expect((await screen.findAllByText("Select at least one sensor.")).length).toBeGreaterThan(0);
    expect(analyticsQuery).not.toHaveBeenCalled();
  });

  it("shows and exports only sensors supporting a selected measurement", async () => {
    const fullState = createDemoState();
    const house = fullState.houses[0]!;
    const temperatureSensor: Sensor = {
      ...fullState.sensors[0]!,
      id: "temperature-only",
      name: "Temperature sensor",
      measurementEntityIds: { temperature: "sensor.temperature" },
      temperatureEntityId: "sensor.temperature",
    };
    delete temperatureSensor.humidityEntityId;
    const humiditySensor: Sensor = {
      ...fullState.sensors[1]!,
      id: "humidity-only",
      name: "Humidity sensor",
      measurementEntityIds: { humidity: "sensor.humidity" },
      humidityEntityId: "sensor.humidity",
    };
    delete humiditySensor.temperatureEntityId;
    const archivedTemperatureSensor: Sensor = {
      ...temperatureSensor,
      id: "archived-temperature-only",
      name: "Archived temperature sensor",
      enabled: false,
      measurementEntityIds: {},
      recordedMeasurementIds: ["temperature"],
    };
    delete archivedTemperatureSensor.temperatureEntityId;
    const state = {
      ...fullState,
      sensors: [temperatureSensor, humiditySensor, archivedTemperatureSensor],
      latestMeasurements: {},
      measurementHistory: {},
    };
    const analyticsQuery = vi.spyOn(api, "analyticsQuery").mockImplementation(async (input) => responseFor(input));
    const user = userEvent.setup();
    render(<I18nProvider><DataExportPanel state={state} house={house} units="metric" dataMode="demo" /></I18nProvider>);

    await user.click(screen.getByText("Export sensor data").closest("summary")!);
    await waitFor(() => expect(analyticsQuery).toHaveBeenCalled());
    const measurementPicker = screen.getByText("2 measurements selected").closest(".data-export-picker-field") as HTMLElement;
    await user.click(within(measurementPicker).getByText("2 measurements selected"));
    await user.click(within(measurementPicker).getByText("Humidity").closest("label")!.querySelector<HTMLInputElement>("input")!);

    const sensorPicker = screen.getAllByText("Sensors")
      .find((element) => element.tagName === "SPAN")!
      .closest(".data-export-picker-field") as HTMLElement;
    const sensorSummary = await within(sensorPicker).findByText("1 sensors selected");
    await user.click(sensorSummary);
    expect(within(sensorPicker).getByText("Temperature sensor")).not.toBeNull();
    expect(within(sensorPicker).getByText(/Archived temperature sensor/)).not.toBeNull();
    expect(within(sensorPicker).queryByText("Humidity sensor")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Update preview" }));
    await waitFor(() => expect(analyticsQuery.mock.calls.at(-1)?.[0]).toMatchObject({
      measurementIds: ["temperature"],
      scope: { entityIds: ["temperature-only"] },
    }));

    await user.click(within(measurementPicker).getByText("Humidity").closest("label")!.querySelector<HTMLInputElement>("input")!);
    await user.click(within(measurementPicker).getByText("Temperature").closest("label")!.querySelector<HTMLInputElement>("input")!);
    await waitFor(() => expect(within(sensorPicker).queryByText(/Archived temperature sensor/)).toBeNull());
  });
});
