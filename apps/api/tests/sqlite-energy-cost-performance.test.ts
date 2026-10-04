import { describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";

const PROPERTY = "property-main";
const SENSOR = "sensor-01";
const QUARTER_HOUR = 900_000;

it("integrates a dense power stream with exact durations and changing prices", () => {
  const database = new ClimateDatabase(":memory:");
  try {
    database.db.exec("DELETE FROM measurement_samples; DELETE FROM electricity_price_points");
    const start = Date.parse("2026-01-02T00:00:00.123Z");
    const from = new Date(start).toISOString(), to = new Date(start + 12_500_000).toISOString();
    const middle = new Date(start + 6_250_000).toISOString();
    const insert = database.db.prepare(`INSERT INTO measurement_samples
      (sensor_id,metric,value,canonical_unit,timestamp,source,quality) VALUES (?, 'power',100,'W',?,'api','good')`);
    const price = database.db.prepare(`INSERT INTO electricity_price_points
      (property_id,start_at,end_at,raw_price_cents_per_kwh,margin_cents_per_kwh,fetched_at) VALUES (?,?,?,?,0,?)`);
    database.transaction(() => {
      for (let index = 0; index < 50_000; index++) insert.run(SENSOR, new Date(start + index * 250).toISOString());
      price.run(PROPERTY, from, middle, 10, from); price.run(PROPERTY, middle, to, 20, from);
    });
    const result = database.powerCostAggregate({ sensorId: SENSOR, propertyId: PROPERTY, from, to });
    expect(result.deltaCount).toBe(50_000);
    expect(result.totalDurationMs).toBe(12_500_000);
    expect(result.pricedDurationMs).toBe(12_500_000);
    expect(result.maximumIntervalDurationMs).toBe(250);
    expect(result.coverageFrom).toBe(from); expect(result.coverageUntil).toBe(to);
    expect(result.consumptionKwh).toBeCloseTo(100 * 12_500_000 / 3_600_000_000, 9);
    expect(result.pricedConsumptionKwh).toBeCloseTo(result.consumptionKwh, 9);
    expect(result.costEur).toBeCloseTo(result.consumptionKwh * 0.15, 9);
  } finally { database.close(); }
});

describe.each(["energyCostAggregate", "powerCostAggregate"] as const)("%s SQLite price lookup", (method) => {
  it("uses bounded indexed price seeks with extensive earlier prices", () => {
    const database = new ClimateDatabase(":memory:");
    try {
      const base = Date.parse("2025-01-01T00:00:00.000Z");
      const fromMs = base + 10_000 * QUARTER_HOUR;
      const from = new Date(fromMs).toISOString();
      const to = new Date(fromMs + 3_600_000).toISOString();
      const price = database.db.prepare(`INSERT INTO electricity_price_points
        (property_id, start_at, end_at, raw_price_cents_per_kwh, margin_cents_per_kwh, fetched_at)
        VALUES (?, ?, ?, 10, 0, ?)`);
      const sample = database.db.prepare(`INSERT INTO measurement_samples
        (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
        VALUES (?, ?, ?, ?, ?, 'api', 'good')`);
      database.db.exec("BEGIN");
      for (let index = 0; index < 10_004; index += 1) {
        price.run(PROPERTY, new Date(base + index * QUARTER_HOUR).toISOString(),
          new Date(base + (index + 1) * QUARTER_HOUR).toISOString(), from);
      }
      for (let index = 0; index <= 60; index += 1) {
        const timestamp = new Date(fromMs + index * 60_000).toISOString();
        sample.run(SENSOR, "energy", index / 60, "kWh", timestamp);
        sample.run(SENSOR, "power", 1_000, "W", timestamp);
      }
      database.db.exec("COMMIT");

      const prepare = database.db.prepare.bind(database.db);
      const queries: string[] = [];
      const capture = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
        queries.push(sql);
        return prepare(sql);
      });
      const result = database[method]({ sensorId: SENSOR, propertyId: PROPERTY, from, to });
      capture.mockRestore();

      expect(result.consumptionKwh).toBeCloseTo(1, 5);
      expect(result.pricedConsumptionKwh).toBeCloseTo(1, 5);
      expect(result.costEur).toBeCloseTo(0.1, 6);
      const querySql = queries.find(sql => /\b(?:FROM|JOIN) electricity_price_points AS price/.test(sql))!;
      expect(querySql).toBeDefined();
      const plan = database.db.prepare(`EXPLAIN QUERY PLAN ${querySql}`)
        .all(...Array(querySql.match(/\?/g)?.length ?? 0).fill(null))
        .map((row) => String(row.detail)).join("\n");
      expect(plan).toMatch(/SEARCH price USING (?:COVERING )?INDEX .+\(property_id=\? AND start_at>\? AND start_at<\?\)/);
      expect(plan).not.toMatch(/SCAN price\b/);
      if (method === "energyCostAggregate") {
        // The sensor-only pagination index must not make an empty energy
        // series scan all power samples before its fallback can run.
        const measurementSeeks = plan.split("\n").filter(line => /SEARCH measurement_samples/.test(line));
        expect(measurementSeeks).toHaveLength(2);
        expect(measurementSeeks.every(line => /sensor_id=\? AND metric=\?/.test(line))).toBe(true);
      }
    } finally {
      database.close();
    }
  });

  it("preserves predecessor prices, gaps, and legacy overlapping-price clipping", () => {
    const database = new ClimateDatabase(":memory:");
    try {
      const day = "2026-01-02T";
      const from = `${day}10:30:00.000Z`;
      const to = `${day}11:00:00.000Z`;
      const price = database.db.prepare(`INSERT INTO electricity_price_points
        (property_id, start_at, end_at, raw_price_cents_per_kwh, margin_cents_per_kwh, fetched_at)
        VALUES (?, ?, ?, ?, 0, ?)`);
      // Simulate prices saved before overlap validation was introduced.
      for (const [start, end, cents] of [
        ["09:00", "12:00", 999],
        ["10:00", "10:35", 10],
        ["10:40", "12:00", 20],
        ["10:55", "11:30", 30],
      ] as const) {
        price.run(PROPERTY, `${day}${start}:00.000Z`, `${day}${end}:00.000Z`, cents, from);
      }
      const sample = database.db.prepare(`INSERT INTO measurement_samples
        (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
        VALUES (?, ?, ?, ?, ?, 'api', 'good')`);
      for (let index = 0; index <= 6; index += 1) {
        const timestamp = new Date(Date.parse(from) + index * 300_000).toISOString();
        sample.run(SENSOR, "energy", index / 12, "kWh", timestamp);
        sample.run(SENSOR, "power", 1_000, "W", timestamp);
      }
      const result = database[method]({ sensorId: SENSOR, propertyId: PROPERTY, from, to });
      expect(result.consumptionKwh).toBeCloseTo(0.5, 5);
      expect(result.pricedConsumptionKwh).toBeCloseTo(25 / 60, 5);
      expect(result.costEur).toBeCloseTo(1 / 12, 5);
      expect(result.pricedDurationMs).toBeCloseTo(25 * 60_000, 0);
    } finally {
      database.close();
    }
  });

  it("finds a later first price without pricing an earlier gap or a future interval", () => {
    const database = new ClimateDatabase(":memory:");
    try {
      const from = "2026-01-02T10:00:00.000Z";
      const to = "2026-01-02T11:00:00.000Z";
      database.storePropertyElectricityPrices(PROPERTY, [
        { startAt: "2026-01-02T10:20:00.000Z", endAt: "2026-01-02T10:40:00.000Z", rawPriceCentsPerKwh: 12 },
        { startAt: "2026-01-02T12:00:00.000Z", endAt: "2026-01-02T13:00:00.000Z", rawPriceCentsPerKwh: 999 },
      ], from);
      const sample = database.db.prepare(`INSERT INTO measurement_samples
        (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
        VALUES (?, ?, ?, ?, ?, 'api', 'good')`);
      for (let index = 0; index <= 6; index += 1) {
        const timestamp = new Date(Date.parse(from) + index * 600_000).toISOString();
        sample.run(SENSOR, "energy", index / 6, "kWh", timestamp);
        sample.run(SENSOR, "power", 1_000, "W", timestamp);
      }
      const result = database[method]({ sensorId: SENSOR, propertyId: PROPERTY, from, to });
      expect(result.consumptionKwh).toBeCloseTo(1, 5);
      expect(result.pricedConsumptionKwh).toBeCloseTo(1 / 3, 5);
      expect(result.costEur).toBeCloseTo(0.04, 5);
    } finally {
      database.close();
    }
  });
});
