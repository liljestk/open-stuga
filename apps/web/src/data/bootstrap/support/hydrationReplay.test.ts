import type { MaintenanceTask, ManualObservation, MeasurementSample, Sensor, StaticParameter } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { createDemoState } from "../../../domain";
import { preserveSeriesCommittedDuringLoad, replayHouseMutations } from "./hydrationReplay";
import type { HouseMutationBuffer } from "./telemetryState";

const sensor = (id: string, name = id) => ({ id, houseId: "house-a", name }) as Sensor;
const observation = (id: string, sensorId: string | null) => ({ id, sensorId }) as ManualObservation;
const task = (id: string, title = id) => ({ id, title }) as MaintenanceTask;
const parameter = (id: string, scopeType: StaticParameter["scopeType"], scopeId: string, key: string, value: number) => (
  { id, houseId: "house-a", scopeType, scopeId, key, value, unit: null, label: key }
) as StaticParameter;

describe("replayHouseMutations", () => {
  const loaded = () => ({
    sensors: [sensor("s1"), sensor("s2")],
    observations: [observation("o1", "s1"), observation("o2", "s2")],
    maintenanceTasks: [task("t1"), task("t2")],
    staticParameters: [
      parameter("p1", "sensor", "s1", "offset", 1),
      parameter("p2", "room", "kitchen", "volume", 20),
    ],
    extra: "kept",
  });

  it("replays every buffered resource mutation for its Home in order", () => {
    const buffered: HouseMutationBuffer = new Map([
      ["sensor-delete", { resource: "sensor", action: "delete", houseId: "house-a", id: "s1" }],
      ["sensor-upsert", { resource: "sensor", action: "upsert", houseId: "house-a", value: sensor("s3") }],
      ["sensor-other-home", { resource: "sensor", action: "delete", houseId: "house-b", id: "s2" }],
      ["observation-upsert", { resource: "observation", action: "upsert", houseId: "house-a", value: observation("o3", "s3") }],
      ["maintenance-delete", { resource: "maintenance", action: "delete", houseId: "house-a", id: "t1" }],
      ["maintenance-upsert", { resource: "maintenance", action: "upsert", houseId: "house-a", value: task("t2", "renamed") }],
      ["static-upsert", { resource: "static", action: "upsert", houseId: "house-a", value: parameter("p3", "room", "kitchen", "volume", 25) }],
    ]);

    const replayed = replayHouseMutations("house-a", loaded(), buffered);

    expect(replayed.extra).toBe("kept");
    expect(replayed.sensors.map((item) => item.id)).toEqual(["s2", "s3"]);
    expect(replayed.deletedSensorIds).toEqual(new Set(["s1"]));
    expect(replayed.observations).toEqual([observation("o1", null), observation("o2", "s2"), observation("o3", "s3")]);
    expect(replayed.maintenanceTasks).toEqual([task("t2", "renamed")]);
    expect(replayed.staticParameters.map((item) => item.id)).toEqual(["p3"]);
  });

  it("restores a re-created sensor and applies replacements and static deletes", () => {
    const buffered: HouseMutationBuffer = new Map([
      ["sensor-delete", { resource: "sensor", action: "delete", houseId: "house-a", id: "s2" }],
      ["sensor-restore", { resource: "sensor", action: "upsert", houseId: "house-a", value: sensor("s2", "restored") }],
      ["observation-replace", { resource: "observation", action: "replace", houseId: "house-a", values: [observation("o9", null)] }],
      ["maintenance-replace", { resource: "maintenance", action: "replace", houseId: "house-a", values: [task("t9")] }],
      ["static-delete", { resource: "static", action: "delete", houseId: "house-a", id: "p2" }],
    ]);

    const replayed = replayHouseMutations("house-a", loaded(), buffered);

    expect(replayed.sensors).toEqual([sensor("s1"), sensor("s2", "restored")]);
    expect(replayed.deletedSensorIds.size).toBe(0);
    expect(replayed.observations).toEqual([observation("o9", null)]);
    expect(replayed.maintenanceTasks).toEqual([task("t9")]);
    expect(replayed.staticParameters.map((item) => item.id)).toEqual(["p1"]);
  });

  it("only replays workspace-wide maintenance for the workspace scope", () => {
    const buffered: HouseMutationBuffer = new Map([
      ["workspace-task", { resource: "maintenance", action: "upsert", houseId: null, value: task("t-workspace") }],
    ]);
    expect(replayHouseMutations("house-a", loaded(), buffered).maintenanceTasks.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(replayHouseMutations(null, loaded(), buffered).maintenanceTasks.map((item) => item.id)).toEqual(["t1", "t2", "t-workspace"]);
  });
});

describe("preserveSeriesCommittedDuringLoad", () => {
  const sample = (sensorId: string, timestamp: string, value: number) => ({
    sensorId, metric: "temperature", value, canonicalUnit: "°C", timestamp, source: "api", quality: "good",
  }) as MeasurementSample;

  it("keeps an explicitly loaded measurement series across a snapshot refresh, only for loaded sensors", () => {
    const current = createDemoState();
    current.measurementHistory = {
      s1: { temperature: [sample("s1", "2026-07-14T10:00:00.000Z", 20)] },
      s2: { temperature: [sample("s2", "2026-07-14T10:00:00.000Z", 18)] },
    };
    current.measurementForecasts = { s1: { temperature: [] }, s2: { temperature: [] } };
    const loaded = {
      latestMeasurements: {},
      measurementHistory: { s1: { temperature: [sample("s1", "2026-07-14T10:01:00.000Z", 21)] } },
      measurementForecasts: {},
      readings: {},
    };
    const commits = new Map([
      ["s1\u0000temperature", { version: 1 }],
      ["s2\u0000temperature", { version: 2 }],
      ["malformed", { version: 3 }],
    ]);

    const preserved = preserveSeriesCommittedDuringLoad(loaded, current, new Set(["s1"]), commits);

    expect(preserved.measurementHistory.s1?.temperature?.map((item) => item.timestamp))
      .toEqual(["2026-07-14T10:00:00.000Z", "2026-07-14T10:01:00.000Z"]);
    expect(preserved.measurementForecasts.s1?.temperature).toEqual([]);
    expect(preserved.measurementHistory.s2).toBeUndefined();
    expect(preserved.measurementForecasts.s2).toBeUndefined();
  });
});
