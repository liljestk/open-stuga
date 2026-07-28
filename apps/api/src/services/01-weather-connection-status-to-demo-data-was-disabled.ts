import {
  hasLocalHouseAuthority,
  type AlertEvent,
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

export type WeatherConnectionStatus = NonNullable<IntegrationStatus["weather"]["connections"]>[number];

export class RuntimeStatus {
  readonly value: IntegrationStatus;
  readonly #bus: TelemetryBus;
  readonly #database: ClimateDatabase;

  constructor(config: AppConfig, bus: TelemetryBus, database: ClimateDatabase) {
    this.#bus = bus;
    this.#database = database;
    const webhookDestinations = configuredAlertWebhookDestinations(config);
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
          host: connection.host,
          sourceType: connection.sourceType ?? null,
          sourceModel: connection.sourceModel ?? null,
          sourceAlias: connection.sourceAlias ?? null,
        })),
      },
      webhook: {
        configured: webhookDestinations.length > 0,
        lastDeliveryAt: null,
        error: null,
        destinations: webhookDestinations.map((destination) => ({
          id: destination.id,
          lastDeliveryAt: null,
          error: null,
        })),
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
    return this.#database.listHouses()
      .filter((house) => hasLocalHouseAuthority(house) && house.location !== undefined)
      .length;
  }

  private weatherConnections(
    existing: WeatherConnectionStatus[] = [],
    fallbackProvider: IntegrationStatus["weather"]["provider"] = "fmi",
  ): WeatherConnectionStatus[] {
    const previous = new Map(existing.map((connection) => [connection.houseId, connection]));
    return this.#database.listHouses().filter(hasLocalHouseAuthority).map((house) => {
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

export function compare(value: number, operator: AlertRule["operator"], threshold: number): boolean {
  switch (operator) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
  }
}

export function ruleApplies(rule: AlertRule, sample: MeasurementSample): boolean {
  return rule.enabled
    && rule.metric === sample.metric
    && (rule.sensorId === null || rule.sensorId === sample.sensorId);
}

/** Live senders may lead the server clock by at most five minutes. */
export const LIVE_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60_000;

export function validateLiveTimestamp(timestamp: string, nowMs: number): void {
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
      if (!rule || !rule.enabled) continue;
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
    const webhookEnabled = configuredAlertWebhookDestinations(this.config).length > 0;
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
    const webhookEnabled = configuredAlertWebhookDestinations(this.config).length > 0;
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
    const nativePushEnabled = Boolean(
      this.config?.apnsTeamId
        && this.config.apnsKeyId
        && this.config.apnsBundleId
        && this.config.apnsPrivateKey,
    );
    const sensor = rule.webhookEnabled || rule.telegramEnabled || nativePushEnabled
      ? this.database.getSensor(sample.sensorId)
      : null;
    const house = sensor ? this.database.getHouse(sensor.houseId) : null;
    const bindings = rule.webhookEnabled || rule.telegramEnabled || nativePushEnabled
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

export function localCalendarDate(value: Date, timeZone: string): string {
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

export type TelemetrySource = MeasurementSample["source"] | Reading["source"];

export const DEMO_TELEMETRY_SOURCES = new Set<TelemetrySource>(["mock", "replay"]);

export function demoDataWasDisabled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "DEMO_DATA_DISABLED"
    || (typeof candidate.message === "string" && candidate.message.includes("DEMO_DATA_DISABLED"));
}
