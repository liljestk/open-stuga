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
import { alertNotificationBindings } from "./notification-snapshot.js";
import { DEFAULT_ALERT_DELIVERY_POLICY } from "./notification-policy.js";

type WeatherConnectionStatus = NonNullable<IntegrationStatus["weather"]["connections"]>[number];

export class RuntimeStatus {
  readonly value: IntegrationStatus;
  readonly #bus: TelemetryBus;
  readonly #database: ClimateDatabase;

  constructor(config: AppConfig, bus: TelemetryBus, database: ClimateDatabase) {
    this.#bus = bus;
    this.#database = database;
    this.value = {
      homeAssistant: {
        configured: Boolean((config.homeAssistantConnections?.length ?? 0) > 0
          || (!config.homeAssistantLegacyDisabled && config.haUrl && config.haToken)),
        connected: false,
        lastEventAt: null,
        mappedEntities: 0,
        error: null,
        connections: (config.homeAssistantConnections ?? []).map((connection) => ({
          houseId: connection.houseId,
          configured: true,
          connected: false,
          lastEventAt: null,
          mappedEntities: 0,
          error: null,
        })),
      },
      tpLink: {
        configured: Boolean((config.tpLinkConnections?.length ?? 0) > 0
          || (!config.tpLinkLegacyDisabled && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword)),
        connected: false,
        lastPollAt: null,
        mappedDevices: 0,
        discoveredDevices: 0,
        hubModel: null,
        error: null,
        connections: (config.tpLinkConnections ?? []).map((connection) => ({
          id: connection.id, houseId: connection.houseId, configured: true, connected: false,
          lastPollAt: null, mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null,
        })),
      },
      webhook: {
        configured: Boolean(config.alertWebhookUrl),
        lastDeliveryAt: null,
        error: null,
      },
      telegram: {
        available: true,
        configured: Boolean(config.telegramBotToken && config.telegramChatId),
        connected: false,
        botUsername: null,
        chatLabel: null,
        lastDeliveryAt: null,
        error: null,
      },
      appleNotes: {
        available: true,
        configured: (config.appleNotesGrants ?? []).length > 0,
        grantCount: (config.appleNotesGrants ?? []).length,
        lastSyncAt: null,
        error: null,
      },
      mock: {
        enabled: config.mockEnabled && !database.isRealDataMode(),
        intervalMs: config.mockIntervalMs,
        mode: database.isRealDataMode() ? "real" : "demo",
        activatedAt: database.realDataModeActivatedAt(),
      },
      weather: {
        policy: "automatic",
        availableProviders: ["fmi", "open-meteo"],
        provider: "fmi",
        configuredHouses: this.configuredWeatherHouses(),
        lastSuccessAt: null,
        error: null,
        connections: this.weatherConnections(),
      },
    };
  }

  changed(): void {
    this.synchronizeWeatherConfiguration();
    this.#bus.publish({ type: "integration", data: structuredClone(this.value) });
  }

  refreshWeatherConfiguration(): void {
    if (!this.synchronizeWeatherConfiguration()) return;
    this.#bus.publish({ type: "integration", data: structuredClone(this.value) });
  }

  refreshDataMode(): void {
    const mode = this.#database.isRealDataMode() ? "real" : "demo";
    const enabled = this.value.mock.enabled && mode === "demo";
    const activatedAt = this.#database.realDataModeActivatedAt();
    if (this.value.mock.mode === mode && this.value.mock.enabled === enabled && this.value.mock.activatedAt === activatedAt) return;
    this.value.mock.mode = mode;
    this.value.mock.enabled = enabled;
    this.value.mock.activatedAt = activatedAt;
    this.changed();
  }

  private configuredWeatherHouses(): number {
    return this.#database.listHouses().filter((house) => house.location !== undefined).length;
  }

