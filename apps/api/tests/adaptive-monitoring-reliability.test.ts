import { describe, expect, it, vi } from "vitest";
import { adaptiveReferenceDeviceKey } from "@climate-twin/contracts";
import { adaptiveFixture, adaptiveHour, qualifiedStream, START } from "./adaptive-monitoring-test-support.js";
import { sensor } from "./home-monitoring-test-support.js";
import { DAY, HOUR } from "../src/analytics/adaptive-monitoring/evidence.js";
import { analyseAdaptiveHour } from "../src/analytics/adaptive-monitoring/policy.js";
import { fitProfileForecaster, fitThermalForecaster, lookup, restoreForecaster } from "../src/analytics/forecast/models.js";
import { privateAdaptivePath } from "../src/analytics/adaptive-monitoring/private-path.js";
import { resolve } from "node:path";

describe("adaptive monitoring reliability", () => {
  it("keeps private evaluation evidence outside the checkout, including dot-prefixed paths", () => {
    expect(() => privateAdaptivePath(resolve(process.cwd(), "..private", "receipt.json"))).toThrow("outside the checkout");
    expect(() => privateAdaptivePath("receipt.json")).toThrow("absolute paths");
  });
  it("does not treat HA entities or duplicate hub bindings as independent physical devices", () => {
    expect(adaptiveReferenceDeviceKey({})).toBeNull();
    expect(adaptiveReferenceDeviceKey({ tpLinkDeviceId: "fake-child" })).toBe("tp-link:fake-child");
  });
  it("defers a comparison until the reference hours are committed, then processes it once", async () => {
    const f = adaptiveFixture();
    try {
      f.database.updateSensor("sensor-one", { tpLinkDeviceId: "test-target" });
      for (const id of ["peer-a", "peer-b"]) f.database.createSensor(sensor(id, "Bedroom", {
        temperatureEntityId: `sensor.${id}_temperature`, tpLinkDeviceId: id,
      }));
      f.service.settings(f.home.id, { dataMode: "live", baseRevision: 1, referenceGroups: [
        { sensorId: "sensor-one", peerIds: ["peer-a", "peer-b"], designatedReference: false },
      ] }, "test-owner");
      const streams = f.service.store.streams(f.home.id, "live");
      const comparison = streams.find(s => s.stream.kind === "sensor-comparison")!;
      f.setNow(START + 2 * HOUR + 10 * 60_000);
      f.database.insertMeasurementSamples(["sensor-one", "peer-a", "peer-b"].flatMap((id, index) =>
        Array.from({ length: 120 }, (_, i) => ({ sensorId: id, metric: "temperature", canonicalUnit: "°C",
          timestamp: new Date(START + i * 60_000).toISOString(), value: 21 + index * 0.2,
          source: "home-assistant" as const, quality: "good" as const }))));
      await f.service.process(comparison, new AbortController().signal);
      expect(f.service.store.hours(comparison, START + 2 * HOUR)).toEqual([]);
      for (const stream of streams.filter(s => s.stream.kind === "climate-departure")) {
        await f.service.process(stream, new AbortController().signal);
      }
      await f.service.process(comparison, new AbortController().signal);
      const hour = f.service.store.hours(comparison, START + 2 * HOUR).find(h => h.time === START + 2 * HOUR)!;
      expect(hour.value).toBe(21); expect(hour.peer).toBeCloseTo(21.3); expect(hour.peerSpread).toBeCloseTo(0.2);
      f.database.updateSensor("peer-a", { x: 8 }); f.service.invalidate();
      const moved = f.service.store.streams(f.home.id, "live").find(s => s.stream.kind === "sensor-comparison")!;
      expect(moved.stream.epoch).not.toBe(comparison.stream.epoch);
      expect(moved.runtime.referenceBaseline).toBeUndefined();
    } finally { f.database.close(); }
  });
  it("does not resurrect an invalidated epoch when a delayed read finishes", async () => {
    const f = adaptiveFixture();
    try {
      f.setNow(START + 2 * HOUR + 10 * 60_000);
      const reader = f.service.options.telemetryReader;
      const read = reader.measurementWindow.bind(reader);
      vi.spyOn(reader, "measurementWindow").mockImplementationOnce(async query => {
        f.database.updateSensor("sensor-one", { x: 8 }); f.service.invalidate();
        return read(query);
      });
      await f.service.process(f.stream, new AbortController().signal);
      const current = f.service.store.streams(f.home.id, "live")[0]!;
      expect(current.stream.epoch).not.toBe(f.stream.stream.epoch);
      expect(current.stream.evaluatedThrough).toBeNull(); expect(current.stream.state).toBe("collecting");
      expect(f.service.store.hours(current, START + 3 * HOUR)).toEqual([]);
    } finally { f.database.close(); }
  });
  it("abstains and reports a pause when a shared input budget is exhausted", async () => {
    const f = adaptiveFixture();
    try {
      f.setNow(START + 2 * HOUR + 10 * 60_000);
      await f.service.process(f.stream, new AbortController().signal, { remaining: 0 });
      expect(f.service.store.streams(f.home.id, "live")[0]?.stream).toMatchObject({ state: "paused", reason: "input-budget" });
      expect(f.service.store.hours(f.stream, START + 2 * HOUR)).toEqual([]);
    } finally { f.database.close(); }
  });
  it("keeps the reference baseline after the original hourly ledger ages out", () => {
    const f = adaptiveFixture();
    try {
      const stored = qualifiedStream(f.stream);
      stored.stream.kind = "sensor-comparison";
      const hours = Array.from({ length: 14 * 24 }, (_, i) => adaptiveHour(i + 1, { value: 21.2, peer: 21, peerSpread: 0.1 }));
      const initial = analyseAdaptiveHour(stored, { hours, current: adaptiveHour(14 * 24 + 1, { value: 21.2, peer: 21 }) });
      expect(initial.runtime.referenceBaseline?.offset).toBeCloseTo(0.2);
      const later = analyseAdaptiveHour({ ...stored, runtime: initial.runtime }, { hours: [],
        current: adaptiveHour(100 * 24, { value: 21.2, peer: 21 }) });
      expect(later.hour.score?.residual).toBeCloseTo(0);
      expect(later.runtime.referenceBaseline?.cutoff).toBe(START + 14 * DAY);
    } finally { f.database.close(); }
  });
  it("round-trips fitted parameters without changing existing forecast output", () => {
    const history = Array.from({ length: 14 * 24 }, (_, i) => ({ time: START + i * HOUR, value: 21 + Math.sin(i * Math.PI / 12) + i * 0.002 }));
    const outdoor = lookup(history.map(p => ({ time: p.time, value: 0 })));
    const origin = history.at(-1)!;
    for (const model of [fitProfileForecaster(history, origin.time), fitThermalForecaster(history, outdoor, origin.time)]) {
      expect(model?.snapshot).toBeDefined();
      const restored = restoreForecaster(JSON.parse(JSON.stringify(model!.snapshot)), history, outdoor);
      expect(restored.forecast(origin.time, origin.value, 24)).toEqual(model!.forecast(origin.time, origin.value, 24));
    }
  });
});
