import { describe, expect, it, vi } from "vitest";
import {
  buildBaseSchemaSql,
  buildContinuousAggregateSql,
  buildFallbackAggregateSql,
  validateSchemaName,
} from "../src/timeseries/schema.js";
import { FakePool, FROM, TO, queryResult, storeFor } from "./timeseries-store-test-support.js";

describe("time-series schema", () => {
  it("creates append-only raw tables with time-inclusive idempotency keys and no data expiry", () => {
    const sql = buildBaseSchemaSql("telemetry").join("\n");
    expect(sql).toContain("PRIMARY KEY (sensor_id, metric, observed_at, source)");
    expect(sql).toContain("PRIMARY KEY (sensor_id, observed_at, source)");
    expect(sql).toContain("PRIMARY KEY (house_id, location_key, observed_at, source)");
    expect(sql).toContain("PRIMARY KEY (property_id, starts_at, source)");
    expect(sql).toContain("PRIMARY KEY (observation_id, observed_at)");
    expect(sql).toContain("margin_cents_per_kwh DOUBLE PRECISION NOT NULL DEFAULT 0");
    expect(sql).toContain("PRIMARY KEY (source_id, table_name)");
    expect(sql).toContain("last_row_id BIGINT NOT NULL CHECK (last_row_id >= 0)");
    expect(sql).toContain("USING BRIN (observed_at)");
    expect(sql.toLowerCase()).not.toContain("drop_chunks");
    expect(sql.toLowerCase()).not.toContain("add_retention_policy");
    expect(sql.toLowerCase()).not.toContain("delete from");
  });

  it("reuses an existing telemetry schema without requiring database CREATE privilege", () => {
    const [schemaSql] = buildBaseSchemaSql("telemetry");
    expect(schemaSql).toContain("FROM pg_catalog.pg_namespace WHERE nspname = 'telemetry'");
    expect(schemaSql).toContain("EXECUTE format('CREATE SCHEMA %I', 'telemetry')");
    expect(schemaSql).toContain("WHEN duplicate_schema THEN NULL");
    expect(schemaSql).not.toContain("CREATE SCHEMA IF NOT EXISTS");
    expect(schemaSql).not.toContain("insufficient_privilege");
  });

  it("builds equivalent Timescale and PostgreSQL aggregate projections", () => {
    const continuous = buildContinuousAggregateSql("telemetry", "5m");
    const fallback = buildFallbackAggregateSql("telemetry", "5m");
    expect(continuous).toContain("timescaledb.continuous");
    expect(continuous).toContain("time_bucket(INTERVAL '5 minutes', observed_at)");
    expect(continuous).toContain("timescaledb.materialized_only = false");
    expect(fallback).toContain("CREATE OR REPLACE VIEW");
    expect(fallback).toContain("date_bin(INTERVAL '5 minutes', observed_at");
    for (const column of ["sample_count", "average", "minimum", "maximum", "canonical_unit"]) {
      expect(continuous).toContain(column);
      expect(fallback).toContain(column);
    }
  });

  it("rejects dynamic schema identifiers instead of interpolating them", () => {
    expect(validateSchemaName("telemetry_2")).toBe("telemetry_2");
    expect(() => validateSchemaName("telemetry; DROP SCHEMA public")).toThrow(/Invalid PostgreSQL schema/);
  });
});

