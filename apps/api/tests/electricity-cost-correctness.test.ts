import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { ClimateDatabase } from "../src/db.js";
import { EnergyCostService } from "../src/energy-cost.js";
import { parseElectricityPricePayload } from "../src/electricity-prices.js";
import { loadConfig } from "../src/config.js";
import type { HybridTelemetryReader } from "../src/timeseries/read-facade.js";
import { RollupsMaterializingError } from "../src/timeseries/read-support.js";

const FROM = "2026-07-17T00:00:00.000Z";
const TO = "2026-07-17T01:00:00.000Z";

describe("electricity cost correctness", () => {
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("rejects overlapping price intervals before they can double-price consumption", () => {
    const prices = [
      { price: 10, startDate: FROM, endDate: "2026-07-17T00:45:00.000Z" },
      { price: 20, startDate: "2026-07-17T00:30:00.000Z", endDate: TO },
    ];
    expect(() => parseElectricityPricePayload({ prices })).toThrow(/overlap/i);

    const database = new ClimateDatabase(":memory:");
    try {
      expect(() => database.storePropertyElectricityPrices(
        "property-main",
        prices.map((price) => ({
          startAt: price.startDate,
          endAt: price.endDate,
          rawPriceCentsPerKwh: price.price,
        })),
        "2026-07-16T12:00:00.000Z",
      )).toThrow(/overlap/i);
      expect(database.listPropertyElectricityPrices("property-main", FROM, TO)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("migrates existing sensors to the independent meter role", () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-energy-role-"));
    const path = join(directory, "climate.db");
    try {
      new ClimateDatabase(path).close();
      const legacy = new DatabaseSync(path);
      legacy.exec("ALTER TABLE sensors DROP COLUMN energy_meter_role");
      legacy.close();

      const migrated = new ClimateDatabase(path);
      try {
        expect(migrated.getSensor("sensor-01")?.energyMeterRole).toBe("standalone");
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses a whole-Home meter without adding its submeter again", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      startBackground: false,
    });
    const wholeHome = runtime.database.updateSensor("sensor-01", {
      energyMeterRole: "whole_home",
    })!;
    const submeter = runtime.database.createSensor({
      ...wholeHome,
      id: "submeter-01",
      name: "Water heater submeter",
      energyMeterRole: "submeter",
    });
    runtime.database.storePropertyElectricityPrices("property-main", [{
      startAt: FROM,
      endAt: TO,
      rawPriceCentsPerKwh: 10,
    }], "2026-07-16T12:00:00.000Z");
    runtime.measurements.ingestBatch([
      { sensorId: wholeHome.id, metric: "energy", value: 10, canonicalUnit: "kWh", timestamp: FROM, source: "api", quality: "good" },
      { sensorId: wholeHome.id, metric: "energy", value: 12, canonicalUnit: "kWh", timestamp: TO, source: "api", quality: "good" },
      { sensorId: submeter.id, metric: "energy", value: 4, canonicalUnit: "kWh", timestamp: FROM, source: "api", quality: "good" },
      { sensorId: submeter.id, metric: "energy", value: 5, canonicalUnit: "kWh", timestamp: TO, source: "api", quality: "good" },
    ]);

    const result = await request(runtime.app).get("/api/v1/houses/house-main/energy-summary")
      .query({ from: FROM, to: TO })
      .expect(200);

    expect(result.body.summary).toMatchObject({
      aggregationMode: "whole_home",
      consumptionKwh: 2,
      pricedConsumptionKwh: 2,
      costEur: 0.2,
      sourceCount: 1,
      totalSources: 2,
      excludedSourceCount: 1,
      complete: true,
    });
    expect(result.body.summary.contributions).toEqual([
      expect.objectContaining({ sensorId: wholeHome.id }),
    ]);
  });

  it("marks a local calculation partial while its time-database archive is pending", async () => {
    const aggregate = {
      deltaCount: 4,
      consumptionKwh: 1,
      pricedConsumptionKwh: 1,
      costEur: 0.1,
      totalDurationMs: 3_600_000,
      pricedDurationMs: 3_600_000,
      maximumIntervalDurationMs: 900_000,
      coverageFrom: FROM,
      coverageUntil: TO,
      archiveState: "pending" as const,
    };
    const reader = {
      energyCostAggregate: vi.fn(async () => aggregate),
      powerCostAggregate: vi.fn(async () => aggregate),
    } as unknown as HybridTelemetryReader;
    const service = new EnergyCostService(reader);

    await expect(service.calculate({
      houseId: "house-main",
      propertyId: "property-main",
      sensorId: "meter",
      from: FROM,
      to: TO,
    })).resolves.toMatchObject({
      costEur: 0.1,
      archiveState: "pending",
      quality: "partial",
      complete: false,
    });
  });

  it("keeps every source in a combined summary while archive confirmation is pending", async () => {
    const emptyAggregate = {
      deltaCount: 0,
      consumptionKwh: 0,
      pricedConsumptionKwh: 0,
      costEur: 0,
      totalDurationMs: 0,
      pricedDurationMs: 0,
      maximumIntervalDurationMs: 0,
      coverageFrom: null,
      coverageUntil: null,
      archiveState: "pending" as const,
    };
    const pricedAggregate = {
      deltaCount: 4,
      consumptionKwh: 1,
      pricedConsumptionKwh: 1,
      costEur: 0.1,
      totalDurationMs: 3_600_000,
      pricedDurationMs: 3_600_000,
      maximumIntervalDurationMs: 900_000,
      coverageFrom: FROM,
      coverageUntil: TO,
      archiveState: "pending" as const,
    };
    const reader = {
      measurementCoverage: vi.fn(async () => ({
        archiveState: "merged",
        complete: true,
        records: ["meter-a", "meter-b"].map((sensorId) => ({
          sensorId,
          metric: "power",
          start: FROM,
          end: TO,
        })),
      })),
      energyCostAggregate: vi.fn(async () => emptyAggregate),
      powerCostAggregate: vi.fn(async () => pricedAggregate),
    } as unknown as HybridTelemetryReader;
    const service = new EnergyCostService(reader);

    await expect(service.summarize({
      houseId: "house-main",
      propertyId: "property-main",
      sensorIds: ["meter-a", "meter-b"],
      from: FROM,
      to: TO,
    })).resolves.toMatchObject({
      consumptionKwh: 2,
      pricedConsumptionKwh: 2,
      costEur: 0.2,
      priceCoveragePercent: 100,
      archiveState: "pending",
      sourceCount: 2,
      totalSources: 2,
      failedSourceCount: 0,
      complete: false,
    });
  });

  it("keeps serving the power basis while energy-counter rollups are still materializing", async () => {
    const reader = {
      energyCostAggregate: vi.fn(async () => {
        throw new RollupsMaterializingError();
      }),
      powerCostAggregate: vi.fn(async () => ({
        deltaCount: 4,
        consumptionKwh: 1,
        pricedConsumptionKwh: 1,
        costEur: 0.1,
        totalDurationMs: 3_600_000,
        pricedDurationMs: 3_600_000,
        maximumIntervalDurationMs: 900_000,
        coverageFrom: FROM,
        coverageUntil: TO,
        archiveState: "archived" as const,
      })),
    } as unknown as HybridTelemetryReader;
    const service = new EnergyCostService(reader);

    await expect(service.calculate({
      houseId: "house-main",
      propertyId: "property-main",
      sensorId: "meter",
      from: FROM,
      to: TO,
    })).resolves.toMatchObject({
      measurementBasis: "integrated_power",
      consumptionKwh: 1,
      costEur: 0.1,
    });
  });

  it("propagates the materializing state only when no basis can answer", async () => {
    const reader = {
      energyCostAggregate: vi.fn(async () => {
        throw new RollupsMaterializingError();
      }),
      powerCostAggregate: vi.fn(async () => {
        throw new RollupsMaterializingError();
      }),
    } as unknown as HybridTelemetryReader;
    const service = new EnergyCostService(reader);

    await expect(service.calculate({
      houseId: "house-main",
      propertyId: "property-main",
      sensorId: "meter",
      from: FROM,
      to: TO,
    })).rejects.toBeInstanceOf(RollupsMaterializingError);
    expect(reader.powerCostAggregate).toHaveBeenCalledOnce();
  });

  it("keeps an entirely preparing summary retryable instead of returning a failed empty result", async () => {
    const preparing = new RollupsMaterializingError();
    const reader = {
      measurementCoverage: vi.fn(async () => ({
        archiveState: "merged",
        complete: true,
        records: ["meter-a", "meter-b"].map((sensorId) => ({
          sensorId, metric: "energy", start: FROM, end: TO,
        })),
      })),
      energyCostAggregate: vi.fn(async () => { throw preparing; }),
      powerCostAggregate: vi.fn(async () => { throw preparing; }),
    } as unknown as HybridTelemetryReader;

    await expect(new EnergyCostService(reader).summarize({
      houseId: "house-main", propertyId: "property-main",
      sensorIds: ["meter-a", "meter-b"], from: FROM, to: TO,
    })).rejects.toBe(preparing);
    expect(reader.energyCostAggregate).toHaveBeenCalledTimes(2);
    expect(reader.powerCostAggregate).toHaveBeenCalledTimes(2);
  });

  it("degrades a combined summary per source while one source's rollups materialize", async () => {
    const pricedAggregate = {
      deltaCount: 4,
      consumptionKwh: 1,
      pricedConsumptionKwh: 1,
      costEur: 0.1,
      totalDurationMs: 3_600_000,
      pricedDurationMs: 3_600_000,
      maximumIntervalDurationMs: 900_000,
      coverageFrom: FROM,
      coverageUntil: TO,
      archiveState: "archived" as const,
    };
    const reader = {
      measurementCoverage: vi.fn(async () => ({
        archiveState: "merged",
        complete: true,
        records: ["meter-a", "meter-b"].map((sensorId) => ({
          sensorId,
          metric: "energy",
          start: FROM,
          end: TO,
        })),
      })),
      energyCostAggregate: vi.fn(async ({ sensorId }: { sensorId: string }) => {
        if (sensorId === "meter-a") throw new RollupsMaterializingError();
        return pricedAggregate;
      }),
      powerCostAggregate: vi.fn(async ({ sensorId }: { sensorId: string }) => {
        if (sensorId === "meter-a") throw new RollupsMaterializingError();
        return { ...pricedAggregate, deltaCount: 0, consumptionKwh: 0, pricedConsumptionKwh: 0, costEur: 0, totalDurationMs: 0, pricedDurationMs: 0 };
      }),
    } as unknown as HybridTelemetryReader;
    const service = new EnergyCostService(reader);

    await expect(service.summarize({
      houseId: "house-main",
      propertyId: "property-main",
      sensorIds: ["meter-a", "meter-b"],
      from: FROM,
      to: TO,
    })).resolves.toMatchObject({
      consumptionKwh: 1,
      costEur: 0.1,
      sourceCount: 1,
      totalSources: 2,
      failedSourceCount: 1,
      complete: false,
    });
  });

  it("uses matching historical prices for the optimizer daily cost", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      startBackground: false,
    });
    const dayFrom = "2026-07-16T01:00:00.000Z";
    const futureTo = "2026-07-17T02:00:00.000Z";
    runtime.database.storePropertyElectricityPrices("property-main", [
      { startAt: dayFrom, endAt: TO, rawPriceCentsPerKwh: 10 },
      { startAt: TO, endAt: futureTo, rawPriceCentsPerKwh: 100 },
    ], "2026-07-16T00:00:00.000Z");
    runtime.measurements.ingestBatch([
      { sensorId: "sensor-01", metric: "energy", value: 5, canonicalUnit: "kWh", timestamp: dayFrom, source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "energy", value: 6, canonicalUnit: "kWh", timestamp: TO, source: "api", quality: "good" },
    ]);

    const report = await runtime.energyOptimizer.report(
      "property-main",
      1,
      new Date(TO),
    );

    expect(report.recentDailyConsumptionKwh).toBe(1);
    expect(report.estimatedDailyCostEur).toBe(0.1);
    expect(report.averagePriceCentsPerKwh).toBe(100);
  });
});
