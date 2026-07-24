import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_VERSION, type ThermalSimulationResult } from "@climate-twin/contracts";

const mocks = vi.hoisted(() => ({ thermalSimulation: vi.fn() }));
vi.mock("./api", () => ({ api: { thermalSimulation: mocks.thermalSimulation } }));

import { useThermalSimulation } from "./useThermalSimulation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function simulation(houseId: string, sensorId: string): ThermalSimulationResult {
  return {
    generatedAt: "2026-07-14T12:00:00.000Z",
    systemVersion: SYSTEM_VERSION,
    houseId,
    sensorId,
    roomLabel: "Room",
    from: "2026-07-13T12:00:00.000Z",
    to: "2026-07-14T12:00:00.000Z",
    horizonHours: 0,
    scenarioOutdoorTemperatureC: null,
    scenarioAnchorTimestamp: null,
    calibration: {
      status: "insufficient-data",
      model: null,
      quality: { indoorSamples: 0, outdoorSamples: 0, alignedSamples: 0, transitionsUsed: 0, durationHours: 0, indoorRangeC: 0, outdoorRangeC: 0, validationMaeC: null, validationRmseC: null, validationBiasC: null, persistenceMaeC: null, residualP90C: null },
      warnings: ["INSUFFICIENT_OVERLAP"],
      assumptions: [],
    },
    points: [],
  };
}

const options = {
  from: "2026-07-13T12:00:00.000Z",
  to: "2026-07-14T12:00:00.000Z",
  horizonHours: 0,
};

describe("useThermalSimulation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores a stale model response after the selected sensor changes", async () => {
    const first = deferred<ThermalSimulationResult>();
    const second = deferred<ThermalSimulationResult>();
    mocks.thermalSimulation.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ houseId, sensorId }) => useThermalSimulation(houseId, sensorId),
      { initialProps: { houseId: "house-a", sensorId: "sensor-a" as string | null } },
    );
    let firstRun!: Promise<ThermalSimulationResult | null>;
    await act(async () => { firstRun = result.current.run(options); });
    rerender({ houseId: "house-b", sensorId: "sensor-b" });
    let secondRun!: Promise<ThermalSimulationResult | null>;
    await act(async () => { secondRun = result.current.run(options); });

    await act(async () => second.resolve(simulation("house-b", "sensor-b")));
    await secondRun;
    expect(result.current.result?.sensorId).toBe("sensor-b");
    await act(async () => first.resolve(simulation("house-a", "sensor-a")));
    await firstRun;
    expect(result.current.result?.sensorId).toBe("sensor-b");
  });

  it("invalidates an in-flight result when visible model inputs are reset", async () => {
    const pending = deferred<ThermalSimulationResult>();
    mocks.thermalSimulation.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useThermalSimulation("house-a", "sensor-a"));
    let run!: Promise<ThermalSimulationResult | null>;
    await act(async () => { run = result.current.run(options); });
    act(() => result.current.reset());
    await act(async () => pending.resolve(simulation("house-a", "sensor-a")));
    await run;
    expect(result.current.result).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
