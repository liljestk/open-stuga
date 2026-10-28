import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import "./apiTestSupport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thermal simulation API client", () => {
  it("encodes the calibration window and optional weather scenario", async () => {
    const simulation = { houseId: "house/main", sensorId: "sensor/office", calibration: {}, points: [] };
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
    const isolation = { houseId: "house/main", entries: [], insights: [], methodology: {} };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ isolation }) } as Response);

    await expect(api.thermalIsolation("house/main", {
      from: "2026-07-07T10:00:00.000Z",
      to: "2026-07-14T10:00:00.000Z",
    })).resolves.toEqual(isolation);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/houses/house%2Fmain/thermal-isolation?from=2026-07-07T10%3A00%3A00.000Z&to=2026-07-14T10%3A00%3A00.000Z");
  });

  it("reads and refreshes the canonical durable comparison through v2", async () => {
    const response = {
      apiVersion: "1.0", kind: "thermal-isolation", houseId: "house/main",
      dataMode: "live", windowDays: 7, cutoff: "2026-08-08T00:00:00.000Z",
      state: "queued", stale: true, result: null, artifact: null, job: null,
    } as const;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => response } as Response);

    await expect(api.cachedThermalIsolation("house/main", {
      windowDays: 7,
      dataMode: "live",
    })).resolves.toEqual(response);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v2/analytics/thermal-isolation?houseId=house%2Fmain&dataMode=live&windowDays=7",
    );

    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => response } as Response);
    await api.refreshCachedThermalIsolation("house/main", { windowDays: 7, dataMode: "live" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });
});
