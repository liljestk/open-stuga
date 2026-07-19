import type { SpatialSnapshotNotification } from "./types.js";

export interface SpatialSnapshotNotifier {
  publish(notification: SpatialSnapshotNotification): void;
  subscribe(listener: (notification: SpatialSnapshotNotification) => void): () => void;
}

/**
 * Failure-isolated process-local wake-up channel. History always comes from the
 * state store, so dropped notifications do not lose snapshots.
 */
export class InMemorySpatialSnapshotNotifier implements SpatialSnapshotNotifier {
  readonly #listeners = new Set<(notification: SpatialSnapshotNotification) => void>();

  publish(notification: SpatialSnapshotNotification): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(notification);
      } catch {
        // A renderer/SSE listener can never fail inference or another listener.
      }
    }
  }

  subscribe(listener: (notification: SpatialSnapshotNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
