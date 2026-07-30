import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  ElectricityPriceService,
  MAX_ELECTRICITY_RESPONSE_BYTES,
  parseElectricityPricePayload,
  validateElectricityEndpointUrl,
} from "../src/electricity-prices.js";
import { ClimateDatabase } from "../src/db.js";
import { HybridTelemetryReader } from "../src/timeseries/read-facade.js";

const PUBLIC_RESOLVER = async (): Promise<string[]> => ["93.184.216.34"];

describe("electricity price archival", () => {
  it("wakes durable archival immediately after storing fetched intervals", async () => {
    const database = new ClimateDatabase(":memory:");
    const archivedProperties: string[] = [];
    try {
      const service = new ElectricityPriceService(
        database,
        async () => new Response(JSON.stringify({ prices: [{
          price: 5.25,
          startDate: "2026-07-17T09:00:00.000Z",
          endDate: "2026-07-17T09:15:00.000Z",
        }] }), { status: 200 }),
        12 * 60 * 60_000,
        { resolver: PUBLIC_RESOLVER },
        (propertyId) => { archivedProperties.push(propertyId); },
      );

      await service.refresh("property-main");

      expect(archivedProperties).toEqual(["property-main"]);
      expect(database.electricityPriceArchivePage(0, 10)).toEqual([
        expect.objectContaining({
          record: expect.objectContaining({
            propertyId: "property-main",
            rawPriceCentsPerKwh: 5.25,
          }),
        }),
      ]);
    } finally {
      database.close();
    }
  });
});

