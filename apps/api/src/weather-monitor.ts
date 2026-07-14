import type { House, HouseWeather } from "@climate-twin/contracts";
import { outdoorLocationKey } from "./db.js";

const DEFAULT_HOURS = 48;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_STARTUP_JITTER_MS = 60_000;
const DEFAULT_INTERVAL_JITTER_MS = 60_000;
const DEFAULT_BACKOFF_BASE_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MAX_MS = 6 * 60 * 60_000;
const MAXIMUM_CONCURRENCY = 32;

export interface WeatherMonitorHouseRepository {
  listHouses(): House[] | Promise<House[]>;
  getHouse(id: string): House | null | Promise<House | null>;
}

/** The subset of WeatherService used by the monitor. */
export interface WeatherMonitorRefreshService {
  get(house: House, hours: number): Promise<HouseWeather>;
}

export type WeatherMonitorPersistence = (weather: HouseWeather, currentHouse: House) => void | Promise<void>;

export interface WeatherMonitorRunSummary {
  startedAt: string;
  completedAt: string;
  locatedHouses: number;
  attempted: number;
  succeeded: number;
  failed: number;
  superseded: number;
  backedOff: number;
  lastError: string | null;
}

export interface WeatherMonitorStatus {
  started: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastRun: WeatherMonitorRunSummary | null;
}

export interface WeatherMonitorOptions {
  houses: WeatherMonitorHouseRepository;
  weather: WeatherMonitorRefreshService;
  persist: WeatherMonitorPersistence;
  hours?: number;
  concurrency?: number;
  intervalMs?: number;
  startupJitterMs?: number;
  intervalJitterMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
  random?: () => number;
  onStatusChange?: (status: WeatherMonitorStatus) => void;
}

interface LocatedHouseSnapshot {
  house: House;
  updatedAt: string;
  locationKey: string;
}

interface HouseBackoff {
  failures: number;
  retryAt: number;
  updatedAt: string;
  locationKey: string;
}

function finiteInteger(value: number, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Weather refresh failed";
}

/**
 * Periodically refreshes all located houses without overlapping cycles or an
 * unbounded Promise.all fan-out. Scheduling starts only after start() is called.
 */
