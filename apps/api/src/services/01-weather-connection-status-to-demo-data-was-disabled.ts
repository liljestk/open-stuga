import { HttpError } from "../http-error.js";
import {
  hasLocalHouseAuthority,
  type AlertEvent,
  AlertRule,
  IntegrationStatus,
  type MaintenanceTask,
  MeasurementSample,
  Reading,
} from "@climate-twin/contracts";
import { configuredAlertWebhookDestinations, type AppConfig } from "../config.js";
import { ClimateDatabase, outdoorLocationKey, type AlertTransition } from "../db.js";
import { TelemetryBus } from "../events.js";
import { alertNotificationBindings } from "../notification-snapshot.js";
import { DEFAULT_ALERT_DELIVERY_POLICY } from "../notification-policy.js";
import type { HybridTelemetryReader } from "../timeseries/read-facade.js";

export type WeatherConnectionStatus = NonNullable<IntegrationStatus["weather"]["connections"]>[number];

export class RuntimeStatus {
  readonly value: IntegrationStatus;
  readonly #bus: TelemetryBus;
  readonly #database: ClimateDatabase;

  constructor(config: AppConfig, bus: TelemetryBus, database: ClimateDatabase) {
    this.#bus = bus;
    this.#database = database;
    const webhookDestinations = configuredAlertWebhookDestinations(config);
    const weatherConnections = this.weatherConnections();
    const latestWeatherSuccess = weatherConnections
      .filter((connection) => connection.lastSuccessAt !== null)
      .sort((left, right) => (right.lastSuccessAt as string).localeCompare(left.lastSuccessAt as string))[0];
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
        provider: latestWeatherSuccess?.provider ?? "fmi",
        configuredHouses: this.configuredWeatherHouses(),
        lastSuccessAt: latestWeatherSuccess?.lastSuccessAt ?? null,
        error: weatherConnections.find((connection) => connection.error)?.error ?? null,
        connections: weatherConnections,
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
      const snapshot = house.location
        ? this.#database.getWeatherSnapshot(house.id, outdoorLocationKey(house.location))
        : null;
      return {
        houseId: house.id,
        configured,
        provider: prior?.provider ?? snapshot?.weather?.provider ?? fallbackProvider,
        lastSuccessAt: configured ? (prior ? prior.lastSuccessAt : snapshot?.lastSuccessAt ?? null) : null,
        error: configured ? (prior ? prior.error : snapshot?.lastError ?? null) : null,
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
    throw new MeasurementValidationError(400, "INVALID_TIMESTAMP", "Measurement timestamp must be an ISO date-time");
  }
  if (timestampMs > nowMs + LIVE_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new MeasurementValidationError(
      422, "TIMESTAMP_TOO_FAR_IN_FUTURE",
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
    private readonly telemetryReader?: HybridTelemetryReader,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, 5_000);
    this.#timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#tickActive) return;
    this.#tickActive = true;
    try {
      this.evaluatePendingSamples();
      this.evaluateWallClock(now);
      this.enqueueFollowups(now);
      this.enqueueMaintenanceReminders(now);
      const verifiedRuns = this.telemetryReader
        ? await this.#verifyDueActionRunsFromTelemetry(now)
        : this.database.verifyDueActionRuns(now);
      for (const run of verifiedRuns) {
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

  async #verifyDueActionRunsFromTelemetry(now: Date): Promise<ReturnType<ClimateDatabase["listActionRuns"]>> {
    const due = this.database.listActionRuns({ activeOnly: true, limit: 500 })
      .filter((run) => run.status === "waiting" && run.verifyAfter && run.verificationDeadline
        && Date.parse(run.verifyAfter) <= now.getTime());
    const changed = [];
    for (const run of due) {
      const windowEnd = new Date(Math.min(now.getTime(), Date.parse(run.verificationDeadline!))).toISOString();
      const evidenceFrom = new Date(Math.max(Date.parse(run.verifyAfter!), Date.parse(run.baselineTimestamp) + 1)).toISOString();
      const samples = (await this.telemetryReader!.measurementHistory({
        sensorId: run.sensorId,
        metric: run.metric,
        from: evidenceFrom,
        to: windowEnd,
        limit: 10_000,
      })).records;
      const updated = this.database.verifyActionRun(run.id, samples, now);
      if (updated && (updated.status !== run.status || updated.sampleCount !== run.sampleCount
        || updated.resultValue !== run.resultValue)) changed.push(updated);
    }
    return changed;
  }

  private evaluateWallClock(now: Date): void {
    const maximumSampleAgeMs = 15 * 60_000;
    for (const pending of this.database.listDueAlertConditions(now)) {
      const latest = this.database.getLatestMeasurementSample(pending.sensorId, pending.rule.metric);
      if (!latest || latest.quality === "stale") continue;
      const latestMs = Date.parse(latest.timestamp);
      if (!Number.isFinite(latestMs) || now.getTime() - latestMs > maximumSampleAgeMs || latestMs > now.getTime()) continue;
      this.evaluateRule(pending.rule, { ...latest, timestamp: now.toISOString() });
    }
  }

  private enqueueFollowups(now: Date): void {
    for (const event of this.database.listAlertEvents(1_000, true)) {
      if (event.acknowledgedAt || event.resolvedAt) continue;
      const rule = this.database.getAlertRule(event.ruleId);
      if (!rule || !rule.enabled) continue;
      if (rule.deliveryPolicy && this.enqueueDueFollowups(event, rule, rule.deliveryPolicy, now) > 0) {
        this.bus.publish({ type: "alert", data: event });
      }
    }
  }

  // Returns how many escalation or reminder deliveries were newly queued for one open alert.
  private enqueueDueFollowups(
    event: AlertEvent,
    rule: AlertRule,
    policy: NonNullable<AlertRule["deliveryPolicy"]>,
    now: Date,
  ): number {
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
    return inserted;
  }

  private enqueueMaintenanceReminders(now: Date): void {
    if (!this.config) return;
    const webhookEnabled = configuredAlertWebhookDestinations(this.config).length > 0;
    const telegramEnabled = Boolean(this.config.telegramBotToken && this.config.telegramChatId);
    if (!webhookEnabled && !telegramEnabled) return;
    for (const task of this.database.listMaintenanceTasks({ limit: 500 })) {
      if (!["planned", "in-progress"].includes(task.status)) continue;
      const dueDate = task.dueBy ?? task.plannedFor;
      if (dueDate) this.enqueueMaintenanceReminder(task, dueDate, { webhookEnabled, telegramEnabled, config: this.config }, now);
    }
  }

  private enqueueMaintenanceReminder(
    task: MaintenanceTask,
    dueDate: string,
    channels: { webhookEnabled: boolean; telegramEnabled: boolean; config: AppConfig },
    now: Date,
  ): void {
    const house = task.houseId ? this.database.getHouse(task.houseId) : null;
    const localToday = localCalendarDate(now, house?.timezone ?? "UTC");
    if (dueDate > localToday) return;
    const property = this.database.getProperty(task.propertyId);
    const overdue = dueDate < localToday;
    this.database.enqueueOperationalNotification({
      subjectKind: "maintenance",
      subjectId: task.id,
      stage: "due",
      sequence: 0,
      policy: { ...DEFAULT_ALERT_DELIVERY_POLICY, timeZone: house?.timezone ?? "UTC" },
      severity: overdue || task.priority === "urgent" ? "critical" : "warning",
      ...channels,
      type: "maintenance.due",
      text: `${overdue ? "OVERDUE" : "DUE"} — ${task.title} (${property?.name ?? house?.name ?? "Property"}, ${dueDate})`,
      data: { task, overdue, dueDate },
      now,
    });
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
    const rulesByMetric = this.rulesByMetric();
    const created: AlertEvent[] = [];
    for (const sample of samples) {
      if (sample.quality === "stale") continue;
      for (const rule of rulesByMetric.get(sample.metric) ?? []) {
        const transition = this.applyRule(rule, sample);
        this.publishTransition(transition);
        if (transition.created) created.push(transition.created);
      }
    }
    return created;
  }

  evaluatePendingSamples(): AlertEvent[] {
    const created: AlertEvent[] = [];
    while (true) {
      const result = this.database.transaction(() => {
        const pending = this.database.listPendingAlertEvaluationSamples();
        if (pending.length === 0) return { processed: 0, transitions: [] as AlertTransition[] };
        const rulesByMetric = this.rulesByMetric();
        const transitions: AlertTransition[] = [];
        for (const { queueId, sample } of pending) {
          if (sample.quality !== "stale") {
            for (const rule of rulesByMetric.get(sample.metric) ?? []) {
              const transition = this.applyRule(rule, sample);
              if (transition.created || transition.resolved) transitions.push(transition);
            }
          }
          if (!this.database.completeAlertEvaluationSample(queueId)) {
            throw new Error(`Alert evaluation queue item ${queueId} disappeared before completion`);
          }
        }
        return { processed: pending.length, transitions };
      });
      for (const transition of result.transitions) {
        this.publishTransition(transition);
        if (transition.created) created.push(transition.created);
      }
      if (result.processed === 0) return created;
    }
  }

  private rulesByMetric(): Map<string, AlertRule[]> {
    const rulesByMetric = new Map<string, AlertRule[]>();
    for (const rule of this.database.listAlertRules()) {
      if (!rule.enabled) continue;
      const rules = rulesByMetric.get(rule.metric) ?? [];
      rules.push(rule);
      rulesByMetric.set(rule.metric, rules);
    }
    return rulesByMetric;
  }

  private applyRule(rule: AlertRule, sample: MeasurementSample): AlertTransition {
    if (!ruleApplies(rule, sample)) {
      return { ignoredAsStale: false, created: null, resolved: null };
    }
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
    return transition;
  }

  private publishTransition(transition: AlertTransition): void {
    if (transition.resolved) this.bus.publish({ type: "alert", data: transition.resolved });
    if (transition.created) this.bus.publish({ type: "alert", data: transition.created });
  }

  private evaluateRule(rule: AlertRule, sample: MeasurementSample): AlertEvent | null {
    const transition = this.applyRule(rule, sample);
    this.publishTransition(transition);
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

export function demoDataWasDisabled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "DEMO_DATA_DISABLED"
    || (typeof candidate.message === "string" && candidate.message.includes("DEMO_DATA_DISABLED"));
}
