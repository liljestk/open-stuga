import { describe, expect, it, vi } from "vitest";
import { isIanaTimezone, LocationDiscoveryService } from "../src/location-discovery.js";
import request from "supertest";
import { createApi } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("location discovery", () => {
  it("normalizes place results and keeps their IANA timezone", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      results: [{
        id: 658225,
        name: "Helsinki",
        latitude: 60.16952,
        longitude: 24.93545,
        timezone: "Europe/Helsinki",
        country_code: "FI",
        country: "Finland",
        admin1: "Uusimaa",
        population: 658_864,
      }],
    }), { headers: { "content-type": "application/json" } }));
    const service = new LocationDiscoveryService({ fetchImpl });

    await expect(service.search("Helsinki", "fi")).resolves.toEqual([expect.objectContaining({
      label: "Helsinki, Uusimaa, Finland",
      timezone: "Europe/Helsinki",
      source: "open-meteo-geocoding",
      confidence: "high",
    })]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("language=fi");
  });

  it("resolves timezone defaults only after coordinates are supplied", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ timezone: "Pacific/Auckland" })));
    const service = new LocationDiscoveryService({ fetchImpl });
    await expect(service.defaultsForCoordinates(-36.85, 174.76)).resolves.toEqual({
      timezone: "Pacific/Auckland",
      source: "open-meteo-coordinate",
    });
  });

  it("rejects invalid timezones and coordinates", async () => {
    expect(isIanaTimezone("Europe/Helsinki")).toBe(true);
    expect(isIanaTimezone("Near/Somewhere")).toBe(false);
    const service = new LocationDiscoveryService({ fetchImpl: vi.fn() });
    await expect(service.defaultsForCoordinates(91, 0)).rejects.toThrow(/valid WGS84/);
  });

  it("exposes only explicit search and coordinate-default requests through the API", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      return url.includes("geocoding-api")
        ? new Response(JSON.stringify({ results: [{
          id: 1, name: "Turku", latitude: 60.45, longitude: 22.27,
          timezone: "Europe/Helsinki", country: "Finland", country_code: "FI",
        }] }))
        : new Response(JSON.stringify({ timezone: "Europe/Helsinki" }));
    });
    const runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }),
      startBackground: false,
      locationDiscovery: new LocationDiscoveryService({ fetchImpl }),
    });
    try {
      await request(runtime.app).get("/api/v1/locations/search?q=Turku&language=fi").expect(200)
        .expect(({ body }) => expect(body.results[0]).toMatchObject({ name: "Turku", timezone: "Europe/Helsinki" }));
      await request(runtime.app).get("/api/v1/locations/defaults?latitude=60.45&longitude=22.27").expect(200)
        .expect(({ body }) => expect(body.timezone).toBe("Europe/Helsinki"));
      await request(runtime.app).get("/api/v1/locations/search?q=x").expect(400);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
    }
  });
});