  private weatherConnections(
    existing: WeatherConnectionStatus[] = [],
    fallbackProvider: IntegrationStatus["weather"]["provider"] = "fmi",
  ): WeatherConnectionStatus[] {
    const previous = new Map(existing.map((connection) => [connection.houseId, connection]));
    return this.#database.listHouses().map((house) => {
      const prior = previous.get(house.id);
      const configured = house.location !== undefined;
      return {
        houseId: house.id,
        configured,
        provider: prior?.provider ?? fallbackProvider,
        lastSuccessAt: configured ? prior?.lastSuccessAt ?? null : null,
        error: configured ? prior?.error ?? null : null,
      };
    });
  }

  private synchronizeWeatherConfiguration(): boolean {
    const previousConnections = this.value.weather.connections ?? [];
    const connections = this.weatherConnections(previousConnections, this.value.weather.provider);
    const configuredHouses = connections.filter((connection) => connection.configured).length;
    const changed = configuredHouses !== this.value.weather.configuredHouses
      || JSON.stringify(connections) !== JSON.stringify(previousConnections);
    this.value.weather.configuredHouses = configuredHouses;
    this.value.weather.connections = connections;
    return changed;
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

function ruleApplies(rule: AlertRule, sample: MeasurementSample): boolean {
  return rule.enabled
    && rule.metric === sample.metric
    && (rule.sensorId === null || rule.sensorId === sample.sensorId);
}

/** Live senders may lead the server clock by at most five minutes. */
export const LIVE_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60_000;

function validateLiveTimestamp(timestamp: string, nowMs: number): void {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new MeasurementValidationError("INVALID_TIMESTAMP", 400, "Measurement timestamp must be an ISO date-time");
  }
  if (timestampMs > nowMs + LIVE_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new MeasurementValidationError(
      "TIMESTAMP_TOO_FAR_IN_FUTURE",
      422,
      "Measurement timestamp cannot be more than five minutes ahead of the server clock",
    );
  }
}