describe("property electricity prices", () => {
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("validates the compatible API response without changing raw cents/kWh", () => {
    expect(parseElectricityPricePayload({ prices: [{
      price: -0.002,
      startDate: "2026-07-17T09:00:00.000Z",
      endDate: "2026-07-17T09:14:59.999Z",
    }] })).toEqual([{
      rawPriceCentsPerKwh: -0.002,
      startAt: "2026-07-17T09:00:00.000Z",
      endAt: "2026-07-17T09:14:59.999Z",
    }]);
    expect(() => parseElectricityPricePayload({ prices: [{ price: "1.2" }] })).toThrow(/Invalid/);
  });

  it("defaults every property to Pörssisähkö and derives a property-specific margin", async () => {
    const now = Date.now();
    const fetcher: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ prices: [{
        price: 5.25,
        startDate: new Date(now - 60_000).toISOString(),
        endDate: new Date(now + 15 * 60_000).toISOString(),
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      electricityPriceFetcher: fetcher,
      electricityEndpointResolver: PUBLIC_RESOLVER,
      startBackground: false,
    });

    const initial = await request(runtime.app).get("/api/v1/properties/property-main/electricity").expect(200);
    expect(initial.body.config).toMatchObject({
      propertyId: "property-main",
      provider: "porssisahko",
      endpointUrl: DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
      marginCentsPerKwh: 0,
    });

    await request(runtime.app).put("/api/v1/properties/property-main/electricity/config").send({
      provider: "porssisahko",
      endpointUrl: DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
      enabled: true,
      marginCentsPerKwh: 0.45,
      contractType: "spot",
      contractName: "Quarter-hour spot",
      retailer: "Example Energy",
      monthlyFeeEur: 4.99,
    }).expect(200);
    const refreshed = await request(runtime.app).post("/api/v1/properties/property-main/electricity/refresh").expect(200);
    expect(refreshed.body.current).toMatchObject({
      rawPriceCentsPerKwh: 5.25,
      effectivePriceCentsPerKwh: 5.7,
      effectivePriceEurPerKwh: 0.057,
    });
    expect(refreshed.body.config).toMatchObject({ retailer: "Example Energy", monthlyFeeEur: 4.99 });
  });

  it("keeps source configuration and raw data isolated between properties", async () => {
    const endpoints: string[] = [];
    const now = Date.now();
    const fetcher: typeof fetch = async (input) => {
      endpoints.push(String(input));
      const price = String(input).includes("second.example") ? 9 : 2;
      return new Response(JSON.stringify({ prices: [{
        price,
        startDate: new Date(now - 60_000).toISOString(),
        endDate: new Date(now + 15 * 60_000).toISOString(),
      }] }), { status: 200 });
    };
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      electricityPriceFetcher: fetcher,
      electricityEndpointResolver: PUBLIC_RESOLVER,
      startBackground: false,
    });
    const created = await request(runtime.app).post("/api/v1/properties").send({ name: "Second property" }).expect(201);
    const secondId = created.body.property.id as string;
    await request(runtime.app).put(`/api/v1/properties/${secondId}/electricity/config`).send({
      provider: "custom", endpointUrl: "https://second.example/prices.json", enabled: true,
      marginCentsPerKwh: 1, contractType: "spot", contractName: null, retailer: null, monthlyFeeEur: null,
    }).expect(200);
    await request(runtime.app).post("/api/v1/properties/property-main/electricity/refresh").expect(200);
    await request(runtime.app).post(`/api/v1/properties/${secondId}/electricity/refresh`).expect(200);
    expect(runtime.database.getCurrentPropertyElectricityPrice("property-main")?.rawPriceCentsPerKwh).toBe(2);
    expect(runtime.database.getCurrentPropertyElectricityPrice(secondId)).toMatchObject({
      rawPriceCentsPerKwh: 9, effectivePriceCentsPerKwh: 10,
    });
    expect(endpoints).toEqual([DEFAULT_ELECTRICITY_PRICE_ENDPOINT, "https://second.example/prices.json"]);
  });

  it("serves long-range Property and Home price history from the Timescale archive", async () => {
    const database = new ClimateDatabase(":memory:");
    const startAt = "2025-01-01T00:00:00.000Z";
    const endAt = "2025-01-01T00:15:00.000Z";
    const telemetryReader = new HybridTelemetryReader({
      local: database,
      archive: {
        measurementHistory: async () => [],
        legacyReadingHistory: async () => [],
        outdoorTemperatureHistory: async () => [],
        electricityPriceHistory: async () => [{
          propertyId: "property-main",
          startAt,
          endAt,
          rawPriceCentsPerKwh: 8,
          marginCentsPerKwh: 0.5,
          source: "sqlite",
          fetchedAt: "2024-12-31T12:00:00.000Z",
        }],
      },
      archivePhase: () => "ready",
    });
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      database,
      telemetryReader,
      startBackground: false,
    });

    const property = await request(runtime.app).get("/api/v1/properties/property-main/electricity")
      .query({ from: startAt, to: endAt })
      .expect(200);
    expect(property.body.prices).toEqual([
      expect.objectContaining({
        propertyId: "property-main",
        rawPriceCentsPerKwh: 8,
        effectivePriceCentsPerKwh: 8.5,
        effectivePriceEurPerKwh: 0.085,
      }),
    ]);

    const home = await request(runtime.app).get("/api/v1/houses/house-main/electricity-price")
      .query({ from: startAt, to: endAt })
      .expect(200);
    expect(home.body.prices).toEqual([
      expect.objectContaining({
        startAt,
        effectivePriceCentsPerKwh: 8.5,
        effectivePriceEurPerKwh: 0.085,
      }),
    ]);
    expect(home.body.prices[0]).not.toHaveProperty("rawPriceCentsPerKwh");
  });

  it("calculates cumulative cost from time-aligned meter deltas and persisted interval prices", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      startBackground: false,
    });
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/config").send({
      provider: "porssisahko", endpointUrl: DEFAULT_ELECTRICITY_PRICE_ENDPOINT, enabled: true,
      marginCentsPerKwh: 1, contractType: "spot", contractName: null, retailer: null, monthlyFeeEur: null,
    }).expect(200);
    runtime.database.storePropertyElectricityPrices("property-main", [
      { startAt: "2026-07-17T00:00:00.000Z", endAt: "2026-07-17T00:30:00.000Z", rawPriceCentsPerKwh: 10 },
      { startAt: "2026-07-17T00:30:00.000Z", endAt: "2026-07-17T01:00:00.000Z", rawPriceCentsPerKwh: 20 },
    ], "2026-07-16T12:00:00.000Z");
    runtime.measurements.ingestBatch([
      { sensorId: "sensor-01", metric: "energy", value: 10, canonicalUnit: "kWh", timestamp: "2026-07-17T00:00:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "energy", value: 11, canonicalUnit: "kWh", timestamp: "2026-07-17T00:30:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "energy", value: 13, canonicalUnit: "kWh", timestamp: "2026-07-17T01:00:00.000Z", source: "api", quality: "good" },
    ]);

    const result = await request(runtime.app).get("/api/v1/houses/house-main/energy-cost").query({
      sensorId: "sensor-01",
      from: "2026-07-17T00:00:00.000Z",
      to: "2026-07-17T01:00:00.000Z",
    }).expect(200);

    expect(result.body.cost).toMatchObject({
      houseId: "house-main",
      sensorId: "sensor-01",
      measurementBasis: "energy_counter",
      consumptionKwh: 3,
      pricedConsumptionKwh: 3,
      costEur: 0.53,
      priceCoveragePercent: 100,
      complete: true,
    });
    expect(runtime.database.electricityPriceArchivePage(0, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ record: expect.objectContaining({ marginCentsPerKwh: 1 }) }),
    ]));

    await request(runtime.app).put("/api/v1/properties/property-main/electricity/config").send({
      provider: "porssisahko", endpointUrl: DEFAULT_ELECTRICITY_PRICE_ENDPOINT, enabled: true,
      marginCentsPerKwh: 5, contractType: "spot", contractName: null, retailer: null, monthlyFeeEur: null,
    }).expect(200);
    expect(runtime.database.listPropertyElectricityPrices(
      "property-main", "2026-07-17T00:00:00.000Z", "2026-07-17T01:00:00.000Z",
    ).map((price) => price.effectivePriceCentsPerKwh)).toEqual([11, 21]);
  });

  it("keeps sparse cumulative counters complete within the five-minute edge tolerance", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      startBackground: false,
    });
    runtime.database.storePropertyElectricityPrices("property-main", [{
      startAt: "2026-07-17T00:00:00.000Z",
      endAt: "2026-07-17T01:00:00.000Z",
      rawPriceCentsPerKwh: 10,
    }], "2026-07-16T12:00:00.000Z");
    runtime.measurements.ingestBatch([
      { sensorId: "sensor-01", metric: "energy", value: 10, canonicalUnit: "kWh", timestamp: "2026-07-17T00:04:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "energy", value: 11, canonicalUnit: "kWh", timestamp: "2026-07-17T01:00:00.000Z", source: "api", quality: "good" },
    ]);

    const result = await request(runtime.app).get("/api/v1/houses/house-main/energy-cost").query({
      sensorId: "sensor-01",
      from: "2026-07-17T00:00:00.000Z",
      to: "2026-07-17T01:00:00.000Z",
    }).expect(200);

    expect(result.body.cost).toMatchObject({
      measurementBasis: "energy_counter",
      consumptionKwh: 1,
      complete: true,
      measurementCoverageFrom: "2026-07-17T00:04:00.000Z",
    });
  });

  it("aggregates power-only sensors into one Home consumption and cost summary", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      startBackground: false,
    });
    const first = runtime.database.getSensor("sensor-01")!;
    const second = runtime.database.createSensor({
      ...first,
      id: "power-meter-02",
      name: "Second power-only plug",
      measurementEntityIds: { power: "sensor.second_power" },
    });
    runtime.database.storePropertyElectricityPrices("property-main", [
      { startAt: "2026-07-17T00:00:00.000Z", endAt: "2026-07-17T00:30:00.000Z", rawPriceCentsPerKwh: 10 },
      { startAt: "2026-07-17T00:30:00.000Z", endAt: "2026-07-17T01:00:00.000Z", rawPriceCentsPerKwh: 20 },
    ], "2026-07-16T12:00:00.000Z");
    const timestamps = [
      "2026-07-17T00:00:00.000Z",
      "2026-07-17T00:15:00.000Z",
      "2026-07-17T00:30:00.000Z",
      "2026-07-17T00:45:00.000Z",
      "2026-07-17T01:00:00.000Z",
    ];
    runtime.measurements.ingestBatch(timestamps.flatMap((timestamp, index) => [
      {
        sensorId: first.id,
        metric: "power",
        value: index < 2 ? 1_000 : 2_000,
        canonicalUnit: "W",
        timestamp,
        source: "api" as const,
        quality: "good" as const,
      },
      {
        sensorId: second.id,
        metric: "power",
        value: 500,
        canonicalUnit: "W",
        timestamp,
        source: "api" as const,
        quality: "good" as const,
      },
    ]));

    const result = await request(runtime.app).get("/api/v1/houses/house-main/energy-summary").query({
      from: "2026-07-17T00:00:00.000Z",
      to: "2026-07-17T01:00:00.000Z",
    }).expect(200);
    expect(result.headers["x-stugu-cache"]).toBe("miss");

    expect(result.body.summary).toMatchObject({
      schemaVersion: 2,
      algorithmVersion: "home-energy-summary/v2",
      houseId: "house-main",
      consumptionKwh: 2,
      pricedConsumptionKwh: 2,
      costEur: 0.325,
      priceCoveragePercent: 100,
      complete: true,
      sourceCount: 2,
      totalSources: 2,
      failedSourceCount: 0,
    });
    expect(result.body.summary.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sensorId: first.id,
        measurementBasis: "integrated_power",
        consumptionKwh: 1.5,
        costEur: 0.25,
      }),
      expect.objectContaining({
        sensorId: second.id,
        measurementBasis: "integrated_power",
        consumptionKwh: 0.5,
        costEur: 0.075,
      }),
    ]));
    const cached = await request(runtime.app).get("/api/v1/houses/house-main/energy-summary").query({
      from: "2026-07-17T00:00:00.000Z",
      to: "2026-07-17T01:00:00.000Z",
    }).expect(200);
    expect(cached.headers["x-stugu-cache"]).toBe("hit");
    expect(cached.body.summary.calculatedAt).toBe(result.body.summary.calculatedAt);
  });

  it("prefers a cumulative counter without double counting its power alongside a power-only plug", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      startBackground: false,
    });
    const first = runtime.database.getSensor("sensor-01")!;
    const second = runtime.database.createSensor({
      ...first,
      id: "mixed-power-only",
      name: "Power-only plug",
    });
    runtime.database.storePropertyElectricityPrices("property-main", [{
      startAt: "2026-07-17T00:00:00.000Z",
      endAt: "2026-07-17T01:00:00.000Z",
      rawPriceCentsPerKwh: 10,
    }], "2026-07-16T12:00:00.000Z");
    const timestamps = [
      "2026-07-17T00:00:00.000Z",
      "2026-07-17T00:15:00.000Z",
      "2026-07-17T00:30:00.000Z",
      "2026-07-17T00:45:00.000Z",
      "2026-07-17T01:00:00.000Z",
    ];
    runtime.measurements.ingestBatch([
      { sensorId: first.id, metric: "energy", value: 10, canonicalUnit: "kWh", timestamp: timestamps[0]!, source: "api", quality: "good" },
      { sensorId: first.id, metric: "energy", value: 11, canonicalUnit: "kWh", timestamp: timestamps[4]!, source: "api", quality: "good" },
      ...timestamps.flatMap((timestamp) => [
        { sensorId: first.id, metric: "power", value: 1_000, canonicalUnit: "W", timestamp, source: "api" as const, quality: "good" as const },
        { sensorId: second.id, metric: "power", value: 500, canonicalUnit: "W", timestamp, source: "api" as const, quality: "good" as const },
      ]),
    ]);

    const result = await request(runtime.app).get("/api/v1/houses/house-main/energy-summary").query({
      from: timestamps[0],
      to: timestamps[4],
    }).expect(200);

    expect(result.body.summary).toMatchObject({
      consumptionKwh: 1.5,
      costEur: 0.15,
      complete: true,
      sourceCount: 2,
      totalSources: 2,
    });
    expect(result.body.summary.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sensorId: first.id, measurementBasis: "integrated_power", consumptionKwh: 1 }),
      expect.objectContaining({ sensorId: second.id, measurementBasis: "integrated_power", consumptionKwh: 0.5 }),
    ]));
  });

  it("caps a held power sample at fifteen minutes when telemetry stops", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      startBackground: false,
    });
    runtime.database.storePropertyElectricityPrices("property-main", [{
      startAt: "2026-07-17T00:00:00.000Z",
      endAt: "2026-07-17T01:00:00.000Z",
      rawPriceCentsPerKwh: 10,
    }], "2026-07-16T12:00:00.000Z");
    runtime.measurements.ingestBatch([{
      sensorId: "sensor-01",
      metric: "power",
      value: 1_000,
      canonicalUnit: "W",
      timestamp: "2026-07-17T00:00:00.000Z",
      source: "api",
      quality: "good",
    }]);
    runtime.database.db.prepare(`INSERT INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
      VALUES ('sensor-01', 'power', 9e999, 'W', '2026-07-17T00:30:00.000Z', 'api', 'good')`).run();

    const result = await request(runtime.app).get("/api/v1/houses/house-main/energy-cost").query({
      sensorId: "sensor-01",
      from: "2026-07-17T00:00:00.000Z",
      to: "2026-07-17T01:00:00.000Z",
    }).expect(200);

    expect(result.body.cost).toMatchObject({
      measurementBasis: "integrated_power",
      consumptionKwh: 0.25,
      costEur: 0.025,
      complete: false,
      measurementCoverageUntil: "2026-07-17T00:15:00.000Z",
    });
  });

  it("blocks private custom targets unless private access is explicitly opted in", async () => {
    expect(() => validateElectricityEndpointUrl("https://127.0.0.1/prices.json")).toThrow(/private or reserved/);
    expect(validateElectricityEndpointUrl("https://127.0.0.1/prices.json", true).hostname).toBe("127.0.0.1");

    let fetchCount = 0;
    const fetcher: typeof fetch = async () => {
      fetchCount += 1;
      return new Response("{}", { status: 200 });
    };
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      electricityPriceFetcher: fetcher,
      electricityEndpointResolver: async () => ["127.0.0.1"],
      startBackground: false,
    });
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/config").send({
      provider: "custom", endpointUrl: "https://127.0.0.1/prices.json", enabled: true,
      marginCentsPerKwh: 0, contractType: "spot", contractName: null, retailer: null, monthlyFeeEur: null,
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_ELECTRICITY_ENDPOINT"));
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/config").send({
      provider: "custom", endpointUrl: "https://feed.example/prices.json", enabled: true,
      marginCentsPerKwh: 0, contractType: "spot", contractName: null, retailer: null, monthlyFeeEur: null,
    }).expect(200);
    await request(runtime.app).post("/api/v1/properties/property-main/electricity/refresh")
      .expect(502).expect(({ body }) => expect(body.error.message).toMatch(/private or reserved/));
    expect(fetchCount).toBe(0);
    await runtime.close();

    const now = Date.now();
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test", DATABASE_PATH: ":memory:", ELECTRICITY_ALLOW_PRIVATE_ENDPOINTS: "true",
      }),
      electricityPriceFetcher: async (_input, init) => {
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify({ prices: [{
          price: 1,
          startDate: new Date(now - 60_000).toISOString(),
          endDate: new Date(now + 60_000).toISOString(),
        }] }), { status: 200 });
      },
      electricityEndpointResolver: async () => ["127.0.0.1"],
      startBackground: false,
    });
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/config").send({
      provider: "custom", endpointUrl: "https://127.0.0.1/prices.json", enabled: true,
      marginCentsPerKwh: 0, contractType: "spot", contractName: null, retailer: null, monthlyFeeEur: null,
    }).expect(200);
    await request(runtime.app).post("/api/v1/properties/property-main/electricity/refresh").expect(200);
  });

  it("rejects oversized upstream bodies before parsing or storing them", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      electricityPriceFetcher: async () => new Response("{}", {
        status: 200,
        headers: { "content-length": String(MAX_ELECTRICITY_RESPONSE_BYTES + 1) },
      }),
      electricityEndpointResolver: PUBLIC_RESOLVER,
      startBackground: false,
    });
    await request(runtime.app).post("/api/v1/properties/property-main/electricity/refresh")
      .expect(502).expect(({ body }) => expect(body.error.message).toMatch(/1 MiB/));
    expect(runtime.database.listPropertyElectricityPrices(
      "property-main", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z",
    )).toEqual([]);
  });
});
