import { createHash } from "node:crypto";
import type {
  DataMode,
  DurableDerivedAnalyticsKind,
  MeasurementSample,
} from "@climate-twin/contracts";
import { HOME_PERFORMANCE_ALGORITHM_VERSION } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { outdoorLocationKey } from "../../db.js";
import { addLocalDays, localDate, localDateStart } from "../../daily-analytics-findings.js";
import {
  isMoistureResponseSensor,
} from "../../moisture-response.js";
import {
  isThermalIsolationTemperatureSensor,
} from "../../thermal-isolation.js";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { getHomePerformance } from "../home-performance/service.js";
import {
  runMoistureResponseIsolated,
  runThermalIsolationIsolated,
} from "./fit-isolate.js";
import type { DerivedIdentity, DerivedResult, StoredDerivedJob } from "./types.js";

const BOUNDARY_PADDING_MS = 2 * 3_600_000;

export const DERIVED_ANALYTICS_ALGORITHM_VERSIONS = {
  "thermal-isolation": "thermal-isolation-v1.0.0",
  "moisture-response": "moisture-response-v1.0.0",
  "home-performance": HOME_PERFORMANCE_ALGORITHM_VERSION,
} as const satisfies Record<DurableDerivedAnalyticsKind, string>;

export function canonicalWindowDays(
  kind: DurableDerivedAnalyticsKind,
  value: number | undefined,
): number {
  if (kind === "home-performance") return 30;
  const selected = value ?? 7;
  if (selected !== 1 && selected !== 7 && selected !== 14) {
    throw new RangeError("windowDays must be 1, 7, or 14");
  }
  return selected;
}

export function lastCompleteDayCutoff(now: Date, timeZone = "UTC"): string {
  const start = localDateStart(localDate(now.getTime(), timeZone), timeZone);
  if (start === null) throw new Error(`Could not resolve the completed-day cutoff for ${timeZone}`);
  return new Date(start).toISOString();
}