export class AlertEngine {
  #timer: NodeJS.Timeout | null = null;
  #tickActive = false;
  constructor(
    private readonly database: ClimateDatabase,
    private readonly bus: TelemetryBus,
    private readonly config?: AppConfig,
    _status?: RuntimeStatus,
    _telegram?: unknown,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), 5_000);
    this.#timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  tick(now = new Date()): void {
    if (this.#tickActive) return;
    this.#tickActive = true;
    try {
      this.evaluateWallClock(now);
      this.enqueueFollowups(now);
      this.enqueueMaintenanceReminders(now);
      for (const run of this.database.verifyDueActionRuns(now)) {
        this.enqueueActionVerification(run, now);
        this.bus.publish({ type: "mutation", data: {
          method: "PATCH",
          resource: `/action-runs/${run.id}`,
          occurredAt: now.toISOString(),
        } });
      }
    } finally {
      this.#tickActive = false;
    }
  }

  private evaluateWallClock(now: Date): void {
    const maximumSampleAgeMs = 15 * 60_000;
    for (const pending of this.database.listDueAlertConditions(now)) {
      const latest = this.database.getLatestMeasurementSample(pending.sensorId, pending.rule.metric);
      if (!latest || latest.quality === "stale") continue;
      const latestMs = Date.parse(latest.timestamp);
      if (!Number.isFinite(latestMs) || now.getTime() - latestMs > maximumSampleAgeMs || latestMs > now.getTime()) continue;
      this.evaluateRule(pending.rule, { ...latest, timestamp: now.toISOString() }, now.getTime());
    }
  }

  private enqueueFollowups(now: Date): void {
    for (const event of this.database.listAlertEvents(1_000, true)) {
      if (event.acknowledgedAt || event.resolvedAt) continue;
      const rule = this.database.getAlertRule(event.ruleId);
      if (!rule || !rule.enabled || (!rule.webhookEnabled && !rule.telegramEnabled)) continue;
      const policy = rule.deliveryPolicy;
      if (!policy) continue;
      const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(event.startedAt)) / 1_000));
      const sensor = this.database.getSensor(event.sensorId);
      const house = sensor ? this.database.getHouse(sensor.houseId) : null;
      const bindings = alertNotificationBindings(this.config, {
        houseLabel: house?.name ?? null,
        sensorLabel: sensor?.name ?? null,
      });
      let inserted = 0;
      if (policy.escalationAfterSeconds && elapsedSeconds >= policy.escalationAfterSeconds) {
        inserted += this.database.enqueueAlertFollowup(event, rule, "escalation", 0, bindings, now);
      }
      if (policy.reminderIntervalSeconds && elapsedSeconds >= policy.reminderIntervalSeconds) {
        const sequence = Math.floor(elapsedSeconds / policy.reminderIntervalSeconds);
        inserted += this.database.enqueueAlertFollowup(event, rule, "reminder", sequence, bindings, now);
      }
      if (inserted > 0) this.bus.publish({ type: "alert", data: event });
    }
  }

  private enqueueMaintenanceReminders(now: Date): void {
    if (!this.config) return;
    const webhookEnabled = Boolean(this.config.alertWebhookUrl);
    const telegramEnabled = Boolean(this.config.telegramBotToken && this.config.telegramChatId);
    if (!webhookEnabled && !telegramEnabled) return;
    for (const task of this.database.listMaintenanceTasks({ limit: 500 })) {
      if (!["planned", "in-progress"].includes(task.status)) continue;
      const dueDate = task.dueBy ?? task.plannedFor;
      if (!dueDate) continue;
      const house = task.houseId ? this.database.getHouse(task.houseId) : null;
      const localToday = localCalendarDate(now, house?.timezone ?? "UTC");
      if (dueDate > localToday) continue;
      const property = this.database.getProperty(task.propertyId);
      const overdue = dueDate < localToday;
      this.database.enqueueOperationalNotification({
        subjectKind: "maintenance",
        subjectId: task.id,
        stage: "due",
        sequence: 0,
        policy: { ...DEFAULT_ALERT_DELIVERY_POLICY, timeZone: house?.timezone ?? "UTC" },
        severity: overdue || task.priority === "urgent" ? "critical" : "warning",
        webhookEnabled,
        telegramEnabled,
        config: this.config,
        type: "maintenance.due",
        text: `${overdue ? "OVERDUE" : "DUE"} — ${task.title} (${property?.name ?? house?.name ?? "Property"}, ${dueDate})`,
        data: { task, overdue, dueDate },
        now,
      });
    }
  }

  private enqueueActionVerification(run: import("@climate-twin/contracts").ActionRun, now: Date): void {
    if (!this.config || !["verified", "not-improved"].includes(run.status)) return;
    const webhookEnabled = Boolean(this.config.alertWebhookUrl);
    const telegramEnabled = Boolean(this.config.telegramBotToken && this.config.telegramChatId);
    if (!webhookEnabled && !telegramEnabled) return;
    const sensor = this.database.getSensor(run.sensorId);
    const house = sensor ? this.database.getHouse(sensor.houseId) : null;
    this.database.enqueueOperationalNotification({
      subjectKind: "action-run",
      subjectId: run.id,
      stage: "verification",
      sequence: 0,
      policy: { ...DEFAULT_ALERT_DELIVERY_POLICY, timeZone: house?.timezone ?? "UTC" },
      severity: run.status === "verified" ? "info" : "warning",
      webhookEnabled,
      telegramEnabled,
      config: this.config,
      type: "action.verification",
      text: `${run.status === "verified" ? "Action verified" : "Action did not improve"} — ${sensor?.name ?? run.sensorId}: ${run.baselineValue} → ${run.resultValue ?? "no result"}`,
      data: { run, sensorName: sensor?.name ?? null, houseName: house?.name ?? null },
      now,
    });
  }

  evaluateSample(sample: MeasurementSample): AlertEvent[] {
    return this.evaluateSamples([sample]);
  }

  evaluateSamples(samples: readonly MeasurementSample[]): AlertEvent[] {
    if (samples.length === 0) return [];
    const rulesByMetric = new Map<string, AlertRule[]>();
    for (const rule of this.database.listAlertRules()) {
      if (!rule.enabled) continue;
      const rules = rulesByMetric.get(rule.metric) ?? [];
      rules.push(rule);
      rulesByMetric.set(rule.metric, rules);
    }
    const created: AlertEvent[] = [];
    for (const sample of samples) {
      if (sample.quality === "stale") continue;
      const timestampMs = Date.parse(sample.timestamp);
      const nowMs = Number.isFinite(timestampMs) ? timestampMs : Date.now();
      for (const rule of rulesByMetric.get(sample.metric) ?? []) {
        const event = this.evaluateRule(rule, sample, nowMs);
        if (event) created.push(event);
      }
    }
    return created;
  }

  private evaluateRule(rule: AlertRule, sample: MeasurementSample, nowMs: number): AlertEvent | null {
    if (!ruleApplies(rule, sample)) return null;
    const sensor = rule.webhookEnabled || rule.telegramEnabled ? this.database.getSensor(sample.sensorId) : null;
    const house = sensor ? this.database.getHouse(sensor.houseId) : null;
    const bindings = rule.webhookEnabled || rule.telegramEnabled
      ? alertNotificationBindings(this.config, {
          houseLabel: house?.name ?? null,
          sensorLabel: sensor?.name ?? null,
        })
      : undefined;
    const transition = this.database.applyAlertSample(
      rule,
      sample,
      compare(sample.value, rule.operator, rule.threshold),
      bindings,
    );
    if (transition.resolved) this.bus.publish({ type: "alert", data: transition.resolved });
    if (transition.created) this.bus.publish({ type: "alert", data: transition.created });
    return transition.created;
  }

  evaluate(reading: Reading): AlertEvent[] {
    const shared = { sensorId: reading.sensorId, timestamp: reading.timestamp, source: reading.source, quality: reading.quality };
    return this.evaluateSamples([
      { ...shared, metric: "temperature", value: reading.temperature, canonicalUnit: "°C" },
      { ...shared, metric: "humidity", value: reading.humidity, canonicalUnit: "%" },
    ]);
  }

  reset(): void {
    this.database.clearAlertEvaluationState();
  }
}

