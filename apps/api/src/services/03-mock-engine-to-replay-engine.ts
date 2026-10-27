import type {
  MockScenario,
  Reading,
  Sensor,
} from "@climate-twin/contracts";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { type AppConfig } from "../config.js";
import { ClimateDatabase } from "../db.js";
import { TelemetryBus } from "../events.js";
import { demoDataWasDisabled } from "./01-weather-connection-status-to-demo-data-was-disabled.js";
import { DataModeCoordinator, MOCK_SCENARIOS, TelemetryService, samplesFromReading } from "./02-data-mode-coordinator-to-mock-scenarios.js";

export class MockEngine {
  #timer: NodeJS.Timeout | null = null;
  #tick = 0;
  #scenario: MockScenario["id"] = "normal";

  constructor(
    private readonly database: ClimateDatabase,
    private readonly telemetry: TelemetryService,
    private readonly config: AppConfig,
    private readonly dataMode: DataModeCoordinator,
  ) {
    const persisted = this.database.mockScenarioId();
    if (MOCK_SCENARIOS.some((scenario) => scenario.id === persisted)) {
      this.#scenario = persisted as MockScenario["id"];
    }
  }

  get scenario(): MockScenario["id"] {
    const persisted = this.database.mockScenarioId();
    return MOCK_SCENARIOS.some((scenario) => scenario.id === persisted)
      ? persisted as MockScenario["id"]
      : this.#scenario;
  }

  setScenario(scenario: MockScenario["id"]): void {
    this.dataMode.prepareSources(["mock"]);
    this.database.setMockScenarioId(scenario);
    this.#scenario = scenario;
    this.#tick = 0;
  }

  start(): void {
    if (this.#timer || !this.config.mockEnabled || this.dataMode.isRealMode) return;
    this.#timer = setInterval(() => {
      if (this.dataMode.synchronize()) {
        this.stop();
        return;
      }
      try {
        this.generate();
      } catch (error) {
        // A second process can latch the shared database after the coordinator
        // check but before the insert. Both service errors and SQLite trigger
        // aborts are expected shutdown signals for this timer.
        if (demoDataWasDisabled(error)) {
          this.dataMode.synchronize();
          this.stop();
          return;
        }
        throw error;
      }
    }, this.config.mockIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  generate(): Reading[] {
    this.dataMode.prepareSources(["mock"]);
    this.#tick += 1;
    const now = new Date().toISOString();
    const generated: Reading[] = [];
    const sharedHouseIds = new Set(this.database.listHouses()
      .filter((house) => !hasLocalHouseAuthority(house))
      .map((house) => house.id));
    const sensors = this.database.listSensors()
      .filter((sensor) => sensor.enabled && !sharedHouseIds.has(sensor.houseId));
    const scenario = this.scenario;
    for (let index = 0; index < sensors.length; index += 1) {
      const sensor = sensors[index] as Sensor;
      const last = this.database.getLatestReading(sensor.id);
      const lastCo2 = this.database.getLatestMeasurementSample(sensor.id, "co2")?.value ?? 650 + (index % 4) * 35;
      let temperature = last?.temperature ?? 20.5;
      let humidity = last?.humidity ?? 44;
      let co2 = lastCo2 + Math.sin(this.#tick / 11 + index * 0.8) * 3;
      const wave = Math.sin(this.#tick / 15 + index * 0.7);
      temperature += wave * 0.025;
      humidity += Math.cos(this.#tick / 13 + index) * 0.08;
      if (scenario === "shower") {
        const distance = Math.hypot(sensor.x - 10.5, sensor.y - 7.5) + (sensor.floorId === "floor-upper" ? 0 : 8);
        humidity += Math.max(0, 2.2 - distance * 0.16);
        temperature += Math.max(0, 0.08 - distance * 0.006);
        co2 += Math.max(0, 18 - distance * 1.2);
      } else if (scenario === "leak") {
        const distance = Math.hypot(sensor.x - 11, sensor.y - 7.5) + (sensor.floorId === "floor-ground" ? 0 : 7);
        humidity += Math.max(0, 1.35 - distance * 0.11);
      } else if (scenario === "cold-front") {
        const front = (this.#tick / 4) % 18;
        temperature -= Math.max(0, 0.32 - Math.abs(sensor.x - front) * 0.055);
      } else if (scenario === "heating-failure") {
        temperature -= 0.075 + (sensor.floorId === "floor-ground" ? 0.015 : 0);
      }
      // A gentle occupied-room cycle keeps mock CO2 realistic without coupling it to climate samples.
      co2 += Math.max(0, Math.sin(this.#tick / 40 + index * 0.4)) * 2.5;
      const reading: Reading = {
        sensorId: sensor.id,
        timestamp: now,
        temperature: Number(Math.max(-30, Math.min(60, temperature)).toFixed(2)),
        humidity: Number(Math.max(0, Math.min(100, humidity)).toFixed(2)),
        battery: last?.battery ?? 95,
        source: "mock",
        quality: "good",
        measurements: { co2: Number(Math.max(350, Math.min(5_000, co2)).toFixed(0)) },
      };
      generated.push(reading);
    }
    return this.telemetry.ingestBatch(generated);
  }
}

export interface ReplayState {
  active: boolean;
  count: number;
  emitted: number;
  speed: number;
  from: string | null;
  to: string | null;
}

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
