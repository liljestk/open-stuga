import { describe, expect, it, vi } from "vitest";
import { api } from "./api";

describe("spatial layer API client", () => {
  it("parses engine health from the real current-response wrapper", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        partition: { sourceDbId: "local", dataMode: "real" },
        scope: { kind: "house", id: "house/main" },
        at: null,
        topology: {
          scope: { kind: "house", id: "house/main" },
          frames: [],
          zones: [],
          connections: [],
        },
        layers: [],
        health: [{
          engineId: "climate-scalars",
          layerId: "climate.temperature",
          state: "available",
          checkedAt: "2026-08-08T12:00:00.000Z",
          reasonCodes: [],
        }],
        warnings: [],
      }),
    } as Response);

    await expect(api.houseSpatialLayersCurrent("house/main", ["climate.temperature"])).resolves.toMatchObject({
      snapshots: [],
      topology: { scope: { kind: "house", id: "house/main" } },
      health: [{
        engineId: "climate-scalars",
        layerId: "climate.temperature",
        state: "healthy",
        checkedAt: "2026-08-08T12:00:00.000Z",
        reasonCodes: [],
      }],
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/houses/house%2Fmain/layers/current?layers=climate.temperature",
      expect.any(Object),
    );
  });
});
