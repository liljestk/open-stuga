import type { MeasurementSample } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import type { MeasurementHistory } from "./measurements";
import { detectReplayClimateEvents } from "./replayEvents";

const origin = Date.parse("2026-07-18T00:00:00.000Z");

function sample(
  sensorId: string,
  metric: "temperature" | "humidity",
  minute: number,
  value: number,
  quality: MeasurementSample["quality"] = "good",
): MeasurementSample {
  return {
    sensorId,
    metric,
    value,
    canonicalUnit: metric === "temperature" ? "°C" : "%",
    timestamp: new Date(origin + minute * 60_000).toISOString(),
    source: "api",
    quality,
  };
}

function plateau(
  sensorId: string,
  metric: "temperature" | "humidity",
  fromMinute: number,
  toMinute: number,
  value: number,
): MeasurementSample[] {
  const samples: MeasurementSample[] = [];
  for (let minute = fromMinute; minute <= toMinute; minute += 5) {
    samples.push(sample(sensorId, metric, minute, value));
  }
  return samples;
}

function historyFor(sensorId: string, metric: "temperature" | "humidity", samples: MeasurementSample[]): MeasurementHistory {
  return { [sensorId]: { [metric]: samples } };
}

describe("detectReplayClimateEvents", () => {
  it("detects one sustained temperature drop at the first changed raw sample", () => {
    const sensorId = "sensor-entry";
    const history = historyFor(sensorId, "temperature", [
      ...plateau(sensorId, "temperature", 0, 40, 22),
      ...plateau(sensorId, "temperature", 45, 100, 20),
    ]);

    expect(detectReplayClimateEvents(history, [sensorId])).toEqual([expect.objectContaining({
      id: "climate:temperature:drop:sensor-entry:2026-07-18T00:45:00.000Z",
      kind: "climate",
      timestamp: origin + 45 * 60_000,
      sensorId,
      metric: "temperature",
      direction: "drop",
      before: 22,
      after: 20,
      delta: -2,
      significance: "notable",
      autoTags: ["temperature", "drop", "notable"],
    })]);
    expect(detectReplayClimateEvents(history, [sensorId])[0]!.score).toBeCloseTo(2 / 1.5);
  });

  it("classifies normalized magnitude and assigns deterministic metric, direction, and significance tags", () => {
    const sensorId = "sensor-classified";
    const history: MeasurementHistory = {
      [sensorId]: {
        temperature: [
          ...plateau(sensorId, "temperature", 0, 40, 22),
          ...plateau(sensorId, "temperature", 45, 100, 20.4),
        ],
        humidity: [
          ...plateau(sensorId, "humidity", 120, 160, 48),
          ...plateau(sensorId, "humidity", 165, 220, 65),
        ],
      },
    };

    const events = detectReplayClimateEvents(history, [sensorId]);
    expect(events.find((event) => event.metric === "temperature")).toMatchObject({
      significance: "notable",
      autoTags: ["temperature", "drop", "notable"],
    });
    expect(events.find((event) => event.metric === "humidity")).toMatchObject({
      significance: "major",
      autoTags: ["humidity", "rise", "major"],
    });
    expect(detectReplayClimateEvents(history, [sensorId])).toEqual(events);
  });

  it("detects humidity rises and drops as separate episodes", () => {
    const sensorId = "sensor-bathroom";
    const history = historyFor(sensorId, "humidity", [
      ...plateau(sensorId, "humidity", 0, 40, 50),
      ...plateau(sensorId, "humidity", 45, 130, 64),
      ...plateau(sensorId, "humidity", 135, 220, 52),
    ]);

    const events = detectReplayClimateEvents(history, [sensorId]);
    expect(events.map((event) => event.direction)).toEqual(["rise", "drop"]);
    expect(events.map((event) => event.metric)).toEqual(["humidity", "humidity"]);
    expect(events[0]).toMatchObject({ before: 50, after: 64, delta: 14 });
    expect(events[1]).toMatchObject({ before: 64, after: 52, delta: -12 });
  });

  it("rejects isolated spikes and ordinary slow drift", () => {
    const spikeSensor = "sensor-spike";
    const driftSensor = "sensor-drift";
    const spike = plateau(spikeSensor, "temperature", 0, 100, 22)
      .map((point) => point.timestamp === sample(spikeSensor, "temperature", 45, 0).timestamp
        ? { ...point, value: 18 }
        : point);
    const drift = Array.from({ length: 25 }, (_, index) => sample(
      driftSensor,
      "temperature",
      index * 5,
      22 - index * 0.05,
    ));
    const history: MeasurementHistory = {
      [spikeSensor]: { temperature: spike },
      [driftSensor]: { temperature: drift },
    };

    expect(detectReplayClimateEvents(history, [spikeSensor, driftSensor])).toEqual([]);
  });

  it("ignores stale, invalid, mismatched, and duplicate noise deterministically", () => {
    const sensorId = "sensor-clean";
    const valid = [
      ...plateau(sensorId, "temperature", 0, 40, 22),
      ...plateau(sensorId, "temperature", 45, 100, 20),
    ];
    const noisy: MeasurementSample[] = [
      ...valid.slice().reverse(),
      sample(sensorId, "temperature", 10, 22),
      sample(sensorId, "temperature", 10, 22),
      sample(sensorId, "temperature", 25, -40, "stale"),
      { ...sample(sensorId, "temperature", 30, 22), value: Number.NaN },
      { ...sample(sensorId, "temperature", 35, 22), timestamp: "not-a-date" },
      { ...sample("another-sensor", "temperature", 45, -10), sensorId: "another-sensor" },
      { ...sample(sensorId, "humidity", 45, 99), metric: "humidity" },
    ];

    const expected = detectReplayClimateEvents(historyFor(sensorId, "temperature", valid), [sensorId]);
    expect(detectReplayClimateEvents(historyFor(sensorId, "temperature", noisy), [sensorId])).toEqual(expected);
  });

  it("does not bridge a telemetry gap into an invented event", () => {
    const sensorId = "sensor-gap";
    const samples = [
      ...plateau(sensorId, "temperature", 0, 35, 22),
      ...plateau(sensorId, "temperature", 65, 100, 19),
    ];

    expect(detectReplayClimateEvents(historyFor(sensorId, "temperature", samples), [sensorId])).toEqual([]);
  });

  it("clusters overlapping candidates but preserves a later drop after recovery", () => {
    const sensorId = "sensor-heating";
    const samples = [
      ...plateau(sensorId, "temperature", 0, 40, 22),
      ...plateau(sensorId, "temperature", 45, 100, 19.8),
      ...plateau(sensorId, "temperature", 105, 180, 22),
      ...plateau(sensorId, "temperature", 185, 250, 19),
    ];

    const events = detectReplayClimateEvents(historyFor(sensorId, "temperature", samples), [sensorId]);
    expect(events.filter((event) => event.direction === "drop")).toHaveLength(2);
    expect(events.filter((event) => event.direction === "rise")).toHaveLength(1);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });

  it("filters samples to inclusive replay bounds before detecting changes", () => {
    const sensorId = "sensor-windowed";
    const history = historyFor(sensorId, "temperature", [
      ...plateau(sensorId, "temperature", 0, 40, 22),
      ...plateau(sensorId, "temperature", 45, 100, 19),
      ...plateau(sensorId, "temperature", 105, 180, 22),
      ...plateau(sensorId, "temperature", 185, 250, 19),
    ]);

    const events = detectReplayClimateEvents(history, [sensorId], {
      from: origin + 120 * 60_000,
      to: origin + 250 * 60_000,
    });
    expect(events).toEqual([expect.objectContaining({
      timestamp: origin + 185 * 60_000,
      direction: "drop",
    })]);

    // If bounds were applied after detection, the pre-window baseline would
    // incorrectly keep this event alive at the first in-window sample.
    expect(detectReplayClimateEvents(history, [sensorId], {
      from: origin + 45 * 60_000,
      to: origin + 100 * 60_000,
    })).toEqual([]);
    expect(detectReplayClimateEvents(history, [sensorId], {
      from: origin + 100 * 60_000,
      to: origin + 45 * 60_000,
    })).toEqual([]);
  });

  it("caps by normalized magnitude, returns chronological results, and ignores caller sensor order", () => {
    const sensorIds = ["sensor-small", "sensor-medium", "sensor-large"];
    const drops = [1.6, 2.2, 3.1];
    const history: MeasurementHistory = Object.fromEntries(sensorIds.map((sensorId, index) => [sensorId, {
      temperature: [
        ...plateau(sensorId, "temperature", index * 120, index * 120 + 40, 22),
        ...plateau(sensorId, "temperature", index * 120 + 45, index * 120 + 100, 22 - drops[index]!),
      ],
    }]));

    const events = detectReplayClimateEvents(history, sensorIds.slice().reverse(), { maxEvents: 2 });
    expect(events.map((event) => event.sensorId)).toEqual(["sensor-medium", "sensor-large"]);
    expect(events[0]!.timestamp).toBeLessThan(events[1]!.timestamp);
    expect(detectReplayClimateEvents(history, sensorIds, { maxEvents: 0 })).toEqual([]);
  });

  it("applies a conservative default hard cap", () => {
    const sensorIds = Array.from({ length: 30 }, (_, index) => `sensor-${String(index).padStart(2, "0")}`);
    const history: MeasurementHistory = Object.fromEntries(sensorIds.map((sensorId) => [sensorId, {
      humidity: [
        ...plateau(sensorId, "humidity", 0, 40, 65),
        ...plateau(sensorId, "humidity", 45, 100, 50),
      ],
    }]));

    expect(detectReplayClimateEvents(history, sensorIds)).toHaveLength(24);
    expect(detectReplayClimateEvents(history, sensorIds, { maxEvents: 1_000 })).toHaveLength(30);
  });
});
