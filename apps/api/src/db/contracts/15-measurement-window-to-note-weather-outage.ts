import type {
  MeasurementSample,
  OutdoorTemperatureSample,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import type { MeasurementCoverageRecord } from "../../timeseries/types.js";
import { WeatherOutageRecord } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import type { HistoricalTelemetryGap } from "../telemetry-gap-types.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    measurementWindow(sensorIds: string[], metrics: string[], from: string, to: string, limit?: number): MeasurementSample[];
    measurementWindowPage(sensorIds: string[], metrics: string[], from: string, to: string, limit: number, before?: {
            timestamp: string;
            id: number;
        } | null): {
        samples: MeasurementSample[];
        next: {
            timestamp: string;
            id: number;
        } | null;
    };
    measurementCoverage(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[];
    measurementHistoryBucketed(sensorId: string, metric: string, from: string, to: string, bucketSeconds: number, limit?: number, excludeSynthetic?: boolean, toExclusive?: boolean): MeasurementSample[];
    measurementHistoryBucketedMulti(sensorIds: string[], metrics: string[], from: string, to: string, bucketSeconds: number, limitPerSeries?: number): MeasurementSample[];
    sensorMeasurementPage(sensorId: string, before: {
            timestamp: string;
            id: number;
        } | null, limit?: number): {
            samples: MeasurementSample[];
            nextCursor: string | null;
        };
    thermalTemperatureHistory(sensorId: string, from: string, to: string, bucketMinutes?: number, limit?: number): MeasurementSample[];
    thermalClimateHistory(sensorId: string, from: string, to: string, bucketMinutes?: number, limitPerMetric?: number): MeasurementSample[];
    upsertOutdoorTemperatureSample(sample: OutdoorTemperatureSample, options?: { deferDerivedInvalidation?: boolean }): OutdoorTemperatureSample;
    upsertCurrentOutdoorTemperatureSample(sample: OutdoorTemperatureSample, options?: { deferDerivedInvalidation?: boolean }): OutdoorTemperatureSample;
    outdoorTemperatureHistory(houseId: string, locationKey: string, from: string, to: string, limit?: number): OutdoorTemperatureSample[];
    outdoorTemperatureGaps(houseId: string, locationKey: string, provider: WeatherProviderName, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    latestOutdoorTemperatureTimestamp(houseId: string, locationKey: string, provider: WeatherProviderName): string | null;
    noteHistoricalWeatherObservationGap(houseId: string, locationKey: string, provider: WeatherProviderName, startedAt: string, endedAt: string, detectedAt?: string): WeatherOutageRecord;
    noteWeatherOutage(houseId: string, locationKey: string, provider: WeatherProviderName, component: WeatherOutageComponent, error: string, detectedAt?: string): WeatherOutageRecord;
  }

  interface ClimateDatabaseCore {
    measurementWindow(sensorIds: string[], metrics: string[], from: string, to: string, limit?: number): MeasurementSample[];
    measurementWindowPage(sensorIds: string[], metrics: string[], from: string, to: string, limit: number, before?: {
            timestamp: string;
            id: number;
        } | null): {
        samples: MeasurementSample[];
        next: {
            timestamp: string;
            id: number;
        } | null;
    };
    measurementCoverage(sensorIds: string[], metrics: string[]): MeasurementCoverageRecord[];
    measurementHistoryBucketed(sensorId: string, metric: string, from: string, to: string, bucketSeconds: number, limit?: number, excludeSynthetic?: boolean, toExclusive?: boolean): MeasurementSample[];
    measurementHistoryBucketedMulti(sensorIds: string[], metrics: string[], from: string, to: string, bucketSeconds: number, limitPerSeries?: number): MeasurementSample[];
    sensorMeasurementPage(sensorId: string, before: {
            timestamp: string;
            id: number;
        } | null, limit?: number): {
            samples: MeasurementSample[];
            nextCursor: string | null;
        };
    thermalTemperatureHistory(sensorId: string, from: string, to: string, bucketMinutes?: number, limit?: number): MeasurementSample[];
    thermalClimateHistory(sensorId: string, from: string, to: string, bucketMinutes?: number, limitPerMetric?: number): MeasurementSample[];
    upsertOutdoorTemperatureSample(sample: OutdoorTemperatureSample, options?: { deferDerivedInvalidation?: boolean }): OutdoorTemperatureSample;
    upsertCurrentOutdoorTemperatureSample(sample: OutdoorTemperatureSample, options?: { deferDerivedInvalidation?: boolean }): OutdoorTemperatureSample;
    outdoorTemperatureHistory(houseId: string, locationKey: string, from: string, to: string, limit?: number): OutdoorTemperatureSample[];
    outdoorTemperatureGaps(houseId: string, locationKey: string, provider: WeatherProviderName, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    latestOutdoorTemperatureTimestamp(houseId: string, locationKey: string, provider: WeatherProviderName): string | null;
    noteHistoricalWeatherObservationGap(houseId: string, locationKey: string, provider: WeatherProviderName, startedAt: string, endedAt: string, detectedAt?: string): WeatherOutageRecord;
    noteWeatherOutage(houseId: string, locationKey: string, provider: WeatherProviderName, component: WeatherOutageComponent, error: string, detectedAt?: string): WeatherOutageRecord;
  }
}
