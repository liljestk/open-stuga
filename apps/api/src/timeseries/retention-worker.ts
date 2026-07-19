import type { ClimateDatabase } from "../db.js";
import type { TelemetryArchiveWorker } from "./archive-worker.js";

const RETENTION_CHECK_INTERVAL_MS = 60 * 60_000;

/**
 * Safely bounds only the SQLite hot copy. Raw Timescale rows have no retention
 * policy and remain the permanent source of historical truth.
 */
export class TelemetryRetentionWorker {
  #timer: NodeJS.Timeout | null = null;
  #active: Promise<number | undefined> | null = null;
  #stopping = false;

  constructor(
    private readonly database: ClimateDatabase,
    private readonly archive: TelemetryArchiveWorker,
    private readonly retentionDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 30) {
      throw new RangeError("SQLite hot retention must be at least 30 days");
    }
  }

  start(): void {
    if (this.#timer || this.#stopping) return;
    this.#timer = setInterval(() => this.wake(), RETENTION_CHECK_INTERVAL_MS);
    this.#timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.#stopping || this.#active) return;
    const active = this.runOnce().catch(() => undefined).finally(() => {
      if (this.#active === active) this.#active = null;
    });
    this.#active = active;
  }

  async runOnce(): Promise<number> {
    if (this.#stopping) return 0;
    const before = this.archive.status();
    if (!before.timescaleAvailable || before.phase !== "ready" || !before.caughtUp) return 0;
    if (this.database.telemetryArchiveDirtyCount() > 0) {
      await this.archive.reconcileNow();
      return 0;
    }
    // Reconcile immediately before taking watermarks. Pruning never trusts a
    // stale checkpoint or a worker status captured before concurrent writes.
    await this.archive.reconcileNow();
    const status = this.archive.status();
    if (this.#stopping || status.phase !== "ready" || !status.caughtUp
      || this.database.telemetryArchiveDirtyCount() > 0) return 0;
    const cutoff = new Date(this.now().getTime() - this.retentionDays * 86_400_000).toISOString();
    return this.database.purgeReadingsBefore(cutoff, 5_000, this.database.telemetryArchiveWatermarks());
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#active;
  }
}