function localCalendarDate(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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

type TelemetrySource = MeasurementSample["source"] | Reading["source"];
const DEMO_TELEMETRY_SOURCES = new Set<TelemetrySource>(["mock", "replay"]);

function demoDataWasDisabled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "DEMO_DATA_DISABLED"
    || (typeof candidate.message === "string" && candidate.message.includes("DEMO_DATA_DISABLED"));
}

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

function samplesFromReading(database: ClimateDatabase, reading: Reading): MeasurementSample[] {
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

type StoredMeasurementDefinition = NonNullable<ReturnType<ClimateDatabase["getMeasurementDefinition"]>>;

interface MeasurementIngestOptions {
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
    const inserted = this.database.insertMeasurementSamples(samples, options.deduplicateAcrossSources !== undefined
      ? { deduplicateAcrossSources: options.deduplicateAcrossSources }
      : {});
    this.dataMode.synchronize();
    if (options.publish !== false) {
      for (const sample of inserted) this.bus.publishMeasurement(sample);
    }
    if (options.evaluateAlerts !== false) this.alertEngine.evaluateSamples(inserted);
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

  ingestBatch(readings: Reading[]): Reading[] {
    const nowMs = Date.now();
    const validated = new Map<string, Sensor>();
    for (const reading of readings) {
      this.validateSensor(reading, validated);
      validateLiveTimestamp(reading.timestamp, nowMs);
      this.validateMeasurements(reading);
    }
    this.dataMode.prepareSources(readings.map((reading) => reading.source));
    const inserted = this.database.insertReadings(readings);
    this.dataMode.synchronize();
    const samples: MeasurementSample[] = [];
    for (const reading of inserted) {
      this.bus.publish({ type: "reading", data: reading });
      for (const sample of samplesFromReading(this.database, reading)) {
        samples.push(sample);
        this.bus.publishMeasurement(sample);
      }
    }
    this.alertEngine.evaluateSamples(samples);
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
    private readonly dataMode: DataModeCoordinator,
  ) {
    const persisted = this.database.mockScenarioId();
    if (MOCK_SCENARIOS.some((scenario) => scenario.id === persisted)) {
      this.#scenario = persisted as MockScenario["id"];
    }
  }

  get scenario(): MockScenario["id"] {
    const persisted = this.database.mockScenarioId();
    return MOCK_SCENARIOS.some((scenario) => scenario.id === persisted)
      ? persisted as MockScenario["id"]
      : this.#scenario;
  }

  setScenario(scenario: MockScenario["id"]): void {
    this.dataMode.prepareSources(["mock"]);
    this.database.setMockScenarioId(scenario);
    this.#scenario = scenario;
    this.#tick = 0;
  }

  start(): void {
    if (this.#timer || !this.config.mockEnabled || this.dataMode.isRealMode) return;
    this.#timer = setInterval(() => {
      if (this.dataMode.synchronize()) {
        this.stop();
        return;
      }
      try {
        this.generate();
      } catch (error) {
        // A second process can latch the shared database after the coordinator
        // check but before the insert. Both service errors and SQLite trigger
        // aborts are expected shutdown signals for this timer.
        if (demoDataWasDisabled(error)) {
          this.dataMode.synchronize();
          this.stop();
          return;
        }
        throw error;
      }
    }, this.config.mockIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  generate(): Reading[] {
    this.dataMode.prepareSources(["mock"]);
    this.#tick += 1;
    const now = new Date().toISOString();
    const generated: Reading[] = [];
    const sensors = this.database.listSensors().filter((sensor) => sensor.enabled);
    const scenario = this.scenario;
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
      if (scenario === "shower") {
        const distance = Math.hypot(sensor.x - 10.5, sensor.y - 7.5) + (sensor.floorId === "floor-upper" ? 0 : 8);
        humidity += Math.max(0, 2.2 - distance * 0.16);
        temperature += Math.max(0, 0.08 - distance * 0.006);
        co2 += Math.max(0, 18 - distance * 1.2);
      } else if (scenario === "leak") {
        const distance = Math.hypot(sensor.x - 11, sensor.y - 7.5) + (sensor.floorId === "floor-ground" ? 0 : 7);
        humidity += Math.max(0, 1.35 - distance * 0.11);
      } else if (scenario === "cold-front") {
        const front = (this.#tick / 4) % 18;
        temperature -= Math.max(0, 0.32 - Math.abs(sensor.x - front) * 0.055);
      } else if (scenario === "heating-failure") {
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
      generated.push(reading);
    }
    return this.telemetry.ingestBatch(generated);
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
    return this.startReadings(this.database.history(sensorIds, from, to, 50_000), from, to, speed);
  }

  startReadings(readings: readonly Reading[], from: string, to: string, speed = 60): ReplayState {
    this.stop();
    this.#readings = readings.slice(-50_000);
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

  reset(): ReplayState {
    this.stop();
    this.#readings = [];
    this.#index = 0;
    this.#from = null;
    this.#to = null;
    return this.state;
  }

  private schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      const current = this.#readings[this.#index];
      if (!current) {
        this.#timer = null;
        return;
      }
      const replayReading: Reading = { ...current, source: "replay" };
      this.bus.publish({ type: "reading", data: replayReading });
      for (const sample of samplesFromReading(this.database, replayReading)) {
        this.bus.publishMeasurement(sample);
      }
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
