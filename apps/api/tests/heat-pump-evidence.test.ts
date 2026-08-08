import type { MeasurementSample } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import {
  buildHeatPumpExclusionWindow,
  filterHeatPumpAffectedSamples,
  isPassiveHeatPumpTime,
  type HeatPumpEvidencePoint,
} from "../src/analytics/heat-pump-evidence.js";

const FROM = "2026-08-01T00:00:00.000Z";
const TO = "2026-08-01T04:00:00.000Z";
const MINUTE_MS = 60_000;

function minutePoints(
  classify: (minute: number) => HeatPumpEvidencePoint["classification"],
  include: (minute: number) => boolean = () => true,
): HeatPumpEvidencePoint[] {
  const start = Date.parse(FROM) - 35 * MINUTE_MS;
  return Array.from({ length: 281 }, (_, index) => index - 35)
    .filter(include)
    .map((minute) => ({
      connectionId: "heat-pump-1",
      time: start + (minute + 35) * MINUTE_MS,
      classification: classify(minute),
    }));
}

function sample(timestamp: string): MeasurementSample {
  return {
    sensorId: "room-sensor",
    metric: "temperature",
    value: 21,
    canonicalUnit: "°C",
    timestamp,
    source: "api",
    quality: "good",
  };
}

describe("heat-pump passive analytics evidence", () => {
  it("keeps an unconfigured Home unchanged", () => {
    const window = buildHeatPumpExclusionWindow({ from: FROM, to: TO, connectionIds: [], points: [] });
    expect(window.summary).toMatchObject({
      evidenceState: "not-present",
      heatPumpCount: 0,
      usableHours: 4,
      excludedHours: 0,
    });
    expect(isPassiveHeatPumpTime(window, FROM)).toBe(true);
    expect(filterHeatPumpAffectedSamples([sample(TO)], window).samples).toHaveLength(1);
  });

  it("excludes possible and confirmed operation with five-minute lead and thirty-minute recovery", () => {
    const window = buildHeatPumpExclusionWindow({
      from: FROM,
      to: TO,
      connectionIds: ["heat-pump-1"],
      points: minutePoints((minute) => (
        minute === 65 ? "confirmed-active" : minute >= 60 && minute < 70 ? "possible-active" : "off"
      )),
    });
    expect(window.summary).toMatchObject({
      evidenceState: "partial",
      classifiedPercent: 100,
      confirmedActiveHours: 0.02,
      possibleActiveHours: 0.15,
      usableHours: 3.25,
      excludedHours: 0.75,
    });
    expect(isPassiveHeatPumpTime(window, "2026-08-01T00:54:59.000Z")).toBe(true);
    expect(isPassiveHeatPumpTime(window, "2026-08-01T00:55:00.000Z")).toBe(false);
    expect(isPassiveHeatPumpTime(window, "2026-08-01T01:39:59.000Z")).toBe(false);
    expect(isPassiveHeatPumpTime(window, "2026-08-01T01:40:00.000Z")).toBe(true);
  });

  it("treats stale gaps as unknown and fails closed when coverage is insufficient", () => {
    const window = buildHeatPumpExclusionWindow({
      from: FROM,
      to: TO,
      connectionIds: ["heat-pump-1"],
      points: [{
        connectionId: "heat-pump-1",
        time: Date.parse(FROM),
        classification: "off",
      }],
    });
    const filtered = filterHeatPumpAffectedSamples([
      sample("2026-08-01T00:01:00.000Z"),
      sample("2026-08-01T03:00:00.000Z"),
    ], window);
    expect(filtered.samples).toEqual([]);
    expect(filtered.summary).toMatchObject({
      evidenceState: "insufficient",
      classifiedPercent: 2.1,
      usableHours: 0,
      excludedHours: 4,
      retainedSampleCount: 0,
      excludedSampleCount: 2,
    });
  });

  it("requires every tracked heat pump to be verified off", () => {
    const first = minutePoints(() => "off");
    const second = minutePoints((minute) => minute < 120 ? "unknown" : "off")
      .map((point) => ({ ...point, connectionId: "heat-pump-2" }));
    const window = buildHeatPumpExclusionWindow({
      from: FROM,
      to: TO,
      connectionIds: ["heat-pump-1", "heat-pump-2"],
      points: [...first, ...second],
    });
    expect(window.summary).toMatchObject({
      heatPumpCount: 2,
      evidenceState: "insufficient",
      classifiedPercent: 50,
      usableHours: 0,
    });
  });

  it("fails the entire window closed when retained state history was truncated", () => {
    const window = buildHeatPumpExclusionWindow({
      from: FROM,
      to: TO,
      connectionIds: ["heat-pump-1"],
      points: minutePoints(() => "off"),
      truncated: true,
    });

    expect(window.passiveIntervals).toEqual([]);
    expect(window.summary).toMatchObject({
      evidenceState: "insufficient",
      classifiedPercent: 100,
      usableHours: 0,
      excludedHours: 4,
      truncated: true,
    });
  });
});
