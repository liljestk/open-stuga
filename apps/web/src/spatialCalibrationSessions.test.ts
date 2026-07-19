import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.clearAllMocks());

const session = {
  id: "session-1",
  houseId: "house/main",
  kind: "controlled-propagation",
  status: "completed",
  startAt: "2026-07-16T18:00:00.000Z",
  endAt: "2026-07-16T18:30:00.000Z",
  intervention: { description: "Kitchen door opened" },
  notes: "Humidity pulse",
  createdAt: "2026-07-16T18:31:00.000Z",
  updatedAt: "2026-07-16T18:31:00.000Z",
};

describe("guided spatial calibration-session API", () => {
  it("loads and creates version-tolerant house calibration sessions", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sessions: [session] }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ session, calibrations: [] }) } as Response);

    await expect(api.houseSpatialLayerCalibrationSessions("house/main")).resolves.toEqual([session]);
    await expect(api.createHouseSpatialLayerCalibrationSession("house/main", {
      kind: "controlled-propagation",
      status: "completed",
      startAt: session.startAt,
      endAt: session.endAt,
      intervention: session.intervention,
      notes: session.notes,
    })).resolves.toEqual({ session, calibrations: [] });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/houses/house%2Fmain/layers/calibration-sessions");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/houses/house%2Fmain/layers/calibration-sessions");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("controlled-propagation"),
    }));
  });
});
