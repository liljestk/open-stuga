import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AnalyticsQueryResponse,
  AnalyticsSampleQuality,
  MeasurementDefinition,
  MeasurementSample,
} from "@climate-twin/contracts";
import { buildAnalyticsResponse, parseAnalyticsQueryRequest } from "../src/analytics.js";
import { buildAnalyticsResponseFromRollup, planAnalyticsRollup } from "../src/analytics-rollup.js";
import { ClimateDatabase } from "../src/db.js";
import { RollupsMaterializingError } from "../src/timeseries/read-support.js";
import {
  MEASUREMENT_ANALYTICS_BUCKETS,
  buildBaseSchemaSql,
  measurementAnalyticsAggregateName,
  type MeasurementAnalyticsBaseBucket,
} from "../src/timeseries/schema.js";
import type { MeasurementAnalyticsRollupQuery } from "../src/timeseries/types.js";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

/*
 * Kernel parity harness. The API answers a bucketed analytics query either
 * from the archive rollup SQL or, when the archive cannot, by aggregating raw
 * samples through @climate-twin/analytics-kernel. The reader falls back
 * silently, so both must give the same answer. Seeded series with gaps, meter
 * restarts, repeated readings from a second source, mixed quality, irregular
 * cadence and unaligned range edges run through both paths, against an empty
 * and a materialized archive, and every number must agree within 1e-9.
 */

const DATA_FROM = Date.parse("2026-08-31T20:00:00.000Z");
const DATA_TO = Date.parse("2026-09-04T09:00:00.000Z");
const RANGE = { start: "2026-09-01T00:07:00.000Z", end: "2026-09-04T05:53:00.000Z" };
const RESOLUTIONS = ["15m", "1h", "1d"] as const;
const QUALITY_FILTERS: AnalyticsSampleQuality[][] = [["good", "estimated", "stale"], ["good", "estimated"]];
const GENERATED_AT = "2026-10-01T00:00:00.000Z";
// Before every generated day, so the archive treats the whole range as the
// still-open current day and answers from raw edges without stored states.
const OPEN_DAY_CLOCK = "TIMESTAMPTZ '2026-08-01T00:00:00Z'";

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const round = (value: number, places: number) => Number(value.toFixed(places));

interface Scenario {
  name: string;
  sensorId: string;
  metric: "temperature" | "power" | "energy";
  aggregations: string[];
  samples: MeasurementSample[];
  /** Fields that may legitimately differ for this series; see the todo below. */
  ignored?: (path: string) => boolean;
}

function series(
  random: () => number,
  input: {
    sensorId: string;
    metric: Scenario["metric"];
    unit: string;
    cadenceMs: () => number;
    gap: () => number;
    next: (at: number, previous: number | null) => number;
    /** Share of readings marked stale; filtering them out opens gaps. */
    staleShare?: number;
  },
): MeasurementSample[] {
  const samples: MeasurementSample[] = [];
  let value: number | null = null;
  for (let at = DATA_FROM; at < DATA_TO; at += input.cadenceMs()) {
    at += input.gap();
    value = input.next(at, value);
    const draw = random();
    const staleShare = input.staleShare ?? 0.04;
    const quality = draw < staleShare ? "stale" : draw < staleShare + 0.08 ? "estimated" : "good";
    const sample: MeasurementSample = {
      sensorId: input.sensorId, metric: input.metric, value, canonicalUnit: input.unit,
      timestamp: new Date(at).toISOString(), source: "api", quality,
    };
    samples.push(sample);
    // The same reading imported again through a second integration.
    if (random() < 0.03) samples.push({ ...sample, source: "tp-link" });
  }
  return samples;
}

function scenarios(sensorIds: readonly string[]): Scenario[] {
  const temperatureRandom = seeded(1);
  const steadyRandom = seeded(2);
  const gappyRandom = seeded(3);
  const energyRandom = seeded(4);
  const resetAt = new Set([0.31, 0.74].map((share) => Math.floor(DATA_FROM + share * (DATA_TO - DATA_FROM))));
  let lastEnergyAt = DATA_FROM;
  return [
    {
      name: "temperature with gaps, repeats and mixed quality",
      sensorId: sensorIds[0]!,
      metric: "temperature",
      aggregations: ["mean", "min", "max", "last"],
      samples: series(temperatureRandom, {
        sensorId: sensorIds[0]!, metric: "temperature", unit: "°C",
        cadenceMs: () => 60_000 + Math.round((temperatureRandom() - 0.5) * 20_000),
        gap: () => temperatureRandom() < 0.003 ? Math.round((5 + temperatureRandom() * 55) * 60_000) : 0,
        next: (at) => round(20 + 3 * Math.sin(at / 86_400_000 * 2 * Math.PI) + temperatureRandom() - 0.5, 2),
      }),
    },
    {
      name: "steady power",
      sensorId: sensorIds[1]!,
      metric: "power",
      aggregations: ["time_weighted_mean", "mean", "min", "max", "last"],
      samples: series(steadyRandom, {
        sensorId: sensorIds[1]!, metric: "power", unit: "W",
        cadenceMs: () => 60_000 + Math.round((steadyRandom() - 0.5) * 20_000),
        gap: () => 0,
        next: () => steadyRandom() < 0.1 ? 0 : Math.round(200 + steadyRandom() * 2_800),
        staleShare: 0,
      }),
    },
    {
      name: "power with silent gaps beyond the hold",
      sensorId: sensorIds[2]!,
      metric: "power",
      aggregations: ["time_weighted_mean"],
      samples: series(gappyRandom, {
        sensorId: sensorIds[2]!, metric: "power", unit: "W",
        cadenceMs: () => 30_000 + Math.round(gappyRandom() * 90_000),
        gap: () => gappyRandom() < 0.006 ? Math.round((5 + gappyRandom() * 115) * 60_000) : 0,
        next: () => Math.round(gappyRandom() * 3_000),
      }),
      ignored: (path) => /\.points\[\d+\]\.value$/.test(path) || /\.(?:summary|summaries\[\d+\])\.(?!count$|coverage$)/.test(path),
    },
    {
      name: "energy counter with restarts, gaps and irregular cadence",
      sensorId: sensorIds[3]!,
      metric: "energy",
      aggregations: ["delta", "min", "max", "last"],
      samples: series(energyRandom, {
        sensorId: sensorIds[3]!, metric: "energy", unit: "kWh",
        cadenceMs: () => Math.round(30_000 + energyRandom() * 270_000),
        gap: () => energyRandom() < 0.004 ? Math.round((1 + energyRandom() * 5) * 3_600_000) : 0,
        next: (at, previous) => {
          const elapsedHours = (at - lastEnergyAt) / 3_600_000;
          lastEnergyAt = at;
          const restart = [...resetAt].some((reset) => reset <= at && reset > at - elapsedHours * 3_600_000);
          if (previous === null || restart) return round(energyRandom() * 0.05, 3);
          return round(previous + elapsedHours * (0.3 + energyRandom() * 2.7), 3);
        },
      }),
    },
  ];
}

function normalised(response: AnalyticsQueryResponse): unknown {
  return JSON.parse(JSON.stringify(response, (key, value: unknown) => (
    key === "qualityFlags" && Array.isArray(value) ? [...value].sort() : value
  )));
}

