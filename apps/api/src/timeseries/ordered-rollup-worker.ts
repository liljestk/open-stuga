import type { TimeseriesStore } from "./store.js";

const DEFAULT_IDLE_INTERVAL_MS = 5_000;
const DEFAULT_BUSY_INTERVAL_MS = 250;
const DEFAULT_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 4;

/** Low-priority, single-lane maintenance for exact ordered analytics states. */
export class TelemetryOrderedRollupWorker {
  readonly #store: TimeseriesStore;
  readonly #idleIntervalMs: number;
  readonly #busyIntervalMs: number;
  readonly #retryIntervalMs: number;
  readonly #batchSize: number;
  readonly #ready: () => boolean;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<boolean> | null = null;
  #stopping = false;

  constructor(store: TimeseriesStore, options: {
    idleIntervalMs?: number;
    busyIntervalMs?: number;
    retryIntervalMs?: number;
    batchSize?: number;
    ready?: () => boolean;
  } = {}) {
    this.#store = store;
    this.#idleIntervalMs = Math.max(250, options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS);
    this.#busyIntervalMs = Math.max(25, options.busyIntervalMs ?? DEFAULT_BUSY_INTERVAL_MS);
    this.#retryIntervalMs = Math.max(1_000, options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
    this.#batchSize = Math.max(1, Math.min(32, options.batchSize ?? DEFAULT_BATCH_SIZE));
    this.#ready = options.ready ?? (() => true);
  }

  start(): void {
    if (this.#stopping || this.#timer || this.#running) return;
    this.#schedule(0);
  }

  wake(): void {
    if (this.#stopping || this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => undefined);
  }

  #schedule(delayMs: number): void {
    if (this.#stopping) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#startCycle();
    }, delayMs);
    this.#timer.unref();
  }

  #startCycle(): void {
    if (this.#stopping || this.#running) return;
    const cycle = this.#cycle();
    this.#running = cycle;
    void cycle.then(
      (moreLikely) => this.#schedule(moreLikely ? this.#busyIntervalMs : this.#idleIntervalMs),
      () => this.#schedule(this.#retryIntervalMs),
    ).finally(() => {
      if (this.#running === cycle) this.#running = null;
    });
  }

  async #cycle(): Promise<boolean> {
    if (!this.#ready()) return false;
    for (let index = 0; index < this.#batchSize && !this.#stopping; index += 1) {
      const result = await this.#store.rebuildNextMeasurementOrderedRollup({ timeoutMs: 15_000 });
      if (!result.processed) return false;
    }
    return !this.#stopping;
  }
}