describe("TimeseriesStore", () => {
  it("initializes a complete plain-PostgreSQL fallback when Timescale is unavailable", async () => {
    const pool = new FakePool();
    const store = storeFor(pool);
    const initialized = await store.initialize();

    expect(initialized).toMatchObject({
      schema: "telemetry",
      timescaleAvailable: false,
      hypertables: [],
      aggregateMode: "view",
      coldStorageMode: "none",
    });
    expect(pool.queries.some(({ text }) => text.includes("CREATE EXTENSION IF NOT EXISTS timescaledb"))).toBe(true);
    expect(pool.queries.filter(({ text }) => text.includes("CREATE OR REPLACE VIEW"))).toHaveLength(3);
    expect(pool.queries.some(({ text }) => text.includes("add_retention_policy"))).toBe(false);
    await store.close();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("can invalidate a resolved initialization so transient DDL failures are retried", async () => {
    const pool = new FakePool();
    const store = storeFor(pool);
    await store.initialize();
    const firstQueryCount = pool.queries.length;
    await store.initialize();
    expect(pool.queries).toHaveLength(firstQueryCount);

    store.invalidateInitialization();
    await store.initialize();
    expect(pool.queries.length).toBeGreaterThan(firstQueryCount);
  });

  it("enables hypertables, 2.20+ columnstore policies, and continuous aggregates when detected", async () => {
    const pool = new FakePool(({ text }) => {
      if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: "2.28.0" }]);
      if (text.includes("columnstore_available")) {
        return queryResult([{
          columnstore_available: true,
          compression_available: true,
          continuous_policy_available: true,
        }]);
      }
      if (text.includes("timescaledb_information.hypertables")) {
        return queryResult([{ configured: true }]);
      }
      return queryResult();
    });
    const store = storeFor(pool);
    const initialized = await store.initialize();

    expect(initialized).toMatchObject({
      timescaleAvailable: true,
      timescaleVersion: "2.28.0",
      hypertables: [
        "measurement_samples",
        "measurement_ordered_rollups",
        "legacy_readings",
        "outdoor_temperature_samples",
        "electricity_price_samples",
        "opening_state_samples",
        "heat_pump_state_samples",
      ],
      aggregateMode: "continuous",
      coldStorageMode: "columnstore",
      warnings: [],
    });
    expect(pool.queries.filter(({ text }) => text.includes("create_hypertable("))).toHaveLength(7);
    expect(pool.queries.filter(({ text }) => text.includes("CALL add_columnstore_policy"))).toHaveLength(14);
    expect(pool.queries.filter(({ text }) => text.includes("CREATE MATERIALIZED VIEW"))).toHaveLength(7);
    expect(pool.queries.filter(({ text }) => text.includes("SELECT add_continuous_aggregate_policy("))).toHaveLength(7);
    expect(pool.queries.some(({ text }) => text.includes("remove_continuous_aggregate_policy"))).toBe(false);
    expect(pool.queries.some(({ text }) => text.includes("proc_name = 'policy_retention'"))).toBe(true);
    expect(pool.queries.some(({ text }) => text.includes("add_retention_policy"))).toBe(false);
  });

  it("replaces only restored bounded measurement refresh policies", async () => {
    const pool = new FakePool(({ text }) => {
      if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: "2.28.3" }]);
      if (text.includes("columnstore_available")) {
        return queryResult([{
          columnstore_available: false,
          compression_available: false,
          continuous_policy_available: true,
        }]);
      }
      if (text.includes("timescaledb_information.hypertables")) {
        return queryResult([{ configured: true }]);
      }
      if (text.includes("config ->> 'start_offset'")) return queryResult([{ configured: true }]);
      return queryResult();
    });
    const store = storeFor(pool);

    await expect(store.initialize()).resolves.toMatchObject({ aggregateMode: "continuous" });
    const legacyChecks = pool.queries.filter(({ text }) => text.includes("config ->> 'start_offset'"));
    expect(legacyChecks).toHaveLength(3);
    expect(legacyChecks.map(({ values }) => values[1])).toEqual([
      "measurement_samples_5m",
      "measurement_samples_1h",
      "measurement_samples_1d",
    ]);
    const removals = pool.queries.filter(({ text }) => text.includes("remove_continuous_aggregate_policy"));
    expect(removals.map(({ values }) => values[0])).toEqual([
      "\"telemetry\".\"measurement_samples_5m\"",
      "\"telemetry\".\"measurement_samples_1h\"",
      "\"telemetry\".\"measurement_samples_1d\"",
    ]);
  });

  it("fails closed when a restored refresh policy cannot be reconciled", async () => {
    const pool = new FakePool(({ text, values }) => {
      if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: "2.28.3" }]);
      if (text.includes("columnstore_available")) {
        return queryResult([{
          columnstore_available: false,
          compression_available: false,
          continuous_policy_available: true,
        }]);
      }
      if (text.includes("timescaledb_information.hypertables")) {
        return queryResult([{ configured: true }]);
      }
      if (text.includes("config ->> 'start_offset'")) {
        return queryResult([{ configured: values[1] === "measurement_samples_5m" }]);
      }
      if (text.includes("remove_continuous_aggregate_policy")) throw new Error("policy owner mismatch");
      return queryResult();
    });
    const store = storeFor(pool);

    await expect(store.initialize()).rejects.toThrow("Only 6 of 7 required telemetry refresh policies");
  });

  it("fails closed when Timescale cannot schedule bounded aggregate refreshes", async () => {
    const pool = new FakePool(({ text }) => {
      if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: "2.28.3" }]);
      if (text.includes("columnstore_available")) {
        return queryResult([{
          columnstore_available: false,
          compression_available: false,
          continuous_policy_available: false,
        }]);
      }
      if (text.includes("timescaledb_information.hypertables")) {
        return queryResult([{ configured: true }]);
      }
      return queryResult();
    });
    const store = storeFor(pool);

    await expect(store.initialize()).rejects.toThrow(
      "Timescale continuous aggregate refresh policies are required",
    );
  });

  it("retries initialization after a transient aggregate-policy failure", async () => {
    let failPolicy = true;
    const pool = new FakePool(({ text }) => {
      if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: "2.28.3" }]);
      if (text.includes("columnstore_available")) {
        return queryResult([{
          columnstore_available: false,
          compression_available: false,
          continuous_policy_available: true,
        }]);
      }
      if (text.includes("timescaledb_information.hypertables")) {
        return queryResult([{ configured: true }]);
      }
      if (failPolicy && text.includes("SELECT add_continuous_aggregate_policy(")) {
        throw new Error("temporary policy lock");
      }
      return queryResult();
    });
    const store = storeFor(pool);

    await expect(store.initialize()).rejects.toThrow("Only 0 of 7 required telemetry refresh policies");
    failPolicy = false;
    await expect(store.initialize()).resolves.toMatchObject({ aggregateMode: "continuous" });
  });

  it("recognizes Timescale 2.28 continuous aggregates by catalog instead of relkind", async () => {
    const pool = new FakePool(({ text }) => {
      if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: "2.28.3" }]);
      if (text.includes("columnstore_available")) {
        return queryResult([{
          columnstore_available: false,
          compression_available: false,
          continuous_policy_available: true,
        }]);
      }
      if (text.includes("timescaledb_information.hypertables")) {
        return queryResult([{ configured: true }]);
      }
      if (text.includes("timescaledb_information.continuous_aggregates")) {
        return queryResult([{ configured: true }]);
      }
      // This is the real pg_class representation on Timescale 2.28. The
      // implementation must not use it to classify a continuous aggregate.
      if (text.includes("FROM pg_class c")) return queryResult([{ relkind: "v" }]);
      return queryResult();
    });
    const store = storeFor(pool);

    await expect(store.initialize()).resolves.toMatchObject({
      aggregateMode: "continuous",
      warnings: [],
    });
    expect(pool.queries.filter(({ text }) => text.includes("timescaledb_information.continuous_aggregates")))
      .toHaveLength(7);
    expect(pool.queries.some(({ text }) => text.includes("DROP VIEW"))).toBe(false);
    expect(pool.queries.some(({ text }) => text.includes("CREATE MATERIALIZED VIEW"))).toBe(false);

    await expect(store.refreshMeasurementAggregates({
      from: "2026-07-18T00:00:00.000Z",
      to: "2026-07-19T00:00:00.000Z",
    })).resolves.toBe(7);
    expect(pool.queries.filter(({ text }) => text.includes("CALL refresh_continuous_aggregate"))).toHaveLength(7);
  });

  it("writes samples in one parameterized multi-row upsert and ignores byte-identical retries", async () => {
    const pool = new FakePool(({ text }) => queryResult([], text.includes("INSERT INTO") ? 2 : 0));
    const store = storeFor(pool);
    const result = await store.upsertMeasurementSamples([
      {
        sensorId: "sensor-1",
        metric: "temperature",
        value: 20.5,
        canonicalUnit: "°C",
        timestamp: "2026-07-18T08:00:00.000Z",
        source: "home-assistant",
        quality: "good",
      },
      {
        sensorId: "sensor-1",
        metric: "humidity",
        value: 45,
        canonicalUnit: "%",
        timestamp: "2026-07-18T08:00:00.000Z",
        source: "home-assistant",
        quality: "good",
      },
    ]);

    expect(result).toEqual({ attempted: 2, affected: 2 });
    const insert = pool.queries.find(({ text }) => text.includes("INSERT INTO"))!;
    expect(insert.text).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8), ($9, $10, $11, $12, $13, $14, $15, $16)");
    expect(insert.text).toContain('ON CONFLICT ("sensor_id", "metric", "observed_at", "source") DO UPDATE');
    expect(insert.text).toContain("IS DISTINCT FROM");
    expect(insert.text).toContain("measurement_ordered_rollup_generations");
    expect(insert.text).toContain("GREATEST(dirty.current_seq, generation.current_seq)");
    expect(insert.text).toContain("day.metric = ANY($17::TEXT[])");
    expect(insert.text).toContain("dirty.day_start = day.day_start");
    expect(insert.text).not.toContain("sensor-1");
    expect(insert.values).toHaveLength(17);
    expect(insert.values.slice(0, 7)).toEqual([
      "sensor-1", "temperature", "2026-07-18T08:00:00.000Z", "home-assistant", 20.5, "°C", "good",
    ]);
    expect(insert.values[16]).toEqual([]);
  });

  it("maps timestamps consistently and bounds latest/history queries with parameters", async () => {
    const pool = new FakePool(({ text }) => {
      if (text.includes("LIMIT 1")) return queryResult([{
        sensor_id: "sensor-1",
        metric: "co2",
        value: 720,
        canonical_unit: "ppm",
        observed_at: new Date("2026-07-18T08:00:00.000Z"),
        source: "api",
        quality: "good",
        metadata: {},
      }]);
      return queryResult();
    });
    const store = storeFor(pool);
    await expect(store.latestMeasurementSample("sensor-1", "co2")).resolves.toEqual({
      sensorId: "sensor-1",
      metric: "co2",
      value: 720,
      canonicalUnit: "ppm",
      timestamp: "2026-07-18T08:00:00.000Z",
      source: "api",
      quality: "good",
      metadata: {},
    });
    const select = pool.queries.find(({ text }) => text.includes("LIMIT 1"))!;
    expect(select.values).toEqual(["sensor-1", "co2"]);
    expect(select.text).not.toContain("sensor-1");
  });

  it("finds only bounded archive gap pairs without returning the raw series", async () => {
    const pool = new FakePool(({ text }) => text.includes("LAG(observed_at)")
      ? queryResult([{
        started_at: new Date("2026-07-18T08:00:00.000Z"),
        ended_at: new Date("2026-07-18T08:30:00.000Z"),
        duration_ms: "1800000",
      }])
      : queryResult());
    const store = storeFor(pool);

    await expect(store.measurementSampleGaps({
      sensorId: "sensor-1",
      metric: "temperature",
      source: "tp-link",
      from: "2026-07-18T07:00:00.000Z",
      to: "2026-07-18T09:00:00.000Z",
      minimumGapMs: 15 * 60_000,
      limit: 25,
    })).resolves.toEqual([{
      startedAt: "2026-07-18T08:00:00.000Z",
      endedAt: "2026-07-18T08:30:00.000Z",
      durationMs: 1_800_000,
    }]);
    const select = pool.queries.find(({ text }) => text.includes("LAG(observed_at)"))!;
    expect(select.text).toContain("quality = 'good'");
    expect(select.text).toContain("> $6::DOUBLE PRECISION * INTERVAL '1 millisecond'");
    expect(select.text).toContain("LIMIT $7");
    expect(select.values).toEqual([
      "sensor-1",
      "temperature",
      "tp-link",
      "2026-07-18T07:00:00.000Z",
      "2026-07-18T09:00:00.000Z",
      15 * 60_000,
      25,
    ]);
  });

  it("reads one deterministic bounded window across sensor and metric sets", async () => {
    const pool = new FakePool(({ text }) => text.includes("sensor_id = ANY($1::TEXT[])")
      ? queryResult([
        {
          sensor_id: "sensor-1",
          metric: "humidity",
          value: 44,
          canonical_unit: "%",
          observed_at: new Date("2026-07-18T08:00:00.000Z"),
          source: "home-assistant",
          quality: "good",
          metadata: { bridge: "ha" },
        },
        {
          sensor_id: "sensor-2",
          metric: "temperature",
          value: 21.5,
          canonical_unit: "°C",
          observed_at: "2026-07-18T08:01:00.000Z",
          source: "api",
          quality: "estimated",
          metadata: {},
        },
      ])
      : queryResult());
    const store = storeFor(pool);
    const from = "2026-07-18T07:00:00.000Z";
    const to = "2026-07-18T09:00:00.000Z";

    await expect(store.measurementWindow({
      sensorIds: ["sensor-2", "sensor-1"],
      metrics: ["temperature", "humidity"],
      from,
      to,
      limit: 250_000,
      timeoutMs: 1_000,
    })).resolves.toEqual([
      {
        sensorId: "sensor-1",
        metric: "humidity",
        value: 44,
        canonicalUnit: "%",
        timestamp: "2026-07-18T08:00:00.000Z",
        source: "home-assistant",
        quality: "good",
        metadata: { bridge: "ha" },
      },
      {
        sensorId: "sensor-2",
        metric: "temperature",
        value: 21.5,
        canonicalUnit: "°C",
        timestamp: "2026-07-18T08:01:00.000Z",
        source: "api",
        quality: "estimated",
        metadata: {},
      },
    ]);

    const select = pool.queries.find(({ text }) => text.includes("sensor_id = ANY($1::TEXT[])"))!;
    expect(select.values).toEqual([
      ["sensor-2", "sensor-1"],
      ["temperature", "humidity"],
      from,
      to,
      250_000,
    ]);
    expect(select.text).toContain("metric = ANY($2::TEXT[])");
    expect(select.text).toContain("ORDER BY observed_at DESC, sensor_id DESC, metric DESC, source DESC");
    expect(select.text).toContain("ORDER BY observed_at ASC, sensor_id ASC, metric ASC, source ASC");
    expect(select.text).not.toContain("sensor-1");
  });

  it("queries quality-weighted thermal buckets from materialized history with raw edges", async () => {
    const pool = new FakePool(({ text }) => text.includes("WITH requested_metrics AS")
      ? queryResult([{
        sensor_id: "sensor-1",
        metric: "temperature",
        value: 20.25,
        canonical_unit: "C",
        observed_at: new Date("2026-07-18T08:00:00.000Z"),
        source: "api",
        quality: "good",
        metadata: {},
        coverage_complete: true,
      }])
      : queryResult());
    const store = storeFor(pool);

    await expect(store.thermalMeasurementHistory({
      sensorId: "sensor-1",
      metrics: ["temperature", "humidity", "temperature"],
      from: FROM,
      to: TO,
      bucketMinutes: 15,
      limitPerMetric: 250,
    })).resolves.toEqual([
      expect.objectContaining({
        sensorId: "sensor-1",
        metric: "temperature",
        value: 20.25,
        timestamp: "2026-07-18T08:00:00.000Z",
      }),
    ]);

    const query = pool.queries.find(({ text }) => text.includes("WITH requested_metrics AS"))!;
    expect(query.values).toEqual(["sensor-1", ["temperature", "humidity"], FROM, TO, 15, 250, "5 minutes"]);
    expect(query.text).toContain("measurement_analytics_v2_5m");
    expect(query.text).toContain("quality IN ('good', 'estimated') AND sample.source <> 'replay'");
    expect(query.text).toContain("CASE quality WHEN 'estimated' THEN 0.25 ELSE 1.0 END");
    expect(query.text).toContain("ROW_NUMBER() OVER (PARTITION BY metric ORDER BY observed_at DESC)");
  });

  it("upserts and reads immutable opening transitions with deterministic snapshots", async () => {
    const openingRow = {
      observation_id: "opening-event-1",
      house_id: "house-1",
      floor_id: "ground",
      element_id: "front-door",
      state: "open",
      open_fraction: 1,
      source: "tapo",
      observed_at: new Date("2026-07-18T08:00:00.000Z"),
      valid_until: null,
      external_id: "contact-1",
      connection_id: "tapo-main",
      recorded_at: new Date("2026-07-18T08:00:01.000Z"),
      metadata: {},
    };
    const pool = new FakePool(({ text }) => {
      if (text.includes("INSERT INTO") && text.includes("opening_state_samples")) return queryResult([], 1);
      if (text.includes("FROM \"telemetry\".\"opening_state_samples\"")) return queryResult([openingRow]);
      return queryResult();
    });
    const store = storeFor(pool);
    const record = {
      observationId: "opening-event-1",
      houseId: "house-1",
      floorId: "ground",
      elementId: "front-door",
      state: "open" as const,
      openFraction: 1,
      source: "tapo",
      observedAt: "2026-07-18T08:00:00.000Z",
      validUntil: null,
      externalId: "contact-1",
      connectionId: "tapo-main",
      recordedAt: "2026-07-18T08:00:01.000Z",
    };

    await expect(store.upsertOpeningStateSamples([record])).resolves.toEqual({ attempted: 1, affected: 1 });
    await expect(store.openingStateHistory({
      houseId: "house-1",
      from: FROM,
      to: TO,
    })).resolves.toEqual([expect.objectContaining(record)]);
    await expect(store.openingStateSnapshot({
      houseId: "house-1",
      at: TO,
    })).resolves.toEqual([expect.objectContaining(record)]);

    const insert = pool.queries.find(({ text }) => text.includes("INSERT INTO")
      && text.includes("opening_state_samples"))!;
    expect(insert.text).toContain('ON CONFLICT ("observation_id", "observed_at") DO UPDATE');
    expect(insert.values.slice(0, 12)).toEqual([
      "opening-event-1",
      "house-1",
      "ground",
      "front-door",
      "2026-07-18T08:00:00.000Z",
      "tapo",
      "open",
      1,
      null,
      "contact-1",
      "tapo-main",
      "2026-07-18T08:00:01.000Z",
    ]);
    const snapshot = pool.queries.find(({ text }) => text.includes("SELECT DISTINCT ON"))!;
    expect(snapshot.text).toContain("observed_at DESC, ingested_at DESC, observation_id DESC");
    expect(snapshot.values).toEqual(["house-1", TO, 10_000]);
  });

  it("upserts and reads complete timestamped heat-pump states", async () => {
    const record = {
      connectionId: "gree-aabbccddeeff",
      houseId: "house-1",
      equipmentId: "heat-pump-aabbccddeeff",
      deviceId: "AABBCCDDEEFF",
      name: "Nordkapp",
      brand: "Wilfa",
      model: "Nordkapp 30",
      observedAt: "2026-07-18T00:30:00.000Z",
      receivedAt: "2026-07-18T00:30:01.000Z",
      available: true,
      power: true,
      selectedMode: "cool" as const,
      targetTemperatureC: 22,
      currentTemperatureC: 25.5,
      currentTemperatureSource: "reported" as const,
      fanSpeed: "Auto",
      horizontalSwing: "Default",
      verticalSwing: "FullSwing",
      quiet: false,
      turbo: false,
      xfan: true,
      activity: "unknown" as const,
      activityEvidence: "unavailable" as const,
    };
    const row = {
      connection_id: record.connectionId,
      house_id: record.houseId,
      equipment_id: record.equipmentId,
      device_id: record.deviceId,
      name: record.name,
      brand: record.brand,
      model: record.model,
      observed_at: new Date(record.observedAt),
      received_at: new Date(record.receivedAt),
      available: record.available,
      power: record.power,
      selected_mode: record.selectedMode,
      target_temperature_c: record.targetTemperatureC,
      current_temperature_c: record.currentTemperatureC,
      current_temperature_source: record.currentTemperatureSource,
      fan_speed: record.fanSpeed,
      horizontal_swing: record.horizontalSwing,
      vertical_swing: record.verticalSwing,
      quiet: record.quiet,
      turbo: record.turbo,
      xfan: record.xfan,
      activity: record.activity,
      activity_evidence: record.activityEvidence,
    };
    const pool = new FakePool(({ text }) => {
      if (text.includes("INSERT INTO") && text.includes("heat_pump_state_samples")) {
        return queryResult([], 1);
      }
      if (text.includes("FROM \"telemetry\".\"heat_pump_state_samples\"")) {
        return queryResult([row]);
      }
      return queryResult();
    });
    const store = storeFor(pool);

    await expect(store.upsertHeatPumpStateSamples([record]))
      .resolves.toEqual({ attempted: 1, affected: 1 });
    await expect(store.heatPumpStateHistory({
      connectionId: record.connectionId,
      from: FROM,
      to: TO,
    })).resolves.toEqual([record]);

    const insert = pool.queries.find(({ text }) => text.includes("INSERT INTO")
      && text.includes("heat_pump_state_samples"))!;
    expect(insert.text).toContain('ON CONFLICT ("connection_id", "observed_at") DO UPDATE');
    expect(insert.values).toEqual([
      record.connectionId, record.houseId, record.equipmentId, record.deviceId,
      record.name, record.brand, record.model, record.observedAt, record.receivedAt,
      true, true, "cool", 22, 25.5, "reported", "Auto", "Default", "FullSwing",
      false, false, true, "unknown", "unavailable",
    ]);
  });

  it("short-circuits empty measurement window filters without acquiring a connection", async () => {
    const pool = new FakePool();
    const store = storeFor(pool);
    const common = {
      from: "2026-07-18T07:00:00.000Z",
      to: "2026-07-18T09:00:00.000Z",
    };

    await expect(store.measurementWindow({ ...common, sensorIds: [], metrics: ["temperature"] }))
      .resolves.toEqual([]);
    await expect(store.measurementWindow({ ...common, sensorIds: ["sensor-1"], metrics: [] }))
      .resolves.toEqual([]);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.queries).toEqual([]);
  });

  it("aggregates cumulative energy deltas against overlapping persisted price intervals", async () => {
    const pool = new FakePool(({ text }) => text.includes("rollup.metric = $6::TEXT")
      ? queryResult([{
        coverage_complete: true,
        delta_count: "3",
        consumption_kwh: 4.5,
        priced_consumption_kwh: 4.25,
        cost_eur: 0.91,
        total_duration_ms: 3_600_000,
        priced_duration_ms: 3_300_000,
        coverage_from: new Date(FROM),
        coverage_until: new Date(TO),
      }])
      : queryResult());
    const store = storeFor(pool);

    await expect(store.energyCostAggregate({
      sensorId: "meter-1",
      propertyId: "property-1",
      from: FROM,
      to: TO,
    })).resolves.toEqual({
      deltaCount: 3,
      consumptionKwh: 4.5,
      pricedConsumptionKwh: 4.25,
      costEur: 0.91,
      totalDurationMs: 3_600_000,
      pricedDurationMs: 3_300_000,
      maximumIntervalDurationMs: 0,
      coverageFrom: FROM,
      coverageUntil: TO,
    });
    const query = pool.queries.find(({ text }) => text.includes("rollup.metric = $6::TEXT"))!;
    expect(query.values).toEqual(["meter-1", FROM, TO, "property-1", false, "energy"]);
    expect(query.text).not.toContain("metric = 'energy'");
    expect(query.text).toContain("internal_counter_consumption");
    expect(query.text).toContain("SELECT DISTINCT ON (starts_at)");
    expect(query.text).toContain("measurement_ordered_rollups");
    expect(query.text).toContain("price_boundaries");
    expect(query.text).toContain("hour_units");
    expect(query.text).toContain("quarter_units");
    expect(query.text).toContain("minute_units");
  });

  it("honors cancellation controls for batched measurement windows", async () => {
    const pool = new FakePool();
    const store = storeFor(pool);
    const controller = new AbortController();
    controller.abort();

    await expect(store.measurementWindow({
      sensorIds: ["sensor-1"],
      metrics: ["temperature"],
      from: "2026-07-18T07:00:00.000Z",
      to: "2026-07-18T09:00:00.000Z",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("maintains a monotonic per-archive cursor for crash-safe reconciliation", async () => {
    const pool = new FakePool(({ text, values }) => {
      if (text.includes("RETURNING source_id")) return queryResult([{
        source_id: values[0],
        table_name: values[1],
        last_row_id: values[2],
        updated_at: "2026-07-18T08:01:00.000Z",
      }], 1);
      return queryResult();
    });
    const store = storeFor(pool);
    await expect(store.archiveCheckpoint("new-archive", "measurement_samples")).resolves.toBe(0);
    await expect(store.saveArchiveCheckpoint("sqlite-main", "measurement_samples", 42)).resolves.toBeUndefined();
    const update = pool.queries.find(({ text }) => text.includes("RETURNING source_id"))!;
    expect(update.text).toContain("GREATEST(checkpoint.last_row_id, EXCLUDED.last_row_id)");
    expect(update.values).toEqual(["sqlite-main", "measurement_samples", 42]);
    await expect(store.setArchiveCheckpoint("sqlite-main", "measurement_samples", -1)).rejects.toThrow(/non-negative/);
  });

  it("returns promptly on AbortSignal and issues a token-scoped backend cancellation", async () => {
    let rejectActive: ((error: Error) => void) | undefined;
    const pool = new FakePool(({ text }) => {
      if (text.includes("pg_cancel_backend")) {
        rejectActive?.(new Error("canceling statement due to user request"));
        return queryResult([{ pg_cancel_backend: true }]);
      }
      return new Promise<QueryResult<QueryResultRow>>((_resolve, reject) => {
        rejectActive = reject;
      });
    });
    const store = storeFor(pool);
    const controller = new AbortController();
    const pending = store.latestMeasurementSample("sensor-1", "temperature", { signal: controller.signal });
    await vi.waitFor(() => expect(pool.queries).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(pool.queries.some(({ text, direct }) => (
      direct && text.includes("pg_cancel_backend") && text.includes("query LIKE $2")
    ))).toBe(true));
  });
});
