import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_VERSION, type ConnectionState } from "@climate-twin/contracts";
import { api, cancelPendingApiRequests } from "./api";
import { createDemoState } from "./domain";
import { useClimateData } from "./useClimateData";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  // Keep actual HTTP resource methods and their shared scheduler. Only the
  // long-lived event transports are replaced, with immediate stream readiness.
  subscribeToEvents: (_event: unknown, _state: (state: ConnectionState) => void, onOpen?: () => void) => {
    onOpen?.();
    return () => undefined;
  },
  subscribeToMeasurementEvents: (_sample: unknown, _state: (state: ConnectionState) => void, onOpen?: () => void) => {
    onOpen?.();
    return () => undefined;
  },
}));

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(async () => {
  cleanup();
  await act(async () => { cancelPendingApiRequests(); });
  vi.unstubAllGlobals();
});

describe("bootstrap HTTP scheduling", () => {
  it.each([false, true])("shows the Home before slow optional HTTP reads finish (empty snapshot: %s)", async (emptySnapshot) => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const sensors = demo.sensors.filter((sensor) => sensor.houseId === house.id);
    const otherHouse = { ...house, id: "other-house", name: "Other Home" };
    const requests: string[] = [];
    const pendingOptional: string[] = [];
    window.history.replaceState(null, "", `/properties/${house.propertyId}/homes/${house.id}/electricity`);
    const optionalPaths = new Set([
      "/api/v2/measurements/snapshot",
      "/api/v1/observations",
      "/api/v1/static-parameters",
      "/api/v2/measurement-definitions",
      "/api/v1/alert-rules",
      "/api/v1/alerts",
      "/api/v1/mock/scenarios",
    ]);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      requests.push(`${url.pathname}${url.search}`);
      if ((url.searchParams.get("houseId") === otherHouse.id && ["/api/v1/snapshot", "/api/v1/sensors"].includes(url.pathname))
        || optionalPaths.has(url.pathname)
        || (url.pathname === "/api/v1/maintenance-tasks" && url.searchParams.has("houseId"))) {
        pendingOptional.push(url.pathname);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      switch (url.pathname) {
      case "/api/v1/session": return Promise.resolve(response({ ...demo.session, systemVersion: SYSTEM_VERSION }));
      case "/api/v1/properties": return Promise.resolve(response({ properties: demo.properties }));
      case "/api/v1/houses": return Promise.resolve(response({ houses: [house, otherHouse] }));
      case `/api/v1/houses/${house.id}/energy-summary`: return Promise.resolve(response({ summary: { consumptionKwh: 4 } }));
      case "/api/v1/sensors": return Promise.resolve(response({ sensors }));
      case "/api/v1/snapshot": return Promise.resolve(response({ snapshot: emptySnapshot ? [] : sensors.map((sensor) => ({
        ...sensor, reading: demo.readings[sensor.id] ?? null,
      })) }));
      case "/api/v1/integrations/status": return Promise.resolve(response(demo.integration));
      case "/api/v1/property-areas": return Promise.resolve(response({ areas: [] }));
      case "/api/v1/area-equipment": return Promise.resolve(response({ equipment: [] }));
      case "/api/v1/property-notes": return Promise.resolve(response({ notes: [] }));
      case "/api/v1/maintenance-tasks": return Promise.resolve(response({ maintenanceTasks: [] }));
      case "/api/v1/integrations/tp-link/devices": return Promise.resolve(response({ devices: [] }));
      default: return Promise.reject(new Error(`Unexpected bootstrap request: ${url.pathname}`));
      }
    }));

    const { result } = renderHook(() => useClimateData());
    await waitFor(() => expect(result.current.bootstrapStatus).toBe("ready"));

    expect(result.current.loading).toBe(false);
    expect(result.current.bootstrapError).toBeNull();
    expect(result.current.state.sensors).toEqual(sensors);
    // Non-active Home snapshots use the optional cap too; visible metrics
    // must reach the real HTTP scheduler while every optional call is slow.
    await expect(api.houseEnergySummary(house.id, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"))
      .resolves.toMatchObject({ consumptionKwh: 4 });
    expect(pendingOptional).toHaveLength(1);
    expect(requests).toContain(`/api/v1/snapshot?houseId=${house.id}`);
    if (emptySnapshot) expect(requests).toContain(`/api/v1/sensors?houseId=${house.id}`);
  });
});