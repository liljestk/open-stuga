import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.clearAllMocks());

const session = {
  id: "inference-1",
  houseId: "house/main",
  status: "active" as const,
  startedAt: "2026-08-08T09:00:00.000Z",
  expiresAt: "2026-08-08T10:00:00.000Z",
  cadenceMinutes: 10,
  nextRunAt: "2026-08-08T09:10:00.000Z",
  lastScheduledAt: "2026-08-08T09:00:00.000Z",
  stoppedAt: null,
  createdBy: "owner-1",
  createdAt: "2026-08-08T09:00:00.000Z",
  updatedAt: "2026-08-08T09:00:00.000Z",
};

describe("bounded spatial inference-session API", () => {
  it("loads, starts, and stops the singular Home session resource", async () => {
    const stopped = { ...session, status: "stopped" as const, stoppedAt: "2026-08-08T09:30:00.000Z" };
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ session }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ session }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ session: stopped }) } as Response);

    await expect(api.houseSpatialInferenceSession("house/main")).resolves.toEqual(session);
    await expect(api.startHouseSpatialInferenceSession("house/main", {
      durationMinutes: 60,
      cadenceMinutes: 10,
    })).resolves.toEqual(session);
    await expect(api.stopHouseSpatialInferenceSession("house/main")).resolves.toEqual(stopped);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/houses/house%2Fmain/layers/inference-session",
      "/api/v1/houses/house%2Fmain/layers/inference-session",
      "/api/v1/houses/house%2Fmain/layers/inference-session",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ durationMinutes: 60, cadenceMinutes: 10 }),
    }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: "DELETE" }));
  });
});