export class WeatherMonitor {
  readonly #houses: WeatherMonitorHouseRepository;
  readonly #weather: WeatherMonitorRefreshService;
  readonly #persist: WeatherMonitorPersistence;
  readonly #hours: number;
  readonly #concurrency: number;
  readonly #intervalMs: number;
  readonly #startupJitterMs: number;
  readonly #intervalJitterMs: number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #onStatusChange: ((status: WeatherMonitorStatus) => void) | undefined;
  readonly #backoff = new Map<string, HouseBackoff>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #activeRun: Promise<WeatherMonitorRunSummary> | null = null;
  #lifecycle = 0;
  #cancellation = 0;
  #status: WeatherMonitorStatus = {
    started: false,
    running: false,
    nextRunAt: null,
    lastRun: null,
  };

  constructor(options: WeatherMonitorOptions) {
    this.#houses = options.houses;
    this.#weather = options.weather;
    this.#persist = options.persist;
    this.#hours = finiteInteger(options.hours ?? DEFAULT_HOURS, "hours", 1, 240);
    this.#concurrency = finiteInteger(
      options.concurrency ?? DEFAULT_CONCURRENCY,
      "concurrency",
      1,
      MAXIMUM_CONCURRENCY,
    );
    this.#intervalMs = finiteInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs", 1);
    this.#startupJitterMs = finiteInteger(options.startupJitterMs ?? DEFAULT_STARTUP_JITTER_MS, "startupJitterMs", 0);
    this.#intervalJitterMs = finiteInteger(options.intervalJitterMs ?? DEFAULT_INTERVAL_JITTER_MS, "intervalJitterMs", 0);
    this.#backoffBaseMs = finiteInteger(options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS, "backoffBaseMs", 1);
    this.#backoffMaxMs = finiteInteger(options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS, "backoffMaxMs", 1);
    if (this.#backoffMaxMs < this.#backoffBaseMs) {
      throw new RangeError("backoffMaxMs must be greater than or equal to backoffBaseMs");
    }
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#onStatusChange = options.onStatusChange;
  }

  get status(): WeatherMonitorStatus {
    return {
      ...this.#status,
      lastRun: this.#status.lastRun ? { ...this.#status.lastRun } : null,
    };
  }

  start(): void {
    if (this.#status.started) return;
    this.#status.started = true;
    const lifecycle = ++this.#lifecycle;
    this.#schedule(this.#jitter(this.#startupJitterMs), lifecycle);
  }

  stop(): void {
    if (!this.#status.started && !this.#timer && !this.#activeRun) return;
    this.#status.started = false;
    this.#status.nextRunAt = null;
    this.#lifecycle += 1;
    if (this.#activeRun) this.#cancellation += 1;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#emitStatus();
  }

  /** Concurrent callers share the same cycle, preventing overlapping refresh bursts. */
  runOnce(): Promise<WeatherMonitorRunSummary> {
    if (this.#activeRun) return this.#activeRun;
    const run = this.#executeAndRelease(this.#cancellation);
    this.#activeRun = run;
    return run;
  }

  async #executeAndRelease(cancellation: number): Promise<WeatherMonitorRunSummary> {
    try {
      // Yield once so runOnce() can publish the active promise before any
      // repository or status callback can re-enter the monitor.
      await Promise.resolve();
      return await this.#executeRun(cancellation);
    } finally {
      this.#activeRun = null;
    }
  }

  async #executeRun(cancellation: number): Promise<WeatherMonitorRunSummary> {
    const startedAt = new Date(this.#now()).toISOString();
    const summary: WeatherMonitorRunSummary = {
      startedAt,
      completedAt: startedAt,
      locatedHouses: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      superseded: 0,
      backedOff: 0,
      lastError: null,
    };
    this.#status.running = true;
    this.#emitStatus();
    try {
      if (this.#cancelled(cancellation)) return summary;
      const snapshots = await this.#locatedHouseSnapshots();
      if (this.#cancelled(cancellation)) {
        summary.superseded += snapshots.length;
        return summary;
      }
      summary.locatedHouses = snapshots.length;
      const currentIds = new Set(snapshots.map((snapshot) => snapshot.house.id));
      for (const houseId of this.#backoff.keys()) {
        if (!currentIds.has(houseId)) this.#backoff.delete(houseId);
      }
      const runnable = snapshots.filter((snapshot) => {
        const state = this.#backoff.get(snapshot.house.id);
        if (state && (state.updatedAt !== snapshot.updatedAt || state.locationKey !== snapshot.locationKey)) {
          this.#backoff.delete(snapshot.house.id);
          return true;
        }
        if (state && state.retryAt > this.#now()) {
          summary.backedOff += 1;
          return false;
        }
        return true;
      });
      summary.attempted = runnable.length;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < runnable.length && !this.#cancelled(cancellation)) {
          const snapshot = runnable[cursor];
          cursor += 1;
          if (snapshot) await this.#refreshHouse(snapshot, summary, cancellation);
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(this.#concurrency, runnable.length) },
        () => worker(),
      ));
    } catch (error) {
      summary.lastError = errorMessage(error);
    } finally {
      summary.completedAt = new Date(this.#now()).toISOString();
      this.#status.running = false;
      this.#status.lastRun = { ...summary };
      this.#emitStatus();
    }
    return { ...summary };
  }

  async #locatedHouseSnapshots(): Promise<LocatedHouseSnapshot[]> {
    const houses = await this.#houses.listHouses();
    const unique = new Map<string, LocatedHouseSnapshot>();
    for (const house of houses) {
      if (!house.location || unique.has(house.id)) continue;
      unique.set(house.id, {
        house,
        updatedAt: house.updatedAt,
        locationKey: outdoorLocationKey(house.location),
      });
    }
    return [...unique.values()];
  }

  async #refreshHouse(
    snapshot: LocatedHouseSnapshot,
    summary: WeatherMonitorRunSummary,
    cancellation: number,
  ): Promise<void> {
    let weather: HouseWeather;
    try {
      weather = await this.#weather.get(snapshot.house, this.#hours);
    } catch (error) {
      await this.#recordFailureUnlessSuperseded(snapshot, summary, error, cancellation);
      return;
    }
    if (this.#cancelled(cancellation)) {
      summary.superseded += 1;
      return;
    }
    if (weather.stale) {
      await this.#recordFailureUnlessSuperseded(
        snapshot,
        summary,
        new Error("Weather refresh returned a stale result"),
        cancellation,
      );
      return;
    }

    let current: House | null;
    try {
      current = await this.#houses.getHouse(snapshot.house.id);
    } catch (error) {
      this.#recordFailure(snapshot, summary, error);
      return;
    }
    if (this.#cancelled(cancellation)) {
      summary.superseded += 1;
      return;
    }
    if (!this.#fenceMatches(snapshot, current, weather)) {
      this.#recordSuperseded(snapshot.house.id, summary);
      return;
    }

    try {
      await this.#persist(weather, current as House);
      this.#backoff.delete(snapshot.house.id);
      summary.succeeded += 1;
    } catch (error) {
      await this.#recordFailureUnlessSuperseded(snapshot, summary, error, cancellation);
    }
  }

  async #recordFailureUnlessSuperseded(
    snapshot: LocatedHouseSnapshot,
    summary: WeatherMonitorRunSummary,
    error: unknown,
    cancellation: number,
  ): Promise<void> {
    if (this.#cancelled(cancellation)) {
      summary.superseded += 1;
      return;
    }
    try {
      const current = await this.#houses.getHouse(snapshot.house.id);
      if (this.#cancelled(cancellation)) {
        summary.superseded += 1;
        return;
      }
      if (!this.#snapshotMatches(snapshot, current)) {
        this.#recordSuperseded(snapshot.house.id, summary);
        return;
      }
    } catch (refreshError) {
      this.#recordFailure(snapshot, summary, refreshError);
      return;
    }
    this.#recordFailure(snapshot, summary, error);
  }

  #cancelled(cancellation: number): boolean {
    return cancellation !== this.#cancellation;
  }

  #snapshotMatches(snapshot: LocatedHouseSnapshot, current: House | null): boolean {
    return Boolean(current?.location)
      && current?.updatedAt === snapshot.updatedAt
      && outdoorLocationKey(current.location) === snapshot.locationKey;
  }

  #fenceMatches(snapshot: LocatedHouseSnapshot, current: House | null, weather: HouseWeather): boolean {
    return this.#snapshotMatches(snapshot, current)
      && weather.houseId === snapshot.house.id
      && outdoorLocationKey(weather.location) === snapshot.locationKey;
  }

  #recordSuperseded(houseId: string, summary: WeatherMonitorRunSummary): void {
    this.#backoff.delete(houseId);
    summary.superseded += 1;
  }

  #recordFailure(snapshot: LocatedHouseSnapshot, summary: WeatherMonitorRunSummary, error: unknown): void {
    const failures = (this.#backoff.get(snapshot.house.id)?.failures ?? 0) + 1;
    const exponent = Math.min(30, failures - 1);
    const delay = Math.min(this.#backoffMaxMs, this.#backoffBaseMs * 2 ** exponent);
    this.#backoff.set(snapshot.house.id, {
      failures,
      retryAt: this.#now() + delay,
      updatedAt: snapshot.updatedAt,
      locationKey: snapshot.locationKey,
    });
    summary.failed += 1;
    summary.lastError = errorMessage(error);
  }

  #jitter(maximumMs: number): number {
    const sample = this.#random();
    const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
    return Math.floor(maximumMs * normalized);
  }

  #schedule(delayMs: number, lifecycle: number): void {
    if (!this.#status.started || lifecycle !== this.#lifecycle) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#status.nextRunAt = new Date(this.#now() + delayMs).toISOString();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#status.nextRunAt = null;
      this.#emitStatus();
      void this.#scheduledRun(lifecycle);
    }, delayMs);
    this.#emitStatus();
  }

  async #scheduledRun(lifecycle: number): Promise<void> {
    try {
      await this.runOnce();
    } finally {
      if (this.#status.started && lifecycle === this.#lifecycle) {
        // Positive interval jitter never shortens the configured minimum cadence.
        this.#schedule(this.#intervalMs + this.#jitter(this.#intervalJitterMs), lifecycle);
      }
    }
  }

  #emitStatus(): void {
    try {
      this.#onStatusChange?.(this.status);
    } catch {
      // Monitoring must remain live even if an optional status sink fails.
    }
  }
}
