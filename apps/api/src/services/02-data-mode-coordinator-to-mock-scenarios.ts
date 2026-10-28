import { withSignal } from "@climate-twin/contracts";
import type {
  ForecastPoint,
  MeasurementForecastPoint,
  MeasurementSample,
  MockScenario,
  Reading,
  Sensor,
} from "@climate-twin/contracts";
import { ClimateDatabase } from "../db.js";
import { TelemetryBus } from "../events.js";
import type { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { MeasurementForecastService, type MeasurementForecast } from "../analytics/forecast/service.js";
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
      throw new MeasurementValidationError(409, "MIXED_DATA_MODES", "Demo and real telemetry cannot be ingested in the same batch");
    }
    if (hasDemo && this.synchronize()) {
      throw new MeasurementValidationError(409, "DEMO_DATA_DISABLED", "Demo telemetry is permanently disabled after a real integration or real sample is accepted");
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
    if (!sensor) throw new MeasurementValidationError(404, "UNKNOWN_SENSOR", `Unknown sensor: ${sample.sensorId}`);
    if (!sensor.enabled && !allowDisabled) {
      throw new MeasurementValidationError(409, "SENSOR_DISABLED", `Sensor is disabled: ${sample.sensorId}`);
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
    if (!definition) throw new MeasurementValidationError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
    if (!definition.enabled) {
      throw new MeasurementValidationError(409, "METRIC_DISABLED", `Measurement metric is disabled: ${metric}`);
    }
    definitions.set(definition.id, definition);
    return definition;
  }

  private validateSample(sample: MeasurementSample, definition: StoredMeasurementDefinition, nowMs: number): void {
    if (!Number.isFinite(sample.value)) {
      throw new MeasurementValidationError(400, "INVALID_VALUE", "Measurement value must be finite");
    }
    if (definition.validMin !== null && sample.value < definition.validMin) {
      throw new MeasurementValidationError(422, "OUT_OF_RANGE", `${sample.metric} must be at least ${definition.validMin} ${definition.unit}`);
    }
    if (definition.validMax !== null && sample.value > definition.validMax) {
      throw new MeasurementValidationError(422, "OUT_OF_RANGE", `${sample.metric} must be at most ${definition.validMax} ${definition.unit}`);
    }
    if (sample.canonicalUnit !== definition.unit) {
      throw new MeasurementValidationError(422, "UNIT_MISMATCH", `${sample.metric} canonicalUnit must be ${definition.unit}`);
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
    if (!sensor) throw new TelemetryValidationError(404, "UNKNOWN_SENSOR", `Unknown sensor: ${reading.sensorId}`);
    if (!sensor.enabled) throw new TelemetryValidationError(409, "SENSOR_DISABLED", `Sensor is disabled: ${reading.sensorId}`);
    validated.set(sensor.id, sensor);
  }

  private validateMeasurements(reading: Reading): void {
    const values = { ...reading.measurements, temperature: reading.temperature, humidity: reading.humidity };
    for (const [metric, value] of Object.entries(values)) this.validateMeasurement(metric, value);
  }

  private validateMeasurement(metric: string, value: number): void {
    const definition = this.database.getMeasurementDefinition(metric);
    if (!definition) throw new MeasurementValidationError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
    if (!definition.enabled) throw new MeasurementValidationError(409, "METRIC_DISABLED", `Measurement metric is disabled: ${metric}`);
    if (!Number.isFinite(value)) throw new MeasurementValidationError(400, "INVALID_VALUE", `${metric} must be finite`);
    if (definition.validMin !== null && value < definition.validMin
      || definition.validMax !== null && value > definition.validMax) {
      throw new MeasurementValidationError(422, "OUT_OF_RANGE", `${metric} is outside its registered valid range`);
    }
  }

  /** Maintains the v1 tuple projection after independently ingesting canonical samples. */
  ingestLegacyProjection(reading: Reading): boolean {
    const sensor = this.database.getSensor(reading.sensorId);
    if (!sensor) throw new TelemetryValidationError(404, "UNKNOWN_SENSOR", `Unknown sensor: ${reading.sensorId}`);
    if (!sensor.enabled) throw new TelemetryValidationError(409, "SENSOR_DISABLED", `Sensor is disabled: ${reading.sensorId}`);
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

async function measurementForecast(
  database: ClimateDatabase,
  sensorId: string,
  metric: string,
  hours: number,
  telemetryReader?: HybridTelemetryReader,
  signal?: AbortSignal,
): Promise<MeasurementForecast> {
  return new MeasurementForecastService(database, telemetryReader).forecast({
    sensorId, metric, hours, ...withSignal(signal),
  });
}

/** Temperature and humidity forecast pairs for the v1 API, where both are available. */
export async function forecast(
  database: ClimateDatabase,
  sensorId: string,
  hours = 12,
  telemetryReader?: HybridTelemetryReader,
): Promise<ForecastPoint[]> {
  const [temperature, humidity] = await Promise.all(["temperature", "humidity"].map(async (metric) => {
    try {
      return (await measurementForecast(database, sensorId, metric, hours, telemetryReader)).points;
    } catch (error) {
      if (error instanceof MeasurementValidationError) return [];
      throw error;
    }
  }));
  const humidityAt = new Map(humidity!.map((point) => [point.timestamp, point]));
  return temperature!.flatMap((point) => {
    const pair = humidityAt.get(point.timestamp);
    return pair ? [{
      sensorId,
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

/** Backtested forecast and the evaluation that decided whether to show it. */
export async function forecastMeasurementWithEvaluation(
  database: ClimateDatabase,
  { sensorId, metric, hours = 12, telemetryReader, signal }: {
    sensorId: string;
    metric: string;
    hours?: number;
    telemetryReader?: HybridTelemetryReader;
    signal?: AbortSignal;
  },
): Promise<MeasurementForecast> {
  return measurementForecast(database, sensorId, metric, hours, telemetryReader, signal);
}

export async function forecastMeasurement(
  database: ClimateDatabase,
  sensorId: string,
  metric: string,
  hours = 12,
  telemetryReader?: HybridTelemetryReader,
  signal?: AbortSignal,
): Promise<MeasurementForecastPoint[]> {
  return (await measurementForecast(database, sensorId, metric, hours, telemetryReader, signal)).points;
}

export const MOCK_SCENARIOS: MockScenario[] = [
  { id: "normal", label: "Normal day", description: "Small daily temperature and humidity changes." },
  { id: "shower", label: "Shower", description: "A fast humidity plume starts in the upstairs bathroom." },
  { id: "leak", label: "Utility leak", description: "Humidity rises persistently near the utility room." },
  { id: "cold-front", label: "Cold front", description: "A cold wave moves from west-facing sensors through the house." },
  { id: "heating-failure", label: "Heating failure", description: "Temperature steadily falls throughout the building." },
];
