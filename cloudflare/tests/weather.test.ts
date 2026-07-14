import { afterEach, describe, expect, it, vi } from "vitest";
import type { House } from "../../packages/contracts/src/index.js";
import { coordinateDefaults, fetchHouseWeather, searchLocations } from "../src/weather.js";

const house: House = {
  id: "house",
  name: "Home",
  timezone: "Europe/Helsinki",
  floors: [],
  location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("hosted weather provider boundary", () => {
  it("normalizes valid forecast values and skips invalid provider timestamps", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      hourly: {
        time: ["not-a-time", "2026-07-14T12:00:00Z"],
        temperature_2m: [99, 12.5],
        relative_humidity_2m: [99, 72],
        wind_speed_10m: [0, 36],
        weather_code: [0, 3],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchHouseWeather(house, 2);
    expect(result.forecast).toEqual([expect.objectContaining({
      timestamp: "2026-07-14T12:00:00.000Z",
      temperatureC: 12.5,
      relativeHumidityPercent: 72,
      windSpeedMps: 10,
    })]);
    expect(result.current).toEqual(result.forecast[0]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("timezone=UTC"), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("maps provider failures and malformed JSON to a stable service error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(fetchHouseWeather(house, 1)).rejects.toMatchObject({ status: 503, code: "WEATHER_UNAVAILABLE" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(fetchHouseWeather(house, 1)).rejects.toMatchObject({ status: 503, code: "WEATHER_UNAVAILABLE" });
  });

  it("filters malformed geocoding results and validates coordinates before fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      results: [
        { id: 1, name: "Helsinki", latitude: 60.17, longitude: 24.94, timezone: "Europe/Helsinki", country: "Finland", country_code: "FI" },
        { id: "bad", name: "Invalid" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchLocations("Helsinki", "en")).resolves.toEqual([
      expect.objectContaining({ id: "1", label: "Helsinki, Finland", countryCode: "FI" }),
    ]);

    await expect(coordinateDefaults(Number.NaN, 24.94)).rejects.toMatchObject({ status: 422, code: "INVALID_COORDINATES" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(Response.json({ timezone: "Europe/Helsinki" }));
    await expect(coordinateDefaults(60.17, 24.94)).resolves.toEqual({ timezone: "Europe/Helsinki", source: "open-meteo-coordinate" });
  });
});
