import type { Reading, ReplayState } from "@climate-twin/contracts";
import { ClimateDatabase } from "../db.js";
import { TelemetryBus } from "../events.js";
import { samplesFromReading } from "../telemetry/ingest.js";

export class ReplayEngine {
  #timer: NodeJS.Timeout | null = null;
  #readings: Reading[] = [];
  #index = 0;
  #speed = 60;
  #from: string | null = null;
  #to: string | null = null;

  constructor(private readonly database: ClimateDatabase, private readonly bus: TelemetryBus) {}

  get state(): ReplayState {
    return { active: this.#timer !== null, count: this.#readings.length, emitted: this.#index, speed: this.#speed, from: this.#from, to: this.#to };
  }

  start(sensorIds: string[], from: string, to: string, speed = 60): ReplayState {
    return this.startReadings(this.database.history(sensorIds, from, to, 50_000), from, to, speed);
  }

  startReadings(readings: readonly Reading[], from: string, to: string, speed = 60): ReplayState {
    this.stop();
    this.#readings = readings.slice(-50_000);
    this.#index = 0;
    this.#speed = Math.max(0.1, Math.min(speed, 10_000));
    this.#from = from;
    this.#to = to;
    if (this.#readings.length > 0) this.schedule(0);
    return this.state;
  }

  stop(): ReplayState {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    return this.state;
  }

  reset(): ReplayState {
    this.stop();
    this.#readings = [];
    this.#index = 0;
    this.#from = null;
    this.#to = null;
    return this.state;
  }

  private schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      const current = this.#readings[this.#index];
      if (!current) {
        this.#timer = null;
        return;
      }
      const replayReading: Reading = { ...current, source: "replay" };
      this.bus.publish({ type: "reading", data: replayReading });
      for (const sample of samplesFromReading(this.database, replayReading)) {
        this.bus.publishMeasurement(sample);
      }
      this.#index += 1;
      const next = this.#readings[this.#index];
      if (!next) {
        this.#timer = null;
        return;
      }
      const sourceDelay = Math.max(0, Date.parse(next.timestamp) - Date.parse(current.timestamp));
      this.schedule(Math.max(5, Math.min(5_000, sourceDelay / this.#speed)));
    }, delay);
    this.#timer.unref();
  }
}
