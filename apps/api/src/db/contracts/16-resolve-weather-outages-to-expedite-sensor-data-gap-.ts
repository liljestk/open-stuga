import type {
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import { SensorDataGapSource, SensorDataGapState, WeatherOutageRecord } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import type { HistoricalTelemetryGap } from "../telemetry-gap-types.js";
import { SensorDataGapRecord } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    resolveWeatherOutages(houseId: string, locationKey: string, provider: WeatherProviderName, components: readonly WeatherOutageComponent[], endedAt?: string): WeatherOutageRecord[];
    listWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listActiveWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listWeatherBackfillHistory(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listPendingWeatherBackfills(houseId: string, locationKey: string, provider?: WeatherProviderName | null, limit?: number): WeatherOutageRecord[];
    updateWeatherOutageBackfill(id: number, state: WeatherBackfillState, recoveredPoints: number, attemptedAt: string, error: string | null): void;
    latestMeasurementTimestamp(sensorId: string, metric: string, source: SensorDataGapSource): string | null;
    sensorSourceMetrics(sensorId: string, source: SensorDataGapSource): string[];
    measurementSampleGaps(sensorId: string, metric: string, source: SensorDataGapSource, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    unrecordedMeasurementSampleGaps(sensorId: string, metric: string, source: SensorDataGapSource, candidates: HistoricalTelemetryGap[], limit?: number): HistoricalTelemetryGap[];
    noteHistoricalSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, startedAt: string, endedAt: string, detectedAt?: string): SensorDataGapRecord;
    rearmSensorDataGapRecovery(id: number, availableAt?: string, resetAttempts?: boolean): SensorDataGapRecord | null;
    rearmNotSupportedSensorDataGaps(source: SensorDataGapSource, capabilityRevision: string, availableAt?: string): number;
    rearmRetainedTpLinkClimateHistoryGaps(capabilityRevision: string, availableAt?: string): number;
    rearmEligibleNotSupportedTapoGaps(sensorId: string | null, metric: string | null): number;
    openSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource): SensorDataGapRecord | null;
    noteSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, startedAt: string, detectedAt?: string): SensorDataGapRecord;
    resolveSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, endedAt?: string): SensorDataGapRecord | null;
    sensorDataGap(id: number): SensorDataGapRecord | null;
    listSensorDataGaps(sensorId?: string, limit?: number): SensorDataGapRecord[];
    listHouseSensorDataGaps(houseId: string, sensorId?: string, limit?: number): SensorDataGapRecord[];
    recoverableSensorDataGaps(now?: string, limit?: number): SensorDataGapRecord[];
    claimSensorDataGapRecovery(id: number, attemptedAt: string, leaseUntil: string): SensorDataGapRecord | null;
    updateSensorDataGapRecovery(id: number, state: Exclude<SensorDataGapState, "open" | "pending" | "running">, recoveredPoints: number, attemptedAt: string, error: string | null, nextAttemptAt?: string | null): void;
    expediteSensorDataGapRecovery(sensorId: string, source: SensorDataGapSource, from: string, to: string, now?: string): number;
  }

  interface ClimateDatabaseCore {
    resolveWeatherOutages(houseId: string, locationKey: string, provider: WeatherProviderName, components: readonly WeatherOutageComponent[], endedAt?: string): WeatherOutageRecord[];
    listWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listActiveWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listWeatherBackfillHistory(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listPendingWeatherBackfills(houseId: string, locationKey: string, provider?: WeatherProviderName | null, limit?: number): WeatherOutageRecord[];
    updateWeatherOutageBackfill(id: number, state: WeatherBackfillState, recoveredPoints: number, attemptedAt: string, error: string | null): void;
    latestMeasurementTimestamp(sensorId: string, metric: string, source: SensorDataGapSource): string | null;
    sensorSourceMetrics(sensorId: string, source: SensorDataGapSource): string[];
    measurementSampleGaps(sensorId: string, metric: string, source: SensorDataGapSource, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    unrecordedMeasurementSampleGaps(sensorId: string, metric: string, source: SensorDataGapSource, candidates: HistoricalTelemetryGap[], limit?: number): HistoricalTelemetryGap[];
    noteHistoricalSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, startedAt: string, endedAt: string, detectedAt?: string): SensorDataGapRecord;
    rearmSensorDataGapRecovery(id: number, availableAt?: string, resetAttempts?: boolean): SensorDataGapRecord | null;
    rearmNotSupportedSensorDataGaps(source: SensorDataGapSource, capabilityRevision: string, availableAt?: string): number;
    rearmRetainedTpLinkClimateHistoryGaps(capabilityRevision: string, availableAt?: string): number;
    openSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource): SensorDataGapRecord | null;
    noteSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, startedAt: string, detectedAt?: string): SensorDataGapRecord;
    resolveSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource, endedAt?: string): SensorDataGapRecord | null;
    sensorDataGap(id: number): SensorDataGapRecord | null;
    listSensorDataGaps(sensorId?: string, limit?: number): SensorDataGapRecord[];
    listHouseSensorDataGaps(houseId: string, sensorId?: string, limit?: number): SensorDataGapRecord[];
    recoverableSensorDataGaps(now?: string, limit?: number): SensorDataGapRecord[];
    claimSensorDataGapRecovery(id: number, attemptedAt: string, leaseUntil: string): SensorDataGapRecord | null;
    updateSensorDataGapRecovery(id: number, state: Exclude<SensorDataGapState, "open" | "pending" | "running">, recoveredPoints: number, attemptedAt: string, error: string | null, nextAttemptAt?: string | null): void;
    expediteSensorDataGapRecovery(sensorId: string, source: SensorDataGapSource, from: string, to: string, now?: string): number;
  }
}
