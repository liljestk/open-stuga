import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  MAX_ELECTRICITY_RESPONSE_BYTES,
  parseElectricityPricePayload,
  validateElectricityEndpointUrl,
} from "../src/electricity-prices.js";

const PUBLIC_RESOLVER = async (): Promise<string[]> => ["93.184.216.34"];

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