function windowStart(cutoff: string, timeZone: string, windowDays: number): string {
  const cutoffDate = localDate(Date.parse(cutoff), timeZone);
  const start = localDateStart(addLocalDays(cutoffDate, -windowDays), timeZone);
  if (start === null) throw new Error(`Could not resolve the derived window for ${timeZone}`);
  return new Date(start).toISOString();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function derivedEvidenceVersion(
  database: ClimateDatabase,
  houseId: string,
  _kind: DurableDerivedAnalyticsKind,
): string {
  const row = database.db.prepare(`
    SELECT home.revision AS home_revision, global.revision AS global_revision
    FROM derived_analytics_evidence_revisions AS home
    CROSS JOIN derived_analytics_global_revision AS global
    WHERE home.house_id = ? AND global.id = 1
  `).get(houseId) as unknown as {
    home_revision: number;
    global_revision: number;
  } | undefined;
  if (!row) throw new Error("Home not found");
  return `evidence-v2:${row.home_revision}:${row.global_revision}`;
}

export function derivedIdentity(input: {
  database: ClimateDatabase;
  kind: DurableDerivedAnalyticsKind;
  houseId: string;
  dataMode: DataMode;
  windowDays?: number;
  now: Date;
  algorithmVersions?: Readonly<Record<DurableDerivedAnalyticsKind, string>>;
}): DerivedIdentity {
  const windowDays = canonicalWindowDays(input.kind, input.windowDays);
  const house = input.database.getHouse(input.houseId);
  if (!house) throw new Error("Home not found");
  const cutoff = lastCompleteDayCutoff(input.now, house.timezone);
  const algorithmVersion = (input.algorithmVersions ?? DERIVED_ANALYTICS_ALGORITHM_VERSIONS)[input.kind];
  const evidenceVersion = derivedEvidenceVersion(input.database, input.houseId, input.kind);
  const identityKey = digest({
    identitySchema: "derived-artifact-v1",
    kind: input.kind,
    houseId: input.houseId,
    dataMode: input.dataMode,
    windowDays,
    cutoff,
    algorithmVersion,
    evidenceVersion,
  });
  return {
    identityKey,
    kind: input.kind,
    houseId: input.houseId,
    dataMode: input.dataMode,
    windowDays,
    cutoff,
    algorithmVersion,
    evidenceVersion,
  };
}

export class DerivedAnalyticsComputer {
  readonly #database: ClimateDatabase;
  readonly #telemetryReader: HybridTelemetryReader;

  constructor(database: ClimateDatabase, telemetryReader: HybridTelemetryReader) {
    this.#database = database;
    this.#telemetryReader = telemetryReader;
  }

  async compute(job: StoredDerivedJob, signal?: AbortSignal): Promise<DerivedResult> {
    signal?.throwIfAborted();
    const house = this.#database.getHouse(job.houseId);
    if (!house) throw Object.assign(new Error("Home not found"), { code: "HOME_NOT_FOUND" });
    const sensors = this.#database.listSensors(house.id)
      .filter((sensor) => sensor.enabled)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (job.kind === "home-performance") {
      return getHomePerformance({
        house,
        sensors,
        definitions: this.#database.listMeasurementDefinitions(false),
        dataMode: job.dataMode,
        database: this.#database,
        telemetryReader: this.#telemetryReader,
        evaluatedAt: job.cutoff,
        ...(signal ? { signal } : {}),
      });
    }

    const to = job.cutoff;
    const from = windowStart(to, house.timezone, job.windowDays);
    const metrics = job.kind === "thermal-isolation"
      ? ["temperature"] as const
      : ["temperature", "humidity"] as const;
    const coverage = (await this.#telemetryReader.measurementCoverage({
      sensorIds: sensors.map((sensor) => sensor.id),
      metrics: [...metrics],
      ...(signal ? { signal } : {}),
    })).records;
    const withTemperature = new Set(coverage
      .filter((item) => item.metric === "temperature")
      .map((item) => item.sensorId));
    const withHumidity = new Set(coverage
      .filter((item) => item.metric === "humidity")
      .map((item) => item.sensorId));
    const eligible = sensors.filter((sensor) => job.kind === "thermal-isolation"
      ? isThermalIsolationTemperatureSensor(sensor, withTemperature.has(sensor.id))
      : isMoistureResponseSensor(
        sensor,
        withTemperature.has(sensor.id),
        withHumidity.has(sensor.id),
      ));
    if (eligible.length > 64) {
      throw Object.assign(new Error("Derived comparison supports at most 64 climate sensors"), {
        code: job.kind === "thermal-isolation"
          ? "THERMAL_SCOPE_TOO_LARGE"
          : "MOISTURE_SCOPE_TOO_LARGE",
      });
    }

    const outdoor = eligible.length === 0 ? [] : (await this.#telemetryReader.outdoorTemperatureHistory({
      houseId: house.id,
      locationKey: outdoorLocationKey(house.location),
      from: new Date(Date.parse(from) - BOUNDARY_PADDING_MS).toISOString(),
      to: new Date(Date.parse(to) + BOUNDARY_PADDING_MS).toISOString(),
      limit: 10_000,
      ...(signal ? { signal } : {}),
    })).records;
    const indoorSamplesBySensor = new Map<string, MeasurementSample[]>();
    // Serial archive reads intentionally trade throughput for predictable Pi
    // database and CPU use. The outer worker admits only one fit at a time.
    for (const sensor of eligible) {
      signal?.throwIfAborted();
      const read = await this.#telemetryReader.thermalMeasurementHistory({
        sensorId: sensor.id,
        metrics: [...metrics],
        from,
        to,
        bucketMinutes: 5,
        limitPerMetric: 5_000,
        ...(signal ? { signal } : {}),
      });
      indoorSamplesBySensor.set(sensor.id, read.records);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (job.kind === "thermal-isolation") {
      return runThermalIsolationIsolated({
        house,
        sensors: eligible,
        indoorSamplesBySensor,
        outdoorSamples: outdoor,
        from,
        to,
      }, signal);
    }
    return runMoistureResponseIsolated({
      house,
      sensors: eligible,
      indoorSamplesBySensor,
      outdoorSamples: outdoor,
      from,
      to,
    }, signal);
  }
}
