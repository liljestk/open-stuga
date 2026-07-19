import type { MeasurementSample, TelemetryEvent } from "@climate-twin/contracts";

export class TelemetryBus {
  readonly #telemetryListeners = new Set<(event: TelemetryEvent) => void>();
  readonly #measurementListeners = new Set<(sample: MeasurementSample) => void>();

  subscribe(listener: (event: TelemetryEvent) => void): () => void {
    this.#telemetryListeners.add(listener);
    return () => this.#telemetryListeners.delete(listener);
  }

  publish(event: TelemetryEvent): void {
    for (const listener of [...this.#telemetryListeners]) {
      try {
        listener(event);
      } catch {
        // Live observers are failure-isolated: persistence and alert evaluation
        // must never be reported as failed because an SSE/client listener threw.
      }
    }
  }

  subscribeMeasurements(listener: (sample: MeasurementSample) => void): () => void {
    this.#measurementListeners.add(listener);
    return () => this.#measurementListeners.delete(listener);
  }

  publishMeasurement(sample: MeasurementSample): void {
    for (const listener of [...this.#measurementListeners]) {
      try {
        listener(sample);
      } catch {
        // See publish(): one faulty observer cannot stop the remaining listeners.
      }
    }
  }
}
