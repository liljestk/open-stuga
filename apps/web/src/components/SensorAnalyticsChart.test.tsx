import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AnalyticsSeries } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import {
  aggregateForecastSeries,
  aggregateObservedSeries,
  SensorAnalyticsChart,
} from "./SensorAnalyticsChart";

describe("SensorAnalyticsChart", () => {
  it("weights sensors equally when building observed and forecast aggregates", () => {
    const bucket = 15 * 60_000;
    const timestamp = Date.parse("2026-07-19T10:00:00.000Z");
    const observed = aggregateObservedSeries([
      { sensorId: "a", points: [{ timestamp, value: 10 }, { timestamp: timestamp + 60_000, value: 14 }] },
      { sensorId: "b", points: [{ timestamp: timestamp + 2 * 60_000, value: 20 }] },
    ], bucket);
    const forecast = aggregateForecastSeries([
      { sensorId: "a", points: [{ timestamp, value: 10, low: 8, high: 12 }] },
      { sensorId: "b", points: [{ timestamp, value: 20, low: 18, high: 22 }] },
    ], bucket);

    expect(observed).toEqual([expect.objectContaining({ value: 16, low: 12, high: 20, sensorCount: 2 })]);
    expect(forecast).toEqual([expect.objectContaining({ value: 15, low: 13, high: 17, sensorCount: 2 })]);
    expect(aggregateObservedSeries([
      { sensorId: "a", points: [{ timestamp, value: 12 }] },
      { sensorId: "b", points: [{ timestamp, value: 20 }] },
    ], bucket, "sum")).toEqual([expect.objectContaining({ value: 32, sensorCount: 2 })]);
  });

  it("renders every sensor together with aggregate and prediction series", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled).slice(0, 3);
    const onMetric = vi.fn();
    const onRange = vi.fn();
    const onSensors = vi.fn();
    const onLoadSeries = vi.fn();
    const { container } = render(
      <I18nProvider>
        <SensorAnalyticsChart
          houseId={house.id}
          dataMode="demo"
          sensors={sensors}
          history={state.measurementHistory}
          forecasts={state.measurementForecasts}
          latestMeasurements={state.latestMeasurements}
          definitions={state.measurementDefinitions}
          metric="temperature"
          units="metric"
          range="24h"
          timeZone={house.timezone}
          selectedSensorIds={null}
          weatherObservationsVisible
          weatherForecastVisible
          onMetric={onMetric}
          onRange={onRange}
          onSensors={onSensors}
          onWeatherObservationsVisible={vi.fn()}
          onWeatherForecastVisible={vi.fn()}
          onLoadSeries={onLoadSeries}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Home sensor analytics" })).not.toBeNull();
    expect(screen.getByRole("img", { name: /Combined Temperature history/ })).not.toBeNull();
    expect(container.querySelectorAll(".sensor-series-line")).toHaveLength(sensors.length);
    expect(container.querySelector(".sensor-aggregate-line")).not.toBeNull();
    expect(container.querySelector(".sensor-prediction-line")).not.toBeNull();
    expect(onLoadSeries).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Power" })).not.toBeNull();
    expect(screen.getByRole("group", { name: "History" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "1 year" })).not.toBeNull();
    const observedLines = Array.from(container.querySelectorAll<SVGPathElement>(".sensor-series-line"));
    expect(observedLines.some((line) => Boolean(line.getAttribute("stroke-dasharray")))).toBe(true);

    const chart = container.querySelector<HTMLElement>(".sensor-analytics-chart-wrap")!;
    const svg = container.querySelector<SVGSVGElement>(".sensor-analytics-chart")!;
    const latestPoint = container.querySelector<SVGCircleElement>(".sensor-analytics-end-label circle")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 1_100, bottom: 300, width: 1_100, height: 300, toJSON: () => ({}),
    } as DOMRect);
    fireEvent(svg, new MouseEvent("pointermove", {
      bubbles: true,
      clientX: Number(latestPoint.getAttribute("cx")),
      clientY: Number(latestPoint.getAttribute("cy")),
    }));
    expect(container.querySelector(".sensor-analytics-hover")).not.toBeNull();
    expect(container.querySelector(".sensor-analytics-tooltip")?.textContent).toContain("Home average");
    fireEvent.pointerLeave(svg);
    expect(container.querySelector(".sensor-analytics-hover")).toBeNull();
    fireEvent.focus(chart);
    expect(container.querySelector(".sensor-analytics-hover")).not.toBeNull();
    fireEvent.keyDown(chart, { key: "ArrowLeft" });

    await user.click(screen.getByText(/Show accessible data table/));
    expect(screen.getByRole("region", { name: "Analytics source data" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Download CSV" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Coverage" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Gap before reading" })).not.toBeNull();

    await user.click(screen.getByLabelText("Choose data series"));
    await user.click(screen.getByRole("checkbox", { name: sensors[0]!.name }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Measurement" }), "humidity");
    await user.click(screen.getByRole("button", { name: "30 days" }));
    expect(onSensors).toHaveBeenCalledWith(sensors.slice(1).map((sensor) => sensor.id));
    expect(onMetric).toHaveBeenCalledWith("humidity");
    expect(onRange).toHaveBeenCalledWith("30d");
  });

  it("shows one sensor without a duplicate aggregate line in individual view", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled).slice(0, 3);
    const selected = sensors[1]!;
    const onLoadSeries = vi.fn();
    const { container } = render(
      <I18nProvider>
        <SensorAnalyticsChart
          houseId={house.id}
          dataMode="demo"
          sensors={sensors}
          history={state.measurementHistory}
          forecasts={state.measurementForecasts}
          latestMeasurements={state.latestMeasurements}
          definitions={state.measurementDefinitions}
          metric="temperature"
          units="metric"
          range="24h"
          timeZone={house.timezone}
          selectedSensorIds={[selected.id]}
          weatherObservationsVisible
          weatherForecastVisible
          onMetric={vi.fn()}
          onRange={vi.fn()}
          onSensors={vi.fn()}
          onWeatherObservationsVisible={vi.fn()}
          onWeatherForecastVisible={vi.fn()}
          onLoadSeries={onLoadSeries}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: selected.name })).not.toBeNull();
    expect(screen.getByRole("img", { name: new RegExp(selected.name) })).not.toBeNull();
    expect(container.querySelectorAll(".sensor-series-line")).toHaveLength(1);
    expect(container.querySelector(".sensor-aggregate-line")).toBeNull();
    expect(onLoadSeries).not.toHaveBeenCalled();
  });

  it("supports an arbitrary multi-sensor comparison", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled).slice(0, 3);
    const selected = sensors.slice(0, 2);
    const { container } = render(
      <I18nProvider>
        <SensorAnalyticsChart
          houseId={house.id}
          dataMode="demo"
          sensors={sensors}
          history={state.measurementHistory}
          forecasts={state.measurementForecasts}
          latestMeasurements={state.latestMeasurements}
          definitions={state.measurementDefinitions}
          metric="temperature"
          units="metric"
          range="24h"
          timeZone={house.timezone}
          selectedSensorIds={selected.map((sensor) => sensor.id)}
          weatherObservationsVisible={false}
          weatherForecastVisible={false}
          onMetric={vi.fn()}
          onRange={vi.fn()}
          onSensors={vi.fn()}
          onWeatherObservationsVisible={vi.fn()}
          onWeatherForecastVisible={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("2 series selected")).not.toBeNull();
    expect(container.querySelectorAll(".sensor-series-line")).toHaveLength(2);
    expect(container.querySelector(".sensor-aggregate-line")).not.toBeNull();
  });

  it("keeps an archived-only selection historical in headings, legends, rows, and comparisons", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const liveSensor = state.sensors.find((sensor) => sensor.houseId === house.id && sensor.enabled)!;
    const archivedSensor = { ...liveSensor, enabled: false };
    const onLoadSeries = vi.fn();

    render(
      <I18nProvider>
        <SensorAnalyticsChart
          houseId={house.id}
          dataMode="demo"
          sensors={[archivedSensor]}
          history={state.measurementHistory}
          forecasts={state.measurementForecasts}
          latestMeasurements={state.latestMeasurements}
          definitions={state.measurementDefinitions}
          metric="temperature"
          units="metric"
          range="24h"
          timeZone={house.timezone}
          selectedSensorIds={[archivedSensor.id]}
          weatherObservationsVisible={false}
          weatherForecastVisible={false}
          onMetric={vi.fn()}
          onRange={vi.fn()}
          onSensors={vi.fn()}
          onWeatherObservationsVisible={vi.fn()}
          onWeatherForecastVisible={vi.fn()}
          onLoadSeries={onLoadSeries}
        />
      </I18nProvider>,
    );

    const archivedName = `${archivedSensor.name} · Archived`;
    expect(screen.getByRole("heading", { name: archivedName })).not.toBeNull();
    expect(screen.getByText("Review preserved historical observations from archived sensors. These series have no live status or prediction.")).not.toBeNull();
    expect(screen.getByText("Historical reading · Archived")).not.toBeNull();
    expect(screen.queryByText("Latest reading")).toBeNull();
    expect(screen.getByText("Compare calendar periods · Historical · Archived")).not.toBeNull();
    expect(screen.getAllByText(archivedName).length).toBeGreaterThan(1);
    expect(onLoadSeries).not.toHaveBeenCalled();

    await user.click(screen.getByText(/Show accessible data table/));
    expect(screen.getAllByRole("rowheader", { name: archivedName }).length).toBeGreaterThan(0);
  });

  it("keeps live and archived series unambiguous in mixed analytics", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled).slice(0, 2);
    const mixedSensors = [sensors[0]!, { ...sensors[1]!, enabled: false }];
    const archivedName = `${mixedSensors[1]!.name} · Archived`;

    render(
      <I18nProvider>
        <SensorAnalyticsChart
          houseId={house.id}
          dataMode="demo"
          sensors={mixedSensors}
          history={state.measurementHistory}
          forecasts={state.measurementForecasts}
          latestMeasurements={state.latestMeasurements}
          definitions={state.measurementDefinitions}
          metric="temperature"
          units="metric"
          range="24h"
          timeZone={house.timezone}
          selectedSensorIds={mixedSensors.map((sensor) => sensor.id)}
          weatherObservationsVisible={false}
          weatherForecastVisible={false}
          onMetric={vi.fn()}
          onRange={vi.fn()}
          onSensors={vi.fn()}
          onWeatherObservationsVisible={vi.fn()}
          onWeatherForecastVisible={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Home sensor analytics · Includes archived history" })).not.toBeNull();
    expect(screen.getByText("Compare live sensor data with preserved archived history. Predictions use live sensors only.")).not.toBeNull();
    expect(screen.getByLabelText("Choose data series")).toHaveTextContent("2 series selected · Includes archived history");
    expect(screen.getAllByText("Home average · Includes archived history").length).toBeGreaterThan(0);
    expect(screen.getByText("Compare calendar periods · Includes archived history")).not.toBeNull();
    expect(screen.getAllByText(archivedName).length).toBeGreaterThan(0);

    await user.click(screen.getByText(/Show accessible data table/));
    expect(screen.getAllByRole("rowheader", { name: archivedName }).length).toBeGreaterThan(0);
  });

  it("marks a leading history gap and reports its recovery state", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensor = state.sensors.find((candidate) => candidate.houseId === house.id && candidate.enabled)!;
    const now = Date.now();
    const firstAt = new Date(now - 20 * 60_000).toISOString();
    const latestAt = new Date(now - 15 * 60_000).toISOString();
    const history = {
      ...state.measurementHistory,
      [sensor.id]: {
        temperature: [
          { sensorId: sensor.id, metric: "temperature", value: 18, canonicalUnit: "\u00b0C", timestamp: firstAt, source: "tp-link" as const, quality: "estimated" as const },
          { sensorId: sensor.id, metric: "temperature", value: 18.2, canonicalUnit: "\u00b0C", timestamp: latestAt, source: "tp-link" as const, quality: "good" as const },
        ],
      },
    };
    const { container } = render(
      <I18nProvider>
        <SensorAnalyticsChart
          houseId={house.id}
          dataMode="demo"
          sensors={[sensor]}
          history={history}
          forecasts={{}}
          latestMeasurements={{ [sensor.id]: { temperature: history[sensor.id]!.temperature![1]! } }}
          definitions={state.measurementDefinitions}
          sensorGaps={[{
            id: 1,
            sensorId: sensor.id,
            metric: "temperature",
            source: "tp-link",
            startedAt: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
            detectedAt: firstAt,
            endedAt: firstAt,
            recoverableUntil: null,
            recoveryState: "partial",
            recoveryCompleteness: "partial",
            recoveredPoints: 2,
            attemptCount: 2,
            lastAttemptAt: firstAt,
            nextAttemptAt: null,
            recoveryError: "The source retained only part of the interval",
          }]}
          metric="temperature"
          units="metric"
          range="24h"
          timeZone={house.timezone}
          selectedSensorIds={null}
          weatherObservationsVisible={false}
          weatherForecastVisible={false}
          onMetric={vi.fn()}
          onRange={vi.fn()}
          onSensors={vi.fn()}
          onWeatherObservationsVisible={vi.fn()}
          onWeatherForecastVisible={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Missing data in 1 selected series")).not.toBeNull();
    expect(screen.getByText("Some history was restored, but part of the interval is still missing.")).not.toBeNull();
    expect(screen.getByText("Missing data")).not.toBeNull();
    expect(container.querySelector(".sensor-data-gap-region")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss data gap notice" }));

    expect(screen.queryByText("Missing data in 1 selected series")).toBeNull();
    expect(screen.getByText("Missing data")).not.toBeNull();
    expect(container.querySelector(".sensor-data-gap-region")).not.toBeNull();
  });

  it("plots the configured property electricity-price schedule without a sensor binding", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const now = Date.now();
    const startAt = new Date(now - 60 * 60_000).toISOString();
    const endAt = new Date(now + 60 * 60_000).toISOString();
    const { container } = render(
      <I18nProvider>
        <SensorAnalyticsChart
          houseId={house.id}
          dataMode="demo"
          sensors={[]}
          history={{}}
          forecasts={{}}
          latestMeasurements={{}}
          definitions={state.measurementDefinitions}
          electricityPrices={[{
            startAt,
            endAt,
            effectivePriceCentsPerKwh: 6.5,
            effectivePriceEurPerKwh: 0.065,
            fetchedAt: startAt,
          }]}
          metric="electricity_price"
          units="metric"
          range="24h"
          timeZone={house.timezone}
          selectedSensorIds={null}
          weatherObservationsVisible={false}
          weatherForecastVisible={false}
          onMetric={vi.fn()}
          onRange={vi.fn()}
          onSensors={vi.fn()}
          onWeatherObservationsVisible={vi.fn()}
          onWeatherForecastVisible={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getAllByText("Property electricity price").length).toBeGreaterThan(0);
    expect(container.querySelector(".sensor-electricity-price-line")).not.toBeNull();
  });

  it("renders batched analytics series and materializes paginated export rows only on demand", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensor = state.sensors.find((candidate) => candidate.houseId === house.id && candidate.enabled)!;
    const end = Date.now() - 60_000;
    const points = Array.from({ length: 300 }, (_, index) => ({
      timestamp: new Date(end - (299 - index) * 60_000).toISOString(),
      value: 18 + index / 100,
      minimum: 18 + index / 100,
      maximum: 18 + index / 100,
      sampleCount: 1,
      coverage: 1,
      qualityFlags: [],
    }));
    const analyticsSeries = [{
      entityId: sensor.id,
      entityLabel: sensor.name,
      measurementId: "temperature",
      canonicalUnit: "°C",
      truthClass: "derived",
      aggregation: "mean",
      resolution: "5m",
      points,
      summary: {
        entityId: sensor.id,
        measurementId: "temperature",
        canonicalUnit: "°C",
        count: points.length,
        coverage: 1,
        minimum: 18,
        maximum: 20.99,
        mean: 19.495,
        median: 19.495,
        standardDeviation: 0.86,
        medianAbsoluteDeviation: 0.75,
        p05: 18.15,
        p95: 20.84,
      },
      provenance: {
        algorithmKey: "analytics-bucket-rollup",
        algorithmVersion: "1.0.0",
        generatedAt: new Date(end).toISOString(),
        inputStart: points[0]!.timestamp,
        inputEnd: points.at(-1)!.timestamp,
        sourceIds: [sensor.id],
        archiveState: "not-configured",
      },
    }] satisfies AnalyticsSeries[];
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:analytics-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { container } = render(
      <I18nProvider>
        <SensorAnalyticsChart
          houseId={house.id}
          dataMode="demo"
          sensors={[sensor]}
          history={{}}
          forecasts={{}}
          analyticsSeries={analyticsSeries}
          analyticsRangeEnd={points.at(-1)!.timestamp}
          latestMeasurements={{}}
          definitions={state.measurementDefinitions}
          metric="temperature"
          units="metric"
          range="24h"
          timeZone={house.timezone}
          selectedSensorIds={null}
          weatherObservationsVisible={false}
          weatherForecastVisible={false}
          onMetric={vi.fn()}
          onRange={vi.fn()}
          onSensors={vi.fn()}
          onWeatherObservationsVisible={vi.fn()}
          onWeatherForecastVisible={vi.fn()}
          onLoadSeries={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(container.querySelectorAll(".sensor-series-line")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Analytics source data" })).toBeNull();
    expect(container.querySelectorAll(".analytics-data-table tbody tr")).toHaveLength(0);
    expect(createObjectUrl).not.toHaveBeenCalled();

    await user.click(screen.getByText(/Show accessible data table/));

    expect(screen.getByRole("region", { name: "Analytics source data" })).not.toBeNull();
    expect(container.querySelectorAll(".analytics-data-table tbody tr")).toHaveLength(250);
    expect(screen.getByRole("button", { name: /Show 50 more/ })).not.toBeNull();
    expect(createObjectUrl).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Download CSV" }));

    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(createObjectUrl.mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect(clickAnchor).toHaveBeenCalledOnce();
  });

  it("extends a completed analytics batch with every newer local history point", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensor = state.sensors.find((candidate) => candidate.houseId === house.id && candidate.enabled)!;
    const boundary = Date.now() - 10 * 60_000;
    const timestamp = (offsetMinutes: number) => new Date(boundary + offsetMinutes * 60_000).toISOString();
    const analyticsSeries = [{
      entityId: sensor.id,
      entityLabel: sensor.name,
      measurementId: "temperature",
      canonicalUnit: "°C",
      truthClass: "derived",
      aggregation: "mean",
      resolution: "5m",
      points: [{ timestamp: timestamp(0), value: 20, minimum: 20, maximum: 20, sampleCount: 1, coverage: 1, qualityFlags: [] }],
      summary: {
        entityId: sensor.id,
        measurementId: "temperature",
        canonicalUnit: "°C",
        count: 1,
        coverage: 1,
        minimum: 20,
        maximum: 20,
        mean: 20,
        median: 20,
        standardDeviation: 0,
        medianAbsoluteDeviation: 0,
        p05: 20,
        p95: 20,
      },
      provenance: {
        algorithmKey: "analytics-bucket-rollup",
        algorithmVersion: "1.0.0",
        generatedAt: timestamp(0),
        inputStart: timestamp(-5),
        inputEnd: timestamp(0),
        sourceIds: [sensor.id],
        archiveState: "not-configured",
      },
    }] satisfies AnalyticsSeries[];
    const sample = (offsetMinutes: number, value: number, quality: "good" | "stale" = "good") => ({
      sensorId: sensor.id,
      metric: "temperature" as const,
      value,
      canonicalUnit: "°C",
      timestamp: timestamp(offsetMinutes),
      source: "tp-link" as const,
      quality,
    });
    const { container } = render(
      <I18nProvider>
        <SensorAnalyticsChart
          houseId={house.id}
          dataMode="demo"
          sensors={[sensor]}
          history={{
            [sensor.id]: {
              temperature: [sample(-1, 19), sample(0, 99), sample(1, 21), sample(2, 98, "stale")],
            },
          }}
          forecasts={{}}
          analyticsSeries={analyticsSeries}
          analyticsRangeEnd={timestamp(0)}
          latestMeasurements={{ [sensor.id]: { temperature: sample(3, 22) } }}
          definitions={state.measurementDefinitions}
          metric="temperature"
          units="metric"
          range="24h"
          timeZone={house.timezone}
          selectedSensorIds={null}
          weatherObservationsVisible={false}
          weatherForecastVisible={false}
          onMetric={vi.fn()}
          onRange={vi.fn()}
          onSensors={vi.fn()}
          onWeatherObservationsVisible={vi.fn()}
          onWeatherForecastVisible={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Show accessible data table (3 rows)")).not.toBeNull();
    await user.click(screen.getByText("Show accessible data table (3 rows)"));
    expect(container.querySelectorAll(".analytics-data-table tbody tr")).toHaveLength(3);
    expect(screen.queryByText(/99\.0/)).toBeNull();
    expect(screen.queryByText(/98\.0/)).toBeNull();
  });
});
