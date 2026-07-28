import { describe, expect, it } from "vitest";
import type { OutdoorTemperatureSample } from "@climate-twin/contracts";
import { replayOutdoorAttribution, replayOutdoorConditions, replayOutdoorSampleAt } from "./replayWeather";

function sample(timestamp: string, temperatureC: number): OutdoorTemperatureSample {
  return {
    houseId: "house-1",
    locationKey: "location-1",
    timestamp,
    temperatureC,
    source: "fmi-observation",
    fetchedAt: timestamp,
    stationId: "station-1",
    stationName: "Test station",
  };
}

describe("replay weather", () => {
  it("selects the newest recorded observation at or before the replay cursor", () => {
    const samples = [
      sample("2026-07-14T10:00:00.000Z", 12),
      sample("invalid", 99),
      sample("2026-07-14T11:00:00.000Z", 13),
      sample("2026-07-14T12:00:00.000Z", 14),
    ];

    expect(replayOutdoorSampleAt(samples, Date.parse("2026-07-14T11:30:00.000Z"))?.temperatureC).toBe(13);
    expect(replayOutdoorSampleAt(samples, Date.parse("2026-07-14T09:00:00.000Z"))).toBeNull();
  });

  it("preserves the complete canonical observation and fills legacy temperature-only rows", () => {
    const full = {
      ...sample("2026-07-14T11:00:00.000Z", 13),
      conditions: {
        timestamp: "2026-07-14T11:00:00.000Z",
        temperatureC: 13,
        relativeHumidityPercent: 78,
        pressureHpa: 1_009,
        windDirectionDegrees: 220,
        windSpeedMps: 4.2,
        precipitation1hMm: 0.6,
      },
    };

    expect(replayOutdoorConditions(full)).toMatchObject(full.conditions!);
    expect(replayOutdoorConditions(sample("2026-07-14T10:00:00.000Z", 12))).toEqual({
      timestamp: "2026-07-14T10:00:00.000Z",
      temperatureC: 12,
    });
    expect(replayOutdoorAttribution(full)).toContain("Finnish Meteorological Institute");
  });
});