function differences(left: unknown, right: unknown, ignored: (path: string) => boolean, path = "$", found: string[] = []): string[] {
  if (ignored(path)) return found;
  if (typeof left === "number" && typeof right === "number") {
    if (Math.abs(left - right) > 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))) found.push(`${path}: ${left} vs ${right}`);
  } else if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) found.push(`${path}: ${left.length} vs ${right.length} items`);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      differences(left[index], right[index], ignored, `${path}[${index}]`, found);
    }
  } else if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    for (const key of new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])) {
      differences(leftRecord[key], rightRecord[key], ignored, `${path}.${key}`, found);
    }
  } else if (left !== right) {
    found.push(`${path}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  }
  return found;
}

describe("analytics kernel parity between raw aggregation and archive rollups", () => {
  const archive = new PGlite();
  let openDayClock = false;
  const pool = new FakePool(async ({ text, values }) => {
    const sql = openDayClock ? text.replaceAll("clock_timestamp()", OPEN_DAY_CLOCK) : text;
    const result = await archive.query<Record<string, unknown>>(sql, values);
    return queryResult(result.rows, result.affectedRows);
  });
  const store = storeFor(pool);
  const local = new ClimateDatabase(":memory:");
  let cases: Scenario[] = [];
  const definitions = new Map<string, MeasurementDefinition>();

  beforeAll(async () => {
    const sensorIds = local.listSensors().map((sensor) => sensor.id).sort().slice(0, 4);
    cases = scenarios(sensorIds);
    for (const metric of ["temperature", "power", "energy"]) definitions.set(metric, local.getMeasurementDefinition(metric)!);
    local.db.exec("DELETE FROM measurement_samples");
    const insertLocal = local.db.prepare(`INSERT INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    local.db.exec("BEGIN");
    for (const sample of cases.flatMap((scenario) => scenario.samples)) {
      insertLocal.run(sample.sensorId, sample.metric, sample.value, sample.canonicalUnit, sample.timestamp, sample.source, sample.quality);
    }
    local.db.exec("COMMIT");

    await archive.exec("SET TIME ZONE 'UTC'");
    for (const sql of buildBaseSchemaSql("telemetry")) await archive.exec(sql);
    const rows = cases.flatMap((scenario) => scenario.samples);
    await archive.query(`INSERT INTO telemetry.measurement_samples
      (sensor_id, metric, observed_at, source, value, canonical_unit, quality)
      SELECT * FROM unnest($1::TEXT[], $2::TEXT[], $3::TIMESTAMPTZ[], $4::TEXT[], $5::DOUBLE PRECISION[], $6::TEXT[], $7::TEXT[])`, [
      rows.map((row) => row.sensorId), rows.map((row) => row.metric), rows.map((row) => row.timestamp),
      rows.map((row) => row.source), rows.map((row) => row.value), rows.map((row) => row.canonicalUnit),
      rows.map((row) => row.quality),
    ]);
    for (const bucket of Object.keys(MEASUREMENT_ANALYTICS_BUCKETS) as MeasurementAnalyticsBaseBucket[]) {
      await archive.exec(`CREATE TABLE telemetry.${measurementAnalyticsAggregateName(bucket)} (
        sensor_id TEXT, metric TEXT, source TEXT, quality TEXT, canonical_unit TEXT, bucket_start TIMESTAMPTZ,
        sample_count BIGINT, sum_value DOUBLE PRECISION, minimum DOUBLE PRECISION, maximum DOUBLE PRECISION,
        first_value DOUBLE PRECISION, first_at TIMESTAMPTZ, last_value DOUBLE PRECISION, last_at TIMESTAMPTZ)`);
    }
  }, 60_000);

  afterAll(async () => {
    local.close();
    await archive.close();
  });

  /** Mirrors the continuous aggregates' definition over the stored samples. */
  async function materializeContinuousAggregates(): Promise<void> {
    for (const [bucket, { interval }] of Object.entries(MEASUREMENT_ANALYTICS_BUCKETS)) {
      const name = measurementAnalyticsAggregateName(bucket as MeasurementAnalyticsBaseBucket);
      await archive.exec(`TRUNCATE telemetry.${name};
        INSERT INTO telemetry.${name}
        SELECT sensor_id, metric, source, quality, canonical_unit,
          date_bin(INTERVAL '${interval}', observed_at, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
          count(*), sum(value), min(value), max(value),
          (array_agg(value ORDER BY observed_at))[1], min(observed_at),
          (array_agg(value ORDER BY observed_at DESC))[1], max(observed_at)
        FROM telemetry.measurement_samples
        GROUP BY 1, 2, 3, 4, 5, 6`);
    }
  }

  async function archiveRollup(query: MeasurementAnalyticsRollupQuery) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await store.measurementAnalyticsRollup(query);
      } catch (error) {
        if (!(error instanceof RollupsMaterializingError)) throw error;
        while ((await store.rebuildNextMeasurementOrderedRollup({ timeoutMs: 15_000 })).processed) { /* drain */ }
      }
    }
    throw new Error("ordered rollups did not finish materializing");
  }

  const expectedComparisons = () => cases.reduce((total, scenario) => total + scenario.aggregations.length, 0)
    * RESOLUTIONS.length * QUALITY_FILTERS.length;

  async function compare(scenario: Scenario, variant: string): Promise<number> {
    const definition = definitions.get(scenario.metric)!;
    const entities = [{ id: scenario.sensorId, label: scenario.sensorId }];
    let compared = 0;
    for (const aggregation of scenario.aggregations) {
      for (const resolution of RESOLUTIONS) {
        for (const include of QUALITY_FILTERS) {
          const label = `${scenario.name} / ${variant} / ${aggregation} / ${resolution} / ${include.join("+")}`;
          const request = parseAnalyticsQueryRequest({
            apiVersion: "1.0", dataMode: "live",
            scope: { kind: "house", id: "house-main", entityIds: [scenario.sensorId] },
            measurementIds: [scenario.metric],
            range: { ...RANGE, timezone: "Europe/Helsinki" },
            resolution, aggregation, qualityFilter: { include }, requestId: label,
          }, Date.parse(GENERATED_AT));
          const window = local.measurementWindow([scenario.sensorId], [scenario.metric], RANGE.start,
            new Date(Date.parse(RANGE.end) - 1).toISOString(), 250_000);
          const boundaries = scenario.metric === "temperature" ? [] : local.measurementBoundarySamples({
            sensorId: scenario.sensorId, metric: scenario.metric, from: RANGE.start, to: RANGE.end,
            qualities: include, excludeSynthetic: true,
          });
          const fromKernel = await buildAnalyticsResponse({
            request, samples: window, consumptionBoundarySamples: boundaries, definitions: [definition],
            entities, archiveState: "merged", generatedAt: GENERATED_AT,
          });
          const plan = planAnalyticsRollup({ request, definitions: [definition], entities })!;
          const rollup = await archiveRollup({ ...plan, excludeSynthetic: true });
          const fromArchive = buildAnalyticsResponseFromRollup({
            request, definitions: [definition], entities, plan, rollup, archiveState: "merged", generatedAt: GENERATED_AT,
          });
          expect(fromKernel.series[0]!.summary.count, label).toBeGreaterThan(0);
          expect(differences(normalised(fromKernel), normalised(fromArchive), scenario.ignored ?? (() => false)).slice(0, 8), label)
            .toEqual([]);
          compared += 1;
        }
      }
    }
    return compared;
  }

  it("agrees before anything is materialized, when the archive reads raw edges only", async () => {
    openDayClock = true;
    try {
      let compared = 0;
      for (const scenario of cases) compared += await compare(scenario, "raw archive");
      expect(compared).toBe(expectedComparisons());
    } finally {
      openDayClock = false;
    }
  }, 180_000);

  it("agrees once continuous aggregates and ordered day rollups are materialized", async () => {
    await materializeContinuousAggregates();
    let compared = 0;
    for (const scenario of cases) compared += await compare(scenario, "materialized archive");
    expect(compared).toBe(expectedComparisons());
    const stored = (await archive.query<{ states: number }>(
      "SELECT count(*)::INTEGER AS states FROM telemetry.measurement_ordered_rollups",
    )).rows[0]!;
    expect(stored.states).toBeGreaterThan(0);
  }, 300_000);

  it.todo("time-weighted means clamp gaps inside stored rollup states like raw aggregation (W5 expected-cadence coverage)");
});
