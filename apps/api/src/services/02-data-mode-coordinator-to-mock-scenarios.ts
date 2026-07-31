import type {
  AlertEvent,
  AlertRule,
  ForecastPoint,
  IntegrationStatus,
  MeasurementForecastPoint,
  MeasurementSample,
  MockScenario,
  Reading,
  Sensor,
} from "@climate-twin/contracts";
import { configuredAlertWebhookDestinations, type AppConfig } from "../config.js";
import { ClimateDatabase } from "../db.js";
import { TelemetryBus } from "../events.js";
import { alertNotificationBindings } from "../notification-snapshot.js";
import { DEFAULT_ALERT_DELIVERY_POLICY } from "../notification-policy.js";
import type { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { AlertEngine, DEMO_TELEMETRY_SOURCES, MeasurementValidationError, TelemetrySource, TelemetryValidationError, validateLiveTimestamp } from "./01-weather-connection-status-to-demo-data-was-disabled.js";

/** Coordinates the irreversible boundary between the bundled demo and real telemetry. */
export class DataModeCoordinator {
  readonly #activatedListeners = new Set<() => void>();
  #observedRealMode: boolean;

  constructor(private readonly database: ClimateDatabase) {
    this.#observedRealMode = database.isRealDataMode();
  }

  get isRealMode(): boolean {
    return this.database.isRealDataMode();
  }

  activate(): void {
    this.database.activateRealDataMode();
    this.synchronize();
  }

  synchronize(): boolean {
    if (!this.isRealMode || this.#observedRealMode) return this.isRealMode;
    this.#observedRealMode = true;
    for (const listener of this.#activatedListeners) listener();
    return true;
  }

  prepareSources(sources: TelemetrySource[]): void {
    const hasDemo = sources.some((source) => DEMO_TELEMETRY_SOURCES.has(source));
    const hasReal = sources.some((source) => !DEMO_TELEMETRY_SOURCES.has(source));
    if (hasDemo && hasReal) {
      throw new MeasurementValidationError("MIXED_DATA_MODES", 409, "Demo and real telemetry cannot be ingested in the same batch");
    }
    if (hasDemo && this.synchronize()) {
      throw new MeasurementValidationError("DEMO_DATA_DISABLED", 409, "Demo telemetry is permanently disabled after a real integration or real sample is accepted");
    }
    // The repository latches real-data mode inside the same SQLite transaction
    // as the first persisted real sample. Activating here would commit the
    // destructive purge before persistence and could not be rolled back if the
    // subsequent insert failed.
  }

  onActivated(listener: () => void): () => void {
    this.#activatedListeners.add(listener);
    return () => this.#activatedListeners.delete(listener);
  }
}

export function samplesFromReading(database: ClimateDatabase, reading: Reading): MeasurementSample[] {
  const values: Record<string, number> = {
    ...reading.measurements,
    temperature: reading.temperature,
    humidity: reading.humidity,
  };
  return Object.entries(values).flatMap(([metric, value]) => {
    const definition = database.getMeasurementDefinition(metric);
    return definition ? [{
      sensorId: reading.sensorId,
      metric,
      value,
      canonicalUnit: definition.unit,
      timestamp: reading.timestamp,
      source: reading.source,
      quality: reading.quality,
    }] : [];
  });
}

export type StoredMeasurementDefinition = NonNullable<ReturnType<ClimateDatabase["getMeasurementDefinition"]>>;

export interface MeasurementIngestOptions {
  allowDisabledSensors?: boolean;
  publish?: boolean;
  evaluateAlerts?: boolean;
  deduplicateAcrossSources?: boolean;
}

export class MeasurementService {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly bus: TelemetryBus,
    private readonly alertEngine: AlertEngine,
    private readonly dataMode: DataModeCoordinator,
  ) {}

  ingest(sample: MeasurementSample): MeasurementSample | null {
    return this.ingestBatch([sample])[0] ?? null;
  }

  ingestBatch(
    samples: MeasurementSample[],
    options: MeasurementIngestOptions = {},
  ): MeasurementSample[] {
    const nowMs = Date.now();
    const sensors = new Map<string, Sensor>();
    const definitions = new Map<string, StoredMeasurementDefinition>();
    for (const sample of samples) {
      this.validateSensor(sample, sensors, Boolean(options.allowDisabledSensors));
      const definition = this.measurementDefinition(sample.metric, definitions);
      this.validateSample(sample, definition, nowMs);
    }
    this.dataMode.prepareSources(samples.map((sample) => sample.source));
    const evaluateAlerts = options.evaluateAlerts !== false;
    const inserted = this.database.insertMeasurementSamples(samples, {
      ...(options.deduplicateAcrossSources !== undefined
        ? { deduplicateAcrossSources: options.deduplicateAcrossSources }
        : {}),
      enqueueAlertEvaluation: evaluateAlerts,
    });
    this.dataMode.synchronize();
    if (options.publish !== false) {
      for (const sample of inserted) this.bus.publishMeasurement(sample);
    }
    if (evaluateAlerts) this.alertEngine.evaluatePendingSamples();
    return inserted;
  }

  private validateSensor(
    sample: MeasurementSample,
    sensors: Map<string, Sensor>,
    allowDisabled: boolean,
  ): void {
    if (sensors.has(sample.sensorId)) return;
    const sensor = this.database.getSensor(sample.sensorId);
    if (!sensor) throw new MeasurementValidationError("UNKNOWN_SENSOR", 404, `Unknown sensor: ${sample.sensorId}`);
    if (!sensor.enabled && !allowDisabled) {
      throw new MeasurementValidationError("SENSOR_DISABLED", 409, `Sensor is disabled: ${sample.sensorId}`);
    }
    sensors.set(sensor.id, sensor);
  }

  private measurementDefinition(
    metric: string,
    definitions: Map<string, StoredMeasurementDefinition>,
  ): StoredMeasurementDefinition {
    const cached = definitions.get(metric);
    if (cached) return cached;
    const definition = this.database.getMeasurementDefinition(metric);
    if (!definition) throw new MeasurementValidationError("UNKNOWN_METRIC", 404, `Unknown measurement metric: ${metric}`);
    if (!definition.enabled) {
      throw new MeasurementValidationError("METRIC_DISABLED", 409, `Measurement metric is disabled: ${metric}`);
    }
    definitions.set(definition.id, definition);
    return definition;
  }

  private validateSample(sample: MeasurementSample, definition: StoredMeasurementDefinition, nowMs: number): void {
    if (!Number.isFinite(sample.value)) {
      throw new MeasurementValidationError("INVALID_VALUE", 400, "Measurement value must be finite");
    }
    if (definition.validMin !== null && sample.value < definition.validMin) {
      throw new MeasurementValidationError("OUT_OF_RANGE", 422, `${sample.metric} must be at least ${definition.validMin} ${definition.unit}`);
    }
    if (definition.validMax !== null && sample.value > definition.validMax) {
      throw new MeasurementValidationError("OUT_OF_RANGE", 422, `${sample.metric} must be at most ${definition.validMax} ${definition.unit}`);
    }
    if (sample.canonicalUnit !== definition.unit) {
      throw new MeasurementValidationError("UNIT_MISMATCH", 422, `${sample.metric} canonicalUnit must be ${definition.unit}`);
    }
    validateLiveTimestamp(sample.timestamp, nowMs);
  }
}

export class TelemetryService {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly bus: TelemetryBus,
    private readonly alertEngine: AlertEngine,
    private readonly dataMode: DataModeCoordinator,
  ) {}

  ingest(reading: Reading): Reading {
    this.ingestBatch([reading]);
    return reading;
  }

  ingestBatch(
    readings: Reading[],
    options: {
      beforePersist?: () => boolean;
      afterPersist?: (inserted: Reading[]) => void;
    } = {},
  ): Reading[] {
    const nowMs = Date.now();
    const validated = new Map<string, Sensor>();
    for (const reading of readings) {
      this.validateSensor(reading, validated);
      validateLiveTimestamp(reading.timestamp, nowMs);
      this.validateMeasurements(reading);
    }
    this.dataMode.prepareSources(readings.map((reading) => reading.source));
    const inserted = this.database.transaction(() => {
      if (options.beforePersist && !options.beforePersist()) return [];
      const persisted = this.database.insertReadings(readings, { enqueueAlertEvaluation: true });
      options.afterPersist?.(persisted);
      return persisted;
    });
    this.dataMode.synchronize();
    const samples: MeasurementSample[] = [];
    for (const reading of inserted) {
      this.bus.publish({ type: "reading", data: reading });
      for (const sample of samplesFromReading(this.database, reading)) {
        samples.push(sample);
        this.bus.publishMeasurement(sample);
      }
    }
    this.alertEngine.evaluatePendingSamples();
    return inserted;
  }

  private validateSensor(reading: Reading, validated: Map<string, Sensor>): void {
    if (validated.has(reading.sensorId)) return;
    const sensor = this.database.getSensor(reading.sensorId);
    if (!sensor) throw new TelemetryValidationError("UNKNOWN_SENSOR", 404, `Unknown sensor: ${reading.sensorId}`);
    if (!sensor.enabled) throw new TelemetryValidationError("SENSOR_DISABLED", 409, `Sensor is disabled: ${reading.sensorId}`);
    validated.set(sensor.id, sensor);
  }

  private validateMeasurements(reading: Reading): void {
    const values = { ...reading.measurements, temperature: reading.temperature, humidity: reading.humidity };
    for (const [metric, value] of Object.entries(values)) this.validateMeasurement(metric, value);
  }

  private validateMeasurement(metric: string, value: number): void {
    const definition = this.database.getMeasurementDefinition(metric);
    if (!definition) throw new MeasurementValidationError("UNKNOWN_METRIC", 404, `Unknown measurement metric: ${metric}`);
    if (!definition.enabled) throw new MeasurementValidationError("METRIC_DISABLED", 409, `Measurement metric is disabled: ${metric}`);
    if (!Number.isFinite(value)) throw new MeasurementValidationError("INVALID_VALUE", 400, `${metric} must be finite`);
    if (definition.validMin !== null && value < definition.validMin
      || definition.validMax !== null && value > definition.validMax) {
      throw new MeasurementValidationError("OUT_OF_RANGE", 422, `${metric} is outside its registered valid range`);
    }
  }

  /** Maintains the v1 tuple projection after independently ingesting canonical samples. */
  ingestLegacyProjection(reading: Reading): boolean {
    const sensor = this.database.getSensor(reading.sensorId);
    if (!sensor) throw new TelemetryValidationError("UNKNOWN_SENSOR", 404, `Unknown sensor: ${reading.sensorId}`);
    if (!sensor.enabled) throw new TelemetryValidationError("SENSOR_DISABLED", 409, `Sensor is disabled: ${reading.sensorId}`);
    validateLiveTimestamp(reading.timestamp, Date.now());
    this.dataMode.prepareSources([reading.source]);
    const inserted = this.database.upsertLegacyReading(reading);
    this.dataMode.synchronize();
    if (inserted) this.bus.publish({ type: "reading", data: reading });
    return inserted;
  }

  latest(sensorId: string): Reading | null {
    return this.database.getLatestReading(sensorId);
  }
}

export async function forecast(
  database: ClimateDatabase,
  sensorId: string,
  hours = 12,
  telemetryReader?: HybridTelemetryReader,
): Promise<ForecastPoint[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60_000);
  const readings = telemetryReader
    ? (await telemetryReader.legacyReadingHistory({
      sensorIds: [sensorId],
      from: start.toISOString(),
      to: end.toISOString(),
      limit: 5_000,
    })).records
    : database.history([sensorId], start.toISOString(), end.toISOString(), 5_000);
  const latest = readings.at(-1) ?? database.getLatestReading(sensorId);
  if (!latest) return [];

  const points = readings.length > 1 ? readings : [latest];
  const baseTime = Date.parse(points[0]?.timestamp ?? latest.timestamp);
  const xs = points.map((point) => (Date.parse(point.timestamp) - baseTime) / 3_600_000);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const linear = (values: number[]): { intercept: number; slope: number; error: number } => {
    const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < values.length; index += 1) {
      const dx = (xs[index] ?? 0) - meanX;
      numerator += dx * ((values[index] ?? meanY) - meanY);
      denominator += dx * dx;
    }
    const rawSlope = denominator > 0 ? numerator / denominator : 0;
    // Long extrapolations from home sensor noise are intentionally damped.
    const slope = Math.max(-1.5, Math.min(1.5, rawSlope)) * 0.35;
    const intercept = meanY - slope * meanX;
    const mse = values.reduce((sum, value, index) => {
      const residual = value - (intercept + slope * (xs[index] ?? meanX));
      return sum + residual * residual;
    }, 0) / Math.max(1, values.length - 2);
    return { intercept, slope, error: Math.sqrt(mse) };
  };
  const temperatureModel = linear(points.map((point) => point.temperature));
  const humidityModel = linear(points.map((point) => point.humidity));
  const lastX = (Date.parse(latest.timestamp) - baseTime) / 3_600_000;
  const result: ForecastPoint[] = [];
  for (let offset = 1; offset <= Math.min(Math.max(hours, 1), 168); offset += 1) {
    const x = lastX + offset;
    const temperature = temperatureModel.intercept + temperatureModel.slope * x;
    const humidity = Math.max(0, Math.min(100, humidityModel.intercept + humidityModel.slope * x));
    const temperatureBand = Math.max(0.35, temperatureModel.error * 1.96) * Math.sqrt(1 + offset / 24);
    const humidityBand = Math.max(1.5, humidityModel.error * 1.96) * Math.sqrt(1 + offset / 24);
    result.push({
      sensorId,
      timestamp: new Date(Date.parse(latest.timestamp) + offset * 3_600_000).toISOString(),
      temperature: Number(temperature.toFixed(2)),
      humidity: Number(humidity.toFixed(2)),
      temperatureLow: Number((temperature - temperatureBand).toFixed(2)),
      temperatureHigh: Number((temperature + temperatureBand).toFixed(2)),
      humidityLow: Number(Math.max(0, humidity - humidityBand).toFixed(2)),
      humidityHigh: Number(Math.min(100, humidity + humidityBand).toFixed(2)),
    });
  }
  return result;
}

