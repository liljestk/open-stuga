import type { MeasurementSample, Reading } from "@climate-twin/contracts";
import {
  type ClimateDatabase,
  type SensorDataGapRecord,
  type SensorDataGapSource,
} from "./db.js";
import type { MeasurementService } from "./services.js";

export interface SensorMetricAvailability {
  sensorId: string;
  metric: string;
  source: SensorDataGapSource;
  available: boolean;
  observedAt: string;
}

export interface SensorHistoryRecoveryResult {
  state: "complete" | "partial" | "not-supported";
  samples: MeasurementSample[];
  error: string | null;
}

export interface SensorGapRecoveryAdapter {
  readonly source: SensorDataGapSource;
  availability(now?: Date): SensorMetricAvailability[];
  recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
  /** Called only after returned samples have passed validation and ingestion. */
  recoveryAccepted?(sensorId: string, metric: string, from: string, to: string): void | Promise<void>;
}

export interface SensorGapRecoveryOptions {
  scanIntervalMs?: number;
  recoveryLeaseMs?: number;
  retryBaseMs?: number;
  historicalScanIntervalMs?: number;
  historicalScanWindowMs?: number;
  historicalGapLimit?: number;
  onRecovered?: () => void | Promise<void>;
}

const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_RECOVERY_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_HISTORICAL_SCAN_INTERVAL_MS = 15 * 60_000;
const DEFAULT_HISTORICAL_SCAN_WINDOW_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_HISTORICAL_GAP_LIMIT = 25;

function historicalGapThresholdMs(source: SensorDataGapSource): number {
  // Direct TP-Link climate values have a one-minute unchanged-value heartbeat.
  // Event-driven Home Assistant entities are excluded from periodic timestamp
  // discovery below because stable values are legitimate silence.
  return source === "tp-link" ? 15 * 60_000 : 30 * 60_000;
}

function availabilityKey(item: Pick<SensorMetricAvailability, "source" | "sensorId" | "metric">): string {
  return `${item.source}\u0000${item.sensorId}\u0000${item.metric}`;
}

