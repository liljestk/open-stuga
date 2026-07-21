import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
    expect(onLoadSeries).toHaveBeenCalledTimes(sensors.length);
    expect(screen.getByRole("option", { name: "Power" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "1 year" })).not.toBeNull();

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
    expect(onLoadSeries).toHaveBeenCalledTimes(1);
  });

  it("supports an arbitrary multi-sensor comparison", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled).slice(0, 3);
    const selected = sensors.slice(0, 2);
    const { container } = render(
      <I18nProvider>
        <SensorAnalyticsChart
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

  it("plots the configured property electricity-price schedule without a sensor binding", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const now = Date.now();
    const startAt = new Date(now - 60 * 60_000).toISOString();
    const endAt = new Date(now + 60 * 60_000).toISOString();
    const { container } = render(
      <I18nProvider>
        <SensorAnalyticsChart
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
});
