import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sensor } from "@climate-twin/contracts";
import { createDemoState } from "../../domain";
import { queryClient } from "../queryClient";
import { sensorMutationKeys, useSensorMutations } from "./sensorMutations";

const mocks = vi.hoisted(() => ({
  createSensor: vi.fn(),
  updateSensor: vi.fn(),
  deleteSensor: vi.fn(),
}));

vi.mock("../../api", () => ({
  api: {
    createSensor: mocks.createSensor,
    updateSensor: mocks.updateSensor,
    deleteSensor: mocks.deleteSensor,
  },
  cancelPendingApiRequests: vi.fn(),
  subscribeToApiAuthorizationChanges: vi.fn(() => vi.fn()),
}));

function fixture() {
  const sensor = createDemoState().sensors[0]!;
  const { id: _id, ...input } = sensor;
  return { sensor, input };
}

describe("sensor mutation ownership", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("executes every sensor write through a named TanStack mutation", async () => {
    const { sensor, input } = fixture();
    const moved = { ...sensor, x: sensor.x + 10, y: sensor.y + 10 };
    mocks.createSensor.mockResolvedValue(sensor);
    mocks.updateSensor
      .mockResolvedValueOnce({ ...sensor, name: "Updated" })
      .mockResolvedValueOnce(moved);
    mocks.deleteSensor.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSensorMutations());

    await act(async () => {
      await result.current.createSensor(input);
      await result.current.updateSensor({
        sensorId: sensor.id,
        patch: { name: "Updated" },
        previousHouseId: sensor.houseId,
      });
      await result.current.moveSensor({
        sensorId: sensor.id,
        point: { x: moved.x, y: moved.y },
        previousHouseId: sensor.houseId,
      });
      await result.current.deleteSensor({ sensorId: sensor.id, houseId: sensor.houseId });
    });

    expect(mocks.createSensor).toHaveBeenCalledWith(input);
    expect(mocks.updateSensor).toHaveBeenNthCalledWith(1, sensor.id, { name: "Updated" });
    expect(mocks.updateSensor).toHaveBeenNthCalledWith(2, sensor.id, { x: moved.x, y: moved.y });
    expect(mocks.deleteSensor).toHaveBeenCalledWith(sensor.id);
    expect(queryClient.getMutationCache().getAll().map((mutation) => mutation.options.mutationKey))
      .toEqual([
        sensorMutationKeys.create,
        sensorMutationKeys.update,
        sensorMutationKeys.move,
        sensorMutationKeys.delete,
      ]);
  });

  it("invalidates derived queries only for the sensor's old and new Homes", async () => {
    const { sensor } = fixture();
    const moved: Sensor = { ...sensor, houseId: "home-2" };
    mocks.updateSensor.mockResolvedValue(moved);
    const affectedKeys = [
      ["house", sensor.houseId, "monitoring", "real"],
      ["house", "home-2", "analytics", "home-performance", "real"],
      ["analytics", "opening-activity", sensor.houseId, "request"],
      ["analytics", "calendar-comparison", "home-2", "request"],
    ] as const;
    const unaffectedKey = ["house", "home-3", "monitoring", "real"] as const;
    const collectionKey = ["monitoring", "houses", "real"] as const;
    for (const key of [...affectedKeys, unaffectedKey, collectionKey]) {
      queryClient.setQueryData(key, {});
    }
    const { result } = renderHook(() => useSensorMutations());

    await act(async () => {
      await result.current.updateSensor({
        sensorId: sensor.id,
        patch: { houseId: moved.houseId },
        previousHouseId: sensor.houseId,
      });
    });

    for (const key of [...affectedKeys, collectionKey]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(unaffectedKey)?.isInvalidated).toBe(false);
  });
});