export async function forecastMeasurement(
  database: ClimateDatabase,
  sensorId: string,
  metric: string,
  hours = 12,
  telemetryReader?: HybridTelemetryReader,
): Promise<MeasurementForecastPoint[]> {
  const definition = database.getMeasurementDefinition(metric);
  if (!definition) throw new MeasurementValidationError("UNKNOWN_METRIC", 404, `Unknown measurement metric: ${metric}`);
  if (!definition.forecastSupported) {
    throw new MeasurementValidationError("FORECAST_UNSUPPORTED", 422, `Forecasting is not enabled for metric: ${metric}`);
  }
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60_000);
  const samples = telemetryReader
    ? (await telemetryReader.measurementHistory({
      sensorId,
      metric,
      from: start.toISOString(),
      to: end.toISOString(),
      limit: 5_000,
    })).records
    : database.measurementHistory(sensorId, metric, start.toISOString(), end.toISOString(), 5_000);
  const latest = samples.at(-1) ?? database.getLatestMeasurementSample(sensorId, metric);
  if (!latest) return [];
  const points = samples.length > 1 ? samples : [latest];
  const baseTime = Date.parse(points[0]!.timestamp);
  const xs = points.map((point) => (Date.parse(point.timestamp) - baseTime) / 3_600_000);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < points.length; index += 1) {
    const dx = (xs[index] ?? meanX) - meanX;
    numerator += dx * ((points[index]?.value ?? meanY) - meanY);
    denominator += dx * dx;
  }
  const slope = Math.max(-definition.interpolationDelta, Math.min(definition.interpolationDelta, denominator > 0 ? numerator / denominator : 0)) * 0.35;
  const intercept = meanY - slope * meanX;
  const mse = points.reduce((sum, point, index) => {
    const residual = point.value - (intercept + slope * (xs[index] ?? meanX));
    return sum + residual * residual;
  }, 0) / Math.max(1, points.length - 2);
  const error = Math.sqrt(mse);
  const lastX = (Date.parse(latest.timestamp) - baseTime) / 3_600_000;
  const clamp = (value: number): number => Math.max(definition.validMin ?? -Infinity, Math.min(definition.validMax ?? Infinity, value));
  const round = (value: number): number => Number(value.toFixed(definition.precision));
  const result: MeasurementForecastPoint[] = [];
  for (let offset = 1; offset <= Math.min(Math.max(hours, 1), 168); offset += 1) {
    const value = clamp(intercept + slope * (lastX + offset));
    const band = Math.max(definition.interpolationDelta * 0.15, error * 1.96) * Math.sqrt(1 + offset / 24);
    result.push({
      sensorId,
      metric,
      timestamp: new Date(Date.parse(latest.timestamp) + offset * 3_600_000).toISOString(),
      value: round(value),
      low: round(clamp(value - band)),
      high: round(clamp(value + band)),
    });
  }
  return result;
}

export const MOCK_SCENARIOS: MockScenario[] = [
  { id: "normal", label: "Normal day", description: "Small daily temperature and humidity changes." },
  { id: "shower", label: "Shower", description: "A fast humidity plume starts in the upstairs bathroom." },
  { id: "leak", label: "Utility leak", description: "Humidity rises persistently near the utility room." },
  { id: "cold-front", label: "Cold front", description: "A cold wave moves from west-facing sensors through the house." },
  { id: "heating-failure", label: "Heating failure", description: "Temperature steadily falls throughout the building." },
];
