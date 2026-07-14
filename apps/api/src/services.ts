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
import type { AppConfig } from "./config.js";
import { ClimateDatabase } from "./db.js";
import { TelemetryBus } from "./events.js";

export class RuntimeStatus {
  readonly value: IntegrationStatus;
  readonly #bus: TelemetryBus;
  readonly #database: ClimateDatabase;

  constructor(config: AppConfig, bus: TelemetryBus, database: ClimateDatabase) {
    this.#bus = bus;
    this.#database = database;
    this.value = {
      homeAssistant: {
        configured: Boolean(config.haUrl && config.haToken && config.haEntityMapFile),
        connected: false,
        lastEventAt: null,
        mappedEntities: 0,
        error: null,
      },
      webhook: {
        configured: Boolean(config.alertWebhookUrl),
        lastDeliveryAt: null,
        error: null,
      },
      mock: {
        enabled: config.mockEnabled,
        intervalMs: config.mockIntervalMs,
      },
      weather: {
        provider: "fmi",
        configuredHouses: this.configuredWeatherHouses(),
        lastSuccessAt: null,
        error: null,
      },
    };
  }

  changed(): void {
    this.value.weather.configuredHouses = this.configuredWeatherHouses();
    this.#bus.publish({ type: "integration", data: structuredClone(this.value) });
  }

  refreshWeatherConfiguration(): void {
    const configuredHouses = this.configuredWeatherHouses();
    if (configuredHouses === this.value.weather.configuredHouses) return;
    this.value.weather.configuredHouses = configuredHouses;
    this.#bus.publish({ type: "integration", data: structuredClone(this.value) });
  }

  private configuredWeatherHouses(): number {
    return this.#database.listHouses().filter((house) => house.location !== undefined).length;
  }
}

function compare(value: number, operator: AlertRule["operator"], threshold: number): boolean {
  switch (operator) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
  }
}

export class AlertEngine {
  readonly #conditionSince = new Map<string, number>();

  constructor(
    private readonly database: ClimateDatabase,
    private readonly bus: TelemetryBus,
    private readonly config: AppConfig,
    private readonly status: RuntimeStatus,
  ) {}

  evaluateSample(sample: MeasurementSample): AlertEvent[] {
    const timestampMs = Date.parse(sample.timestamp);
    const nowMs = Number.isFinite(timestampMs) ? timestampMs : Date.now();
    const created: AlertEvent[] = [];
    for (const rule of this.database.listAlertRules()) {
      if (!rule.enabled || rule.metric !== sample.metric || (rule.sensorId !== null && rule.sensorId !== sample.sensorId)) continue;
      const key = `${rule.id}:${sample.sensorId}`;
      const active = this.database.activeAlert(rule.id, sample.sensorId);
      if (!compare(sample.value, rule.operator, rule.threshold)) {
        this.#conditionSince.delete(key);
        if (active) {
          const resolved = this.database.resolveAlert(active.id, sample.timestamp);
          if (resolved) this.bus.publish({ type: "alert", data: resolved });
        }
        continue;
      }
      if (active) continue;
      const since = this.#conditionSince.get(key) ?? nowMs;
      this.#conditionSince.set(key, since);
      if (nowMs - since < rule.durationSeconds * 1_000) continue;
      const event = this.database.createAlertEvent({
        ruleId: rule.id,
        sensorId: sample.sensorId,
        metric: rule.metric,
        value: sample.value,
        threshold: rule.threshold,
        severity: rule.severity,
        startedAt: new Date(since).toISOString(),
      });
      created.push(event);
      this.bus.publish({ type: "alert", data: event });
      if (rule.webhookEnabled) void this.deliverWebhook(event, rule);
    }
    return created;
  }

  evaluate(reading: Reading): AlertEvent[] {
    const shared = { sensorId: reading.sensorId, timestamp: reading.timestamp, source: reading.source, quality: reading.quality };
    return [
      ...this.evaluateSample({ ...shared, metric: "temperature", value: reading.temperature, canonicalUnit: "°C" }),
      ...this.evaluateSample({ ...shared, metric: "humidity", value: reading.humidity, canonicalUnit: "%" }),
    ];
  }

  private async deliverWebhook(event: AlertEvent, rule: AlertRule): Promise<void> {
    if (!this.config.alertWebhookUrl) return;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.config.alertWebhookBearerToken) headers.authorization = `Bearer ${this.config.alertWebhookBearerToken}`;
      const response = await fetch(this.config.alertWebhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ apiVersion: "v1", type: "climate-twin.alert", event, rule }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
      this.status.value.webhook.lastDeliveryAt = new Date().toISOString();
      this.status.value.webhook.error = null;
    } catch (error) {
      this.status.value.webhook.error = error instanceof Error ? error.message : "Webhook delivery failed";
    }
    this.status.changed();
  }
}

export class TelemetryValidationError extends Error {
  constructor(
    readonly code: "UNKNOWN_SENSOR" | "SENSOR_DISABLED",
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export class MeasurementValidationError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

function samplesFromReading(database: ClimateDatabase, reading: Reading): MeasurementSample[] {
  const values: Record<string, number> = {
    ...(reading.measurements ?? {}),
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

export class MeasurementService {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly bus: TelemetryBus,
    private readonly alertEngine: AlertEngine,
  ) {}

  ingest(sample: MeasurementSample): MeasurementSample | null {
    return this.ingestBatch([sample])[0] ?? null;
  }

  ingestBatch(samples: MeasurementSample[]): MeasurementSample[] {
    const sensors = new Map<string, Sensor>();
    const definitions = new Map<string, NonNullable<ReturnType<ClimateDatabase["getMeasurementDefinition"]>>>();
    for (const sample of samples) {
      let sensor = sensors.get(sample.sensorId);
      if (!sensor) {
        sensor = this.database.getSensor(sample.sensorId) ?? undefined;
        if (!sensor) throw new MeasurementValidationError("UNKNOWN_SENSOR", 404, `Unknown sensor: ${sample.sensorId}`);
        if (!sensor.enabled) throw new MeasurementValidationError("SENSOR_DISABLED", 409, `Sensor is disabled: ${sample.sensorId}`);
        sensors.set(sensor.id, sensor);
      }
      let definition = definitions.get(sample.metric);
      if (!definition) {
        definition = this.database.getMeasurementDefinition(sample.metric) ?? undefined;
        if (!definition) throw new MeasurementValidationError("UNKNOWN_METRIC", 404, `Unknown measurement metric: ${sample.metric}`);
        if (!definition.enabled) throw new MeasurementValidationError("METRIC_DISABLED", 409, `Measurement metric is disabled: ${sample.metric}`);
        definitions.set(definition.id, definition);
      }
      if (!Number.isFinite(sample.value)) throw new MeasurementValidationError("INVALID_VALUE", 400, "Measurement value must be finite");
      if (definition.validMin !== null && sample.value < definition.validMin) {
        throw new MeasurementValidationError("OUT_OF_RANGE", 422, `${sample.metric} must be at least ${definition.validMin} ${definition.unit}`);
      }
      if (definition.validMax !== null && sample.value > definition.validMax) {
        throw new MeasurementValidationError("OUT_OF_RANGE", 422, `${sample.metric} must be at most ${definition.validMax} ${definition.unit}`);
      }
      if (sample.canonicalUnit !== definition.unit) {
        throw new MeasurementValidationError("UNIT_MISMATCH", 422, `${sample.metric} canonicalUnit must be ${definition.unit}`);
      }
      if (!Number.isFinite(Date.parse(sample.timestamp))) {
        throw new MeasurementValidationError("INVALID_TIMESTAMP", 400, "Measurement timestamp must be an ISO date-time");
      }
    }
    const inserted = this.database.insertMeasurementSamples(samples);
    for (const sample of inserted) {
      this.bus.publishMeasurement(sample);
      this.alertEngine.evaluateSample(sample);
    }
    return inserted;
  }
}

export class TelemetryService {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly bus: TelemetryBus,
    private readonly alertEngine: AlertEngine,
  ) {}

  ingest(reading: Reading): Reading {
    this.ingestBatch([reading]);
    return reading;
  }

  ingestBatch(readings: Reading[]): Reading[] {
    const validated = new Map<string, Sensor>();
    for (const reading of readings) {
      let sensor = validated.get(reading.sensorId);
      if (!sensor) {
        sensor = this.database.getSensor(reading.sensorId) ?? undefined;
        if (!sensor) throw new TelemetryValidationError("UNKNOWN_SENSOR", 404, `Unknown sensor: ${reading.sensorId}`);
        if (!sensor.enabled) throw new TelemetryValidationError("SENSOR_DISABLED", 409, `Sensor is disabled: ${reading.sensorId}`);
        validated.set(sensor.id, sensor);
      }
      for (const [metric, value] of Object.entries({
        ...(reading.measurements ?? {}), temperature: reading.temperature, humidity: reading.humidity,
      })) {
        const definition = this.database.getMeasurementDefinition(metric);
        if (!definition) throw new MeasurementValidationError("UNKNOWN_METRIC", 404, `Unknown measurement metric: ${metric}`);
        if (!definition.enabled) throw new MeasurementValidationError("METRIC_DISABLED", 409, `Measurement metric is disabled: ${metric}`);
        if (!Number.isFinite(value)) throw new MeasurementValidationError("INVALID_VALUE", 400, `${metric} must be finite`);
        if (definition.validMin !== null && value < definition.validMin || definition.validMax !== null && value > definition.validMax) {
          throw new MeasurementValidationError("OUT_OF_RANGE", 422, `${metric} is outside its registered valid range`);
        }
      }
    }
    const inserted = this.database.insertReadings(readings);
    for (const reading of inserted) {
      this.bus.publish({ type: "reading", data: reading });
      for (const sample of samplesFromReading(this.database, reading)) {
        this.bus.publishMeasurement(sample);
        this.alertEngine.evaluateSample(sample);
      }
    }
    return inserted;
  }

  /** Maintains the v1 tuple projection after independently ingesting canonical samples. */
  ingestLegacyProjection(reading: Reading): boolean {
    const sensor = this.database.getSensor(reading.sensorId);
    if (!sensor) throw new TelemetryValidationError("UNKNOWN_SENSOR", 404, `Unknown sensor: ${reading.sensorId}`);
    if (!sensor.enabled) throw new TelemetryValidationError("SENSOR_DISABLED", 409, `Sensor is disabled: ${reading.sensorId}`);
    const inserted = this.database.insertLegacyReading(reading);
    if (inserted) this.bus.publish({ type: "reading", data: reading });
    return inserted;
  }

  latest(sensorId: string): Reading | null {
    return this.database.getLatestReading(sensorId);
  }
}

export function forecast(database: ClimateDatabase, sensorId: string, hours = 12): ForecastPoint[] {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60_000);
  const readings = database.history([sensorId], start.toISOString(), end.toISOString(), 5_000);
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

export function forecastMeasurement(
  database: ClimateDatabase,
  sensorId: string,
  metric: string,
  hours = 12,
): MeasurementForecastPoint[] {
  const definition = database.getMeasurementDefinition(metric);
  if (!definition) throw new MeasurementValidationError("UNKNOWN_METRIC", 404, `Unknown measurement metric: ${metric}`);
  if (!definition.forecastSupported) {
    throw new MeasurementValidationError("FORECAST_UNSUPPORTED", 422, `Forecasting is not enabled for metric: ${metric}`);
  }
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60_000);
  const samples = database.measurementHistory(sensorId, metric, start.toISOString(), end.toISOString(), 5_000);
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

export class MockEngine {
  #timer: NodeJS.Timeout | null = null;
  #tick = 0;
  #scenario: MockScenario["id"] = "normal";

  constructor(
    private readonly database: ClimateDatabase,
    private readonly telemetry: TelemetryService,
    private readonly config: AppConfig,
  ) {}

  get scenario(): MockScenario["id"] { return this.#scenario; }

  setScenario(scenario: MockScenario["id"]): void {
    this.#scenario = scenario;
    this.#tick = 0;
  }

  start(): void {
    if (this.#timer || !this.config.mockEnabled) return;
    this.#timer = setInterval(() => this.generate(), this.config.mockIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  generate(): Reading[] {
    this.#tick += 1;
    const now = new Date().toISOString();
    const generated: Reading[] = [];
    const sensors = this.database.listSensors().filter((sensor) => sensor.enabled);
    for (let index = 0; index < sensors.length; index += 1) {
      const sensor = sensors[index] as Sensor;
      const last = this.database.getLatestReading(sensor.id);
      const lastCo2 = this.database.getLatestMeasurementSample(sensor.id, "co2")?.value ?? 650 + (index % 4) * 35;
      let temperature = last?.temperature ?? 20.5;
      let humidity = last?.humidity ?? 44;
      let co2 = lastCo2 + Math.sin(this.#tick / 11 + index * 0.8) * 3;
      const wave = Math.sin(this.#tick / 15 + index * 0.7);
      temperature += wave * 0.025;
      humidity += Math.cos(this.#tick / 13 + index) * 0.08;
      if (this.#scenario === "shower") {
        const distance = Math.hypot(sensor.x - 10.5, sensor.y - 7.5) + (sensor.floorId === "floor-upper" ? 0 : 8);
        humidity += Math.max(0, 2.2 - distance * 0.16);
        temperature += Math.max(0, 0.08 - distance * 0.006);
        co2 += Math.max(0, 18 - distance * 1.2);
      } else if (this.#scenario === "leak") {
        const distance = Math.hypot(sensor.x - 11, sensor.y - 7.5) + (sensor.floorId === "floor-ground" ? 0 : 7);
        humidity += Math.max(0, 1.35 - distance * 0.11);
      } else if (this.#scenario === "cold-front") {
        const front = (this.#tick / 4) % 18;
        temperature -= Math.max(0, 0.32 - Math.abs(sensor.x - front) * 0.055);
      } else if (this.#scenario === "heating-failure") {
        temperature -= 0.075 + (sensor.floorId === "floor-ground" ? 0.015 : 0);
      }
      // A gentle occupied-room cycle keeps mock CO2 realistic without coupling it to climate samples.
      co2 += Math.max(0, Math.sin(this.#tick / 40 + index * 0.4)) * 2.5;
      const reading: Reading = {
        sensorId: sensor.id,
        timestamp: now,
        temperature: Number(Math.max(-30, Math.min(60, temperature)).toFixed(2)),
        humidity: Number(Math.max(0, Math.min(100, humidity)).toFixed(2)),
        battery: last?.battery ?? 95,
        source: "mock",
        quality: "good",
        measurements: { co2: Number(Math.max(350, Math.min(5_000, co2)).toFixed(0)) },
      };
      generated.push(this.telemetry.ingest(reading));
    }
    return generated;
  }
}

export interface ReplayState {
  active: boolean;
  count: number;
  emitted: number;
  speed: number;
  from: string | null;
  to: string | null;
}

export class ReplayEngine {
  #timer: NodeJS.Timeout | null = null;
  #readings: Reading[] = [];
  #index = 0;
  #speed = 60;
  #from: string | null = null;
  #to: string | null = null;

  constructor(private readonly database: ClimateDatabase, private readonly bus: TelemetryBus) {}

  get state(): ReplayState {
    return { active: this.#timer !== null, count: this.#readings.length, emitted: this.#index, speed: this.#speed, from: this.#from, to: this.#to };
  }

  start(sensorIds: string[], from: string, to: string, speed = 60): ReplayState {
    this.stop();
    this.#readings = this.database.history(sensorIds, from, to, 50_000);
    this.#index = 0;
    this.#speed = Math.max(0.1, Math.min(speed, 10_000));
    this.#from = from;
    this.#to = to;
    if (this.#readings.length > 0) this.schedule(0);
    return this.state;
  }

  stop(): ReplayState {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    return this.state;
  }

  private schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      const current = this.#readings[this.#index];
      if (!current) {
        this.#timer = null;
        return;
      }
      this.bus.publish({ type: "reading", data: { ...current, source: "replay" } });
      this.#index += 1;
      const next = this.#readings[this.#index];
      if (!next) {
        this.#timer = null;
        return;
      }
      const sourceDelay = Math.max(0, Date.parse(next.timestamp) - Date.parse(current.timestamp));
      this.schedule(Math.max(5, Math.min(5_000, sourceDelay / this.#speed)));
    }, delay);
    this.#timer.unref();
  }
}
