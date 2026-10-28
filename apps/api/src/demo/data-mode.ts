import { ClimateDatabase } from "../db.js";
import { DEMO_TELEMETRY_SOURCES, MeasurementValidationError, type TelemetrySource } from "../telemetry/ingest.js";

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
