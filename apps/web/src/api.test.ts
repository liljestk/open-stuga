import type { House, HouseWeather } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import { api } from "./api";

describe("measurement API client", () => {
  it("sends the v2 forecast horizon as hours rather than the legacy horizonMinutes parameter", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ forecast: [] }),
    } as Response);

    await expect(api.measurementForecast("sensor/office", "co2", 6)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v2/measurements/forecast?sensorId=sensor%2Foffice&metric=co2&hours=6");
    expect(String(url)).not.toContain("horizonMinutes");
  });
});

describe("house weather API client", () => {
  const house: House = {
    id: "house/coast",
    name: "Coast house",
    timezone: "Europe/Helsinki",
    location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
    floors: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("patches a house location and unwraps the house response", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ house }),
    } as Response);

    await expect(api.updateHouseLocation(house.id, house.location!)).resolves.toEqual(house);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/houses/house%2Fcoast");
    expect(options).toMatchObject({ method: "PATCH", body: JSON.stringify({ location: house.location }) });
  });

  it("patches orientation without resending or clearing location", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ house: { ...house, orientationDegrees: 270 } }),
    } as Response);

    await expect(api.updateHouseGeoreference(house.id, { orientationDegrees: 270 })).resolves.toMatchObject({ orientationDegrees: 270 });

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options).toMatchObject({ method: "PATCH", body: JSON.stringify({ orientationDegrees: 270 }) });
    expect(String(options?.body)).not.toContain("location");
  });

  it("requests a 48-hour house forecast and unwraps the weather response", async () => {
    const weather: HouseWeather = {
      houseId: house.id,
      location: house.location!,
      provider: "fmi",
      attribution: "Finnish Meteorological Institute open data",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      forecastIssuedAt: null,
      stale: false,
      current: null,
      observationStation: null,
      forecast: [],
      warnings: [],
      unavailable: [],
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ weather }),
    } as Response);

    await expect(api.houseWeather(house.id, 48)).resolves.toEqual(weather);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/houses/house%2Fcoast/weather?hours=48", expect.any(Object));
  });
});
