import type { TelemetryArchiveWorker } from "./archive-worker.js";
import type { TelemetryOrderedRollupWorker } from "./ordered-rollup-worker.js";
import type { TelemetryRetentionWorker } from "./retention-worker.js";

/** Maintenance keeps polling through an initial archive startup failure. */
export function startArchiveMaintenance(
  archive: Pick<TelemetryArchiveWorker, "start">,
  ordered: Pick<TelemetryOrderedRollupWorker, "start"> | null,
  retention: Pick<TelemetryRetentionWorker, "start"> | null,
): Promise<void> {
  // Both workers gate database work on archive readiness themselves. Their
  // lifetime must not depend on the first, retryable initialization promise.
  ordered?.start();
  retention?.start();
  return archive.start();
}