function validIso(value: string): string | null {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/**
 * Converts adapter availability transitions into durable gaps and repairs every
 * closed gap through the owning adapter. A periodic scan covers process restarts;
 * adapter wake-ups make ordinary disconnect/reconnect transitions immediate.
 */
export class SensorGapRecoveryCoordinator {
  readonly #adapters = new Map<SensorDataGapSource, SensorGapRecoveryAdapter>();
  readonly #availability = new Map<string, boolean>();
  readonly #scanIntervalMs: number;
  readonly #recoveryLeaseMs: number;
  readonly #retryBaseMs: number;
  readonly #historicalScanIntervalMs: number;
  readonly #historicalScanWindowMs: number;
  readonly #historicalGapLimit: number;
  readonly #onRecovered: (() => void | Promise<void>) | undefined;
  readonly #nextHistoricalScanAt = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #run: Promise<void> | null = null;
  #rerunRequested = false;

  constructor(
    private readonly database: ClimateDatabase,
    private readonly measurements: MeasurementService,
    adapters: SensorGapRecoveryAdapter[],
    options: SensorGapRecoveryOptions = {},
  ) {
    for (const adapter of adapters) this.#adapters.set(adapter.source, adapter);
    this.#scanIntervalMs = Math.max(1_000, options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
    this.#recoveryLeaseMs = Math.max(10_000, options.recoveryLeaseMs ?? DEFAULT_RECOVERY_LEASE_MS);
    this.#retryBaseMs = Math.max(1_000, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS);
    this.#historicalScanIntervalMs = Math.max(
      1_000,
      options.historicalScanIntervalMs ?? DEFAULT_HISTORICAL_SCAN_INTERVAL_MS,
    );
    this.#historicalScanWindowMs = Math.max(
      60_000,
      options.historicalScanWindowMs ?? DEFAULT_HISTORICAL_SCAN_WINDOW_MS,
    );
    this.#historicalGapLimit = Math.max(1, Math.min(100, options.historicalGapLimit ?? DEFAULT_HISTORICAL_GAP_LIMIT));
    this.#onRecovered = options.onRecovered;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.wake();
    this.#timer = setInterval(() => this.wake(), this.#scanIntervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#run;
  }

  /** Safe to call from adapter callbacks, including while a scan is active. */
  wake(): void {
    if (!this.#running) return;
    if (this.#run) {
      this.#rerunRequested = true;
      return;
    }
    this.#run = this.#runLoop()
      .catch(() => {
        // Timer-driven recovery must never create an unhandled rejection. Keep
        // this boundary deliberately detail-free because adapter errors may
        // contain remote payloads or credentials; the durable gap state remains
        // the operator-facing source of diagnostic detail.
        console.warn(JSON.stringify({ event: "sensor_gap_recovery_scan_failed" }));
      })
      .finally(() => { this.#run = null; });
  }

  /** Deterministic entry point for tests and operator-triggered recovery. */
  async runOnce(now = new Date()): Promise<void> {
    if (this.#run) {
      this.#rerunRequested = true;
      await this.#run;
      return;
    }
    this.#run = this.#scanAndRecover(now).finally(() => { this.#run = null; });
    await this.#run;
  }

  async #runLoop(): Promise<void> {
    do {
      this.#rerunRequested = false;
      await this.#scanAndRecover(new Date());
    } while (this.#running && this.#rerunRequested);
  }

  async #scanAndRecover(now: Date): Promise<void> {
    for (const adapter of this.#adapters.values()) {
      let availability: SensorMetricAvailability[];
      try {
        availability = adapter.availability(now);
      } catch {
        continue;
      }
      for (const item of availability) {
        this.#observe(item);
        if (item.available) this.#discoverHistoricalGaps(item, now);
      }
    }
    await this.#recoverQueued(now);
  }

  #observe(item: SensorMetricAvailability): void {
    const observedAt = validIso(item.observedAt);
    if (!observedAt || !this.database.getSensor(item.sensorId)?.enabled
      || !this.database.getMeasurementDefinition(item.metric)?.enabled) return;
    const key = availabilityKey(item);
    const previous = this.#availability.get(key);
    this.#availability.set(key, item.available);
    const open = this.database.openSensorDataGap(item.sensorId, item.metric, item.source);

    if (item.available) {
      if (open) this.database.resolveSensorDataGap(item.sensorId, item.metric, item.source, observedAt);
      return;
    }
    if (open || previous === false) return;
    const latest = this.database.latestMeasurementTimestamp(item.sensorId, item.metric, item.source);
    if (!latest || Date.parse(latest) >= Date.parse(observedAt)) return;
    this.database.noteSensorDataGap(item.sensorId, item.metric, item.source, latest, observedAt);
  }

  #discoverHistoricalGaps(item: SensorMetricAvailability, now: Date): void {
    if (item.source === "home-assistant") return;
    const key = availabilityKey(item);
    if ((this.#nextHistoricalScanAt.get(key) ?? 0) > now.getTime()) return;
    this.#nextHistoricalScanAt.set(key, now.getTime() + this.#historicalScanIntervalMs);
    const from = new Date(now.getTime() - this.#historicalScanWindowMs).toISOString();
    const to = now.toISOString();
    const gaps = this.database.measurementSampleGaps(
      item.sensorId,
      item.metric,
      item.source,
      from,
      to,
      historicalGapThresholdMs(item.source),
      this.#historicalGapLimit,
    );
    for (const gap of gaps) {
      this.database.noteHistoricalSensorDataGap(
        item.sensorId,
        item.metric,
        item.source,
        gap.startedAt,
        gap.endedAt,
        to,
      );
    }
  }

  async #recoverQueued(now: Date): Promise<void> {
    for (const queued of this.database.recoverableSensorDataGaps(now.toISOString())) {
      const attemptedAt = now.toISOString();
      if (!this.database.getSensor(queued.sensorId)?.enabled
        || !this.database.getMeasurementDefinition(queued.metric)?.enabled) {
        this.database.updateSensorDataGapRecovery(
          queued.id,
          "not-supported",
          queued.recoveredPoints,
          attemptedAt,
          "Sensor or measurement metric was disabled before history recovery",
        );
        continue;
      }
      const claimed = this.database.claimSensorDataGapRecovery(
        queued.id,
        attemptedAt,
        new Date(Date.parse(attemptedAt) + this.#recoveryLeaseMs).toISOString(),
      );
      if (!claimed?.endedAt) continue;
      await this.#recover(claimed, attemptedAt);
    }
  }

  async #recover(gap: SensorDataGapRecord, attemptedAt: string): Promise<void> {
    const adapter = this.#adapters.get(gap.source);
    if (!adapter) {
      this.database.updateSensorDataGapRecovery(
        gap.id, "not-supported", gap.recoveredPoints, attemptedAt, `No recovery adapter is registered for ${gap.source}`,
      );
      return;
    }
    try {
      const result = await adapter.recoverHistory(gap.sensorId, gap.metric, gap.startedAt, gap.endedAt!);
      if (!this.database.getSensor(gap.sensorId)?.enabled
        || !this.database.getMeasurementDefinition(gap.metric)?.enabled) {
        this.database.updateSensorDataGapRecovery(
          gap.id,
          "not-supported",
          gap.recoveredPoints,
          attemptedAt,
          "Sensor or measurement metric was disabled while history recovery was in flight",
        );
        return;
      }
      let insertedCount = 0;
      const accepted = result.samples.filter((sample) => sample.sensorId === gap.sensorId
        && sample.metric === gap.metric && sample.source === gap.source
        && Date.parse(sample.timestamp) >= Date.parse(gap.startedAt)
        && Date.parse(sample.timestamp) <= Date.parse(gap.endedAt!));
      for (let offset = 0; offset < accepted.length; offset += 1_000) {
        insertedCount += this.measurements.ingestBatch(accepted.slice(offset, offset + 1_000), {
          publish: false,
          evaluateAlerts: false,
        }).length;
      }
      const recoveredPoints = gap.recoveredPoints + insertedCount;
      if (gap.source === "home-assistant" && (gap.metric === "temperature" || gap.metric === "humidity")) {
        this.#rebuildLegacyClimateProjection(gap);
      }
      const retryAt = result.state === "partial"
        ? new Date(Date.parse(attemptedAt) + (accepted.length > 0 ? 1_000 : this.#retryDelay(gap.attemptCount))).toISOString()
        : null;
      this.database.updateSensorDataGapRecovery(
        gap.id, result.state, recoveredPoints, attemptedAt, result.error, retryAt,
      );
      await adapter.recoveryAccepted?.(gap.sensorId, gap.metric, gap.startedAt, gap.endedAt!);
      if (insertedCount > 0) await this.#onRecovered?.();
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Sensor history recovery failed").slice(0, 1_000);
      this.database.updateSensorDataGapRecovery(
        gap.id,
        "failed",
        gap.recoveredPoints,
        attemptedAt,
        message,
        new Date(Date.parse(attemptedAt) + this.#retryDelay(gap.attemptCount)).toISOString(),
      );
    }
  }

  #retryDelay(attemptCount: number): number {
    return Math.min(60 * 60_000, this.#retryBaseMs * 2 ** Math.min(6, Math.max(0, attemptCount - 1)));
  }

  #rebuildLegacyClimateProjection(gap: SensorDataGapRecord): void {
    if (!gap.endedAt) return;
    const temperatureBaseline = this.database.measurementSampleAtOrBefore(
      gap.sensorId, "temperature", "home-assistant", gap.startedAt,
    );
    const humidityBaseline = this.database.measurementSampleAtOrBefore(
      gap.sensorId, "humidity", "home-assistant", gap.startedAt,
    );
    if (!temperatureBaseline || !humidityBaseline) return;
    const events = [
      ...this.database.measurementHistory(gap.sensorId, "temperature", gap.startedAt, gap.endedAt, 100_000),
      ...this.database.measurementHistory(gap.sensorId, "humidity", gap.startedAt, gap.endedAt, 100_000),
    ].filter((sample) => sample.source === "home-assistant")
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.metric.localeCompare(right.metric));
    let temperature = temperatureBaseline;
    let humidity = humidityBaseline;
    for (const event of events) {
      if (event.metric === "temperature") temperature = event;
      if (event.metric === "humidity") humidity = event;
      if (Date.parse(event.timestamp) <= Date.parse(gap.startedAt)) continue;
      const reading: Reading = {
        sensorId: gap.sensorId,
        timestamp: event.timestamp,
        temperature: temperature.value,
        humidity: humidity.value,
        battery: null,
        source: "home-assistant",
        quality: temperature.timestamp === humidity.timestamp ? "good" : "estimated",
      };
      this.database.upsertLegacyReading(reading);
    }
  }
}
