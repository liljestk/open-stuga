import type { House, HouseWeather, Sensor, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
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

describe("thermal simulation API client", () => {
  it("encodes the calibration window and optional weather scenario", async () => {
    const simulation = { sensorId: "sensor/office", points: [] };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ simulation }) } as Response);

    await expect(api.thermalSimulation("house/main", {
      sensorId: "sensor/office",
      from: "2026-07-13T10:00:00.000Z",
      to: "2026-07-14T10:00:00.000Z",
      horizonHours: 12,
      scenarioOutdoorTemperatureC: -10,
    })).resolves.toEqual(simulation);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/houses/house%2Fmain/thermal-simulation?sensorId=sensor%2Foffice&from=2026-07-13T10%3A00%3A00.000Z&to=2026-07-14T10%3A00%3A00.000Z&horizonHours=12&scenarioOutdoorTemperatureC=-10");
  });
});

describe("sensor management API client", () => {
  const sensor: Sensor = {
    id: "sensor/hall",
    houseId: "house-main",
    floorId: "floor-ground",
    name: "Hall sensor",
    room: "Hall",
    model: "Tapo T315",
    x: 4,
    y: 3,
    z: 1.4,
    tpLinkDeviceId: "child-315",
    tags: [],
    enabled: true,
  };

  it("creates and patches sensors through the canonical wrapped endpoints", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ sensor }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sensor: { ...sensor, name: "Upper hall" } }) } as Response);

    const { id: _id, ...input } = sensor;
    await expect(api.createSensor(input)).resolves.toEqual(sensor);
    await expect(api.updateSensor(sensor.id, { name: "Upper hall" })).resolves.toMatchObject({ name: "Upper hall" });

    expect(fetchMock.mock.calls[0]).toEqual(["/api/v1/sensors", expect.objectContaining({ method: "POST", body: JSON.stringify(input) })]);
    expect(fetchMock.mock.calls[1]).toEqual(["/api/v1/sensors/sensor%2Fhall", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Upper hall" }) })]);
  });

  it("loads sanitized discovered TP-Link children", async () => {
    const device: TpLinkDiscoveredDevice = {
      deviceId: "child-315",
      model: "T315",
      alias: "Hall",
      status: "online",
      temperature: 21.4,
      humidity: 45,
      battery: 92,
      lastSeenAt: "2026-07-14T12:00:00.000Z",
      mappedSensorId: sensor.id,
    };
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ devices: [device] }) } as Response);

    await expect(api.tpLinkDevices()).resolves.toEqual([device]);
    expect(fetch).toHaveBeenCalledWith("/api/v1/integrations/tp-link/devices", expect.any(Object));
  });

  it("surfaces the server validation message", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "TP_LINK_DEVICE_ALREADY_MAPPED", message: "This TP-Link device is already mapped" } }),
    } as Response);

    await expect(api.updateSensor(sensor.id, { tpLinkDeviceId: "duplicate" })).rejects.toMatchObject({
      status: 409,
      code: "TP_LINK_DEVICE_ALREADY_MAPPED",
      message: "This TP-Link device is already mapped",
    });
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

  it("rejects traversal segments before issuing a request", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();

    await expect(api.deleteHouse("..")).rejects.toThrow("Invalid API request path");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates, updates, and removes independent house layouts", async () => {
    const floor = {
      id: "floor-attic", name: "Attic studio", type: "attic" as const,
      width: 12, height: 8, elevation: 5.8, ceilingHeight: 2.4, walls: [], rooms: [],
    };
    const created = { ...house, id: "house/lake", name: "Lake house", floors: [floor] };
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ house: created }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ house: { ...created, name: "Lake cabin" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => undefined } as Response);

    const input = { name: created.name, timezone: created.timezone, floors: created.floors };
    await expect(api.createHouse(input)).resolves.toEqual(created);
    await expect(api.updateHouse(created.id, { name: "Lake cabin", floors: created.floors })).resolves.toMatchObject({ name: "Lake cabin" });
    await expect(api.deleteHouse(created.id)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]).toEqual(["/api/v1/houses", expect.objectContaining({ method: "POST", body: JSON.stringify(input) })]);
    expect(fetchMock.mock.calls[1]).toEqual(["/api/v1/houses/house%2Flake", expect.objectContaining({ method: "PATCH" })]);
    expect(fetchMock.mock.calls[2]).toEqual(["/api/v1/houses/house%2Flake", expect.objectContaining({ method: "DELETE" })]);
  });

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

  it("patches precise map placement independently from the weather location", async () => {
    const mapPlacement = { latitude: 60.17001, longitude: 24.94002, metersPerPlanUnit: 0.012 };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ house: { ...house, mapPlacement } }),
    } as Response);

    await expect(api.updateHouseGeoreference(house.id, { mapPlacement })).resolves.toMatchObject({ mapPlacement });

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options).toMatchObject({ method: "PATCH", body: JSON.stringify({ mapPlacement }) });
    expect(String(options?.body)).not.toContain('"location"');
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
