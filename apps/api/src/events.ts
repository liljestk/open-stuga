import { EventEmitter } from "node:events";
import type { MeasurementSample, TelemetryEvent } from "@climate-twin/contracts";

export class TelemetryBus {
  readonly #emitter = new EventEmitter();

  subscribe(listener: (event: TelemetryEvent) => void): () => void {
    this.#emitter.on("telemetry", listener);
    return () => this.#emitter.off("telemetry", listener);
  }

  publish(event: TelemetryEvent): void {
    this.#emitter.emit("telemetry", event);
  }

  subscribeMeasurements(listener: (sample: MeasurementSample) => void): () => void {
    this.#emitter.on("measurement", listener);
    return () => this.#emitter.off("measurement", listener);
  }

  publishMeasurement(sample: MeasurementSample): void {
    this.#emitter.emit("measurement", sample);
  }
}
