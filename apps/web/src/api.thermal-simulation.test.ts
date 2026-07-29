import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import "./apiTestSupport.js";

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("encodes the whole-home thermal isolation window", async () => {
    const isolation = { houseId: "house/main", entries: [] };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ isolation }) } as Response);

    await expect(api.thermalIsolation("house/main", {
      from: "2026-07-07T10:00:00.000Z",
      to: "2026-07-14T10:00:00.000Z",
    })).resolves.toEqual(isolation);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/houses/house%2Fmain/thermal-isolation?from=2026-07-07T10%3A00%3A00.000Z&to=2026-07-14T10%3A00%3A00.000Z");
  });
});
