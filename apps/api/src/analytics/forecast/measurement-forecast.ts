import { withSignal, type ForecastPoint } from "@climate-twin/contracts";
import { ClimateDatabase } from "../../db.js";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { MeasurementForecastService, type MeasurementForecast } from "./service.js";
import { MeasurementValidationError } from "../../telemetry/ingest.js";

export interface MeasurementForecastOptions {
  sensorId: string;
  metric: string;
  hours?: number;
  telemetryReader?: HybridTelemetryReader;
  signal?: AbortSignal;
}

/** A backtested forecast of one sensor measurement and the evaluation that decided whether to show it. */
export async function forecastMeasurement(
  database: ClimateDatabase,
  { sensorId, metric, hours = 12, telemetryReader, signal }: MeasurementForecastOptions,
): Promise<MeasurementForecast> {
  return new MeasurementForecastService(database, telemetryReader).forecast({
    sensorId, metric, hours, ...withSignal(signal),
  });
}

/** Temperature and humidity forecast pairs for the v1 API, where both are available. */
export async function temperatureHumidityForecast(
  database: ClimateDatabase,
  options: Omit<MeasurementForecastOptions, "metric">,
): Promise<ForecastPoint[]> {
  const [temperature, humidity] = await Promise.all(["temperature", "humidity"].map(async (metric) => {
    try {
      return (await forecastMeasurement(database, { ...options, metric })).points;
    } catch (error) {
      if (error instanceof MeasurementValidationError) return [];
      throw error;
    }
  }));
  const humidityAt = new Map(humidity!.map((point) => [point.timestamp, point]));
  return temperature!.flatMap((point) => {
    const pair = humidityAt.get(point.timestamp);
    return pair ? [{
      sensorId: options.sensorId,
      timestamp: point.timestamp,
      temperature: point.value,
      humidity: pair.value,
      temperatureLow: point.low,
      temperatureHigh: point.high,
      humidityLow: pair.low,
      humidityHigh: pair.high,
    }] : [];
  });
}
