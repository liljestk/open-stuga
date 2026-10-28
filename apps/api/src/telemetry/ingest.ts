import { isSqliteFailure } from "../db/sqlite-failure.js";
import { HttpError } from "../http-error.js";
import { MeasurementSample, Reading, type Sensor } from "@climate-twin/contracts";
import { ClimateDatabase } from "../db.js";
import { TelemetryBus } from "../events.js";
import { AlertEngine } from "../alerts/alert-engine.js";
import { DataModeCoordinator } from "../demo/data-mode.js";

/** Live senders may lead the server clock by at most five minutes. */
export const LIVE_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60_000;

export function validateLiveTimestamp(timestamp: string, nowMs: number): void {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new MeasurementValidationError(400, "INVALID_TIMESTAMP", "Measurement timestamp must be an ISO date-time");
  }
  if (timestampMs > nowMs + LIVE_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new MeasurementValidationError(
      422, "TIMESTAMP_TOO_FAR_IN_FUTURE",
      "Measurement timestamp cannot be more than five minutes ahead of the server clock",
    );
  }
}

export class TelemetryValidationError extends HttpError {
  declare readonly code: "UNKNOWN_SENSOR" | "SENSOR_DISABLED";
  declare readonly status: 404 | 409;

  constructor(status: 404 | 409, code: "UNKNOWN_SENSOR" | "SENSOR_DISABLED", message: string) {
    super(status, code, message);
    this.name = "TelemetryValidationError";
  }
}

export class MeasurementValidationError extends HttpError {
  declare readonly status: 400 | 404 | 409 | 422;

  constructor(status: 400 | 404 | 409 | 422, code: string, message: string) {
    super(status, code, message);
    this.name = "MeasurementValidationError";
  }
}

export type TelemetrySource = MeasurementSample["source"] | Reading["source"];

export const DEMO_TELEMETRY_SOURCES = new Set<TelemetrySource>(["mock", "replay"]);

/** The real-data latch refused demo telemetry, either as a domain error or as the guarding trigger. */
export function demoDataWasDisabled(error: unknown): boolean {
  return (error instanceof Error && (error as Error & { code?: unknown }).code === "DEMO_DATA_DISABLED")
    || isSqliteFailure(error, "trigger", "DEMO_DATA_DISABLED");
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
