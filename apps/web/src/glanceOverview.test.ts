import type { MeasurementSample, Sensor } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { normalizeGlanceMetrics, summarizeGlanceMetric } from "./glanceOverview";

const now = Date.parse("2026-08-04T10:00:00.000Z");
const sensor = (id: string, role?: Sensor["energyMeterRole"], houseId = "home-one"): Sensor => ({
  id,
  houseId,
  floorId: "floor-one",
  name: id,
  room: "Living room",
  model: "test",
  x: 0,
  y: 0,
  z: 0,
  tags: [],
  enabled: true,
  ...(role ? { energyMeterRole: role } : {}),
});
const sample = (sensorId: string, metric: string, value: number, quality: MeasurementSample["quality"] = "good"): MeasurementSample => ({
  sensorId,
  metric,
  value,
  canonicalUnit: metric === "power" ? "W" : "°C",
  timestamp: "2026-08-04T09:58:00.000Z",
  source: "api",
  quality,
});

describe("glance overview summaries", () => {
  it("averages recent environmental readings and excludes stale evidence", () => {
    const sensors = [sensor("one"), sensor("two"), sensor("stale")];
    const result = summarizeGlanceMetric(sensors, {
      one: { temperature: sample("one", "temperature", 20) },
      two: { temperature: sample("two", "temperature", 22) },
      stale: { temperature: sample("stale", "temperature", 35, "stale") },
    }, "temperature", now);
    expect(result).toMatchObject({ value: 21, sampleCount: 2 });
  });

  it("gives each Home equal weight in a Property environmental average", () => {
    const sensors = [
      sensor("one", undefined, "home-one"),
      sensor("two", undefined, "home-one"),
      sensor("three", undefined, "home-two"),
    ];
    const result = summarizeGlanceMetric(sensors, {
      one: { temperature: sample("one", "temperature", 20) },
      two: { temperature: sample("two", "temperature", 22) },
      three: { temperature: sample("three", "temperature", 30) },
    }, "temperature", now);
    expect(result).toMatchObject({ value: 25.5, sampleCount: 3 });
  });

  it("uses whole-Home power instead of double-counting a submeter", () => {
    const sensors = [sensor("main", "whole_home"), sensor("heater", "submeter")];
    const result = summarizeGlanceMetric(sensors, {
      main: { power: sample("main", "power", 1_200) },
      heater: { power: sample("heater", "power", 800) },
    }, "power", now);
    expect(result).toMatchObject({ value: 1_200, sampleCount: 1 });
  });

  it("selects electricity sources independently for each Home in a Property", () => {
    const sensors = [
      sensor("main", "whole_home", "home-one"),
      sensor("heater", "submeter", "home-one"),
      sensor("cottage", undefined, "home-two"),
    ];
    const result = summarizeGlanceMetric(sensors, {
      main: { power: sample("main", "power", 1_200) },
      heater: { power: sample("heater", "power", 800) },
      cottage: { power: sample("cottage", "power", 300) },
    }, "power", now);
    expect(result).toMatchObject({ value: 1_500, sampleCount: 2 });
  });

  it("falls back to all default metrics when a saved selection is empty or invalid", () => {
    expect(normalizeGlanceMetrics(["unsupported"])).toEqual([
      "temperature", "humidity", "power", "co2",
    ]);
  });
});
