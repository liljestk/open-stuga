import type { MeasurementSample } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import {
  appendEvidenceRun,
  buildHeatPumpExclusionWindow,
  filterHeatPumpAffectedSamples,
  isPassiveHeatPumpTime,
  loadHeatPumpExclusionWindow,
  type HeatPumpEvidencePoint,
} from "../src/analytics/heat-pump-evidence.js";
import { ClimateDatabase } from "../src/db.js";

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

describe("heat-pump evidence runs", () => {
  const classes = ["off", "confirmed-active", "possible-active", "unknown"] as const;

  /** Seeded generator for reproducible poll sequences. */
  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  it.each(Array.from({ length: 40 }, (_, seed) => seed + 1))(
    "gives the same window from runs as from every poll (sequence %i)",
    (seed) => {
      const random = generator(seed);
      const points: HeatPumpEvidencePoint[] = [];
      for (const connectionId of ["heat-pump-1", "heat-pump-2"]) {
        let time = Date.parse(FROM) - 40 * MINUTE_MS;
        let classification: HeatPumpEvidencePoint["classification"] = "off";
        while (time < Date.parse(TO) + 10 * MINUTE_MS) {
          // Mostly steady polling with occasional state changes, blips and outages.
          if (random() < 0.15) classification = classes[Math.floor(random() * classes.length)]!;
          const blip = random() < 0.05;
          points.push({ connectionId, time, classification: blip ? "unknown" : classification });
          time += random() < 0.04 ? (6 + random() * 20) * MINUTE_MS : (0.5 + random() * 2) * MINUTE_MS;
        }
      }
      const runs = new Map<string, HeatPumpEvidencePoint[]>();
      for (const point of [...points].sort((left, right) => left.time - right.time)) {
        const series = runs.get(point.connectionId) ?? [];
        runs.set(point.connectionId, series);
        appendEvidenceRun(series, point);
      }
      const common = { from: FROM, to: TO, connectionIds: ["heat-pump-1", "heat-pump-2"] };
      const fromPolls = buildHeatPumpExclusionWindow({ ...common, points });
      const fromRuns = buildHeatPumpExclusionWindow({ ...common, points: [...runs.values()].flat() });
      expect(fromRuns).toEqual(fromPolls);
      expect([...runs.values()].flat().length).toBeLessThan(points.length);
    },
  );

  it("reads polls in time order and finds the same passive time as before", () => {
    const database = new ClimateDatabase(":memory:");
    try {
      const insert = database.db.prepare(`INSERT INTO heat_pump_state_history
        (connection_id, house_id, observed_at, received_at, state_json) VALUES (?, 'house-main', ?, ?, ?)`);
      // Inserted newest first: the read must not depend on insertion order.
      for (let minute = 280; minute >= -40; minute -= 1) {
        const observedAt = new Date(Date.parse(FROM) + minute * MINUTE_MS).toISOString();
        const running = minute >= 60 && minute < 90;
        insert.run("heat-pump-1", observedAt, observedAt, JSON.stringify({ available: true, power: running ? 1 : 0, compressorFrequencyHz: running ? 40 : 0 }));
      }
      const window = loadHeatPumpExclusionWindow(database, "house-main", FROM, TO, ["heat-pump-1"]);
      expect(window.summary.truncated).toBe(false);
      expect(window.summary.confirmedActiveHours).toBe(0.5);
      expect(window.passiveIntervals).toEqual([
        { fromMs: Date.parse(FROM), toMs: Date.parse(FROM) + 55 * MINUTE_MS },
        { fromMs: Date.parse(FROM) + 120 * MINUTE_MS, toMs: Date.parse(TO) },
      ]);
    } finally {
      database.close();
    }
  });
});

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

  it("ignores a stale current row after its heat pump is disconnected", () => {
    const database = new ClimateDatabase(":memory:", false);
    database.createHouse({ id: "home-a", name: "Home A", timezone: "UTC", floors: [] });
    const observedAt = "2026-07-01T00:00:00.000Z";
    database.db.prepare(`INSERT INTO heat_pump_state_current (
      connection_id, house_id, observed_at, received_at, state_json
    ) VALUES (?, ?, ?, ?, ?)`).run(
      "heat-pump-1",
      "home-a",
      observedAt,
      observedAt,
      JSON.stringify({ available: false, power: false, compressorFrequencyHz: null }),
    );

    expect(loadHeatPumpExclusionWindow(database, "home-a", FROM, TO, []).summary)
      .toMatchObject({ evidenceState: "not-present", heatPumpCount: 0 });
    expect(loadHeatPumpExclusionWindow(
      database,
      "home-a",
      FROM,
      TO,
      ["heat-pump-1"],
    ).summary).toMatchObject({ evidenceState: "insufficient", heatPumpCount: 1 });
    database.close();
  });

  it("retains a disconnected heat pump's historical exclusions without treating it as permanently unknown", () => {
    const database = new ClimateDatabase(":memory:", false);
    database.createHouse({ id: "home-a", name: "Home A", timezone: "UTC", floors: [] });
    const insert = database.db.prepare(`INSERT INTO heat_pump_state_history (
      connection_id, house_id, observed_at, received_at, state_json
    ) VALUES (?, ?, ?, ?, ?)`);
    for (const [observedAt, state] of [
      ["2026-08-01T00:30:00.000Z", { available: true, power: false, compressorFrequencyHz: 0 }],
      ["2026-08-01T01:00:00.000Z", { available: true, power: true, compressorFrequencyHz: 18 }],
      ["2026-08-01T01:30:00.000Z", { available: false, power: true, compressorFrequencyHz: 18 }],
    ] as const) {
      insert.run("heat-pump-1", "home-a", observedAt, observedAt, JSON.stringify(state));
    }

    const window = loadHeatPumpExclusionWindow(database, "home-a", FROM, TO, []);
    expect(window.summary).toMatchObject({
      evidenceState: "partial",
      heatPumpCount: 1,
      confirmedActiveHours: 0.08,
    });
    expect(isPassiveHeatPumpTime(window, "2026-08-01T01:02:00.000Z")).toBe(false);
    expect(isPassiveHeatPumpTime(window, "2026-08-01T03:00:00.000Z")).toBe(true);
    database.close();
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

  it("bridges sub-gap unavailability blips bracketed by verified-off evidence", () => {
    // One ~2-second "unknown" flap per poll cycle, the pattern a
    // reconnect-per-poll cloud transport journals. Padding every blip used to
    // exclude the entire window even though the pump was verifiably off.
    const points: HeatPumpEvidencePoint[] = Array.from({ length: 276 }, (_, index) => index - 35)
      .flatMap((minute) => [
        {
          connectionId: "heat-pump-1",
          time: Date.parse(FROM) + minute * MINUTE_MS + 30_000,
          classification: "unknown" as const,
        },
        {
          connectionId: "heat-pump-1",
          time: Date.parse(FROM) + minute * MINUTE_MS + 32_000,
          classification: "off" as const,
        },
      ]);
    const window = buildHeatPumpExclusionWindow({
      from: FROM,
      to: TO,
      connectionIds: ["heat-pump-1"],
      points,
    });
    expect(window.summary).toMatchObject({
      policy: "verified-heat-pump-off-v2",
      evidenceState: "complete",
      classifiedPercent: 100,
      verifiedOffHours: 4,
      unknownHours: 0,
      usableHours: 4,
      excludedHours: 0,
    });
    expect(isPassiveHeatPumpTime(window, "2026-08-01T02:00:01.000Z")).toBe(true);
  });

  it("keeps unknown segments longer than the state gap or beside activity excluded", () => {
    const longGap = buildHeatPumpExclusionWindow({
      from: FROM,
      to: TO,
      connectionIds: ["heat-pump-1"],
      // Verified off except a sixteen-minute reporting hole from minute 120;
      // after the five-minute state-gap extension an eleven-minute stretch
      // stays unclassified, which is beyond what off evidence may bridge.
      points: minutePoints(() => "off", (minute) => minute < 120 || minute >= 135),
    });
    expect(longGap.summary.evidenceState).toBe("partial");
    expect(longGap.summary.unknownHours).toBeGreaterThan(0);
    expect(isPassiveHeatPumpTime(longGap, "2026-08-01T02:03:00.000Z")).toBe(false);

    const besideActivity = buildHeatPumpExclusionWindow({
      from: FROM,
      to: TO,
      connectionIds: ["heat-pump-1"],
      points: minutePoints((minute) => (
        minute === 120 ? "unknown" : minute >= 121 && minute < 130 ? "confirmed-active" : "off"
      )),
    });
    expect(besideActivity.summary.unknownHours).toBeGreaterThan(0);
    expect(isPassiveHeatPumpTime(besideActivity, "2026-08-01T02:00:30.000Z")).toBe(false);
  });

  it("never trusts reporting silence beyond the state gap, even between off reports", () => {
    // Off reports at minutes 119 and 128 with nothing journaled between them:
    // the first report's five-minute reach ends at minute 124 and the rest of
    // the silence stays unclassified, exactly as the state-gap rule intends.
    const window = buildHeatPumpExclusionWindow({
      from: FROM,
      to: TO,
      connectionIds: ["heat-pump-1"],
      points: minutePoints(() => "off", (minute) => minute < 120 || minute >= 128),
    });
    expect(window.summary.evidenceState).toBe("partial");
    expect(window.summary.unknownHours).toBeCloseTo(4 / 60, 2);
    expect(isPassiveHeatPumpTime(window, "2026-08-01T02:05:00.000Z")).toBe(false);
  });

  it("bridges an unavailability blip only when its off reports are at most one state gap apart", () => {
    const build = (nextOffMinute: number) => buildHeatPumpExclusionWindow({
      from: FROM,
      to: TO,
      connectionIds: ["heat-pump-1"],
      points: minutePoints(
        (minute) => (minute === 120 ? "unknown" : "off"),
        (minute) => minute <= 120 || minute >= nextOffMinute,
      ),
    });
    // Off at 119, unavailable at 120, off again at 124: silence of the same
    // length would have been trusted, so the blip is too.
    expect(build(124).summary).toMatchObject({ evidenceState: "complete", unknownHours: 0 });
    expect(isPassiveHeatPumpTime(build(124), "2026-08-01T02:02:00.000Z")).toBe(true);
    // Off again only at 125, six minutes after the previous off report: the
    // stretch beyond that report's reach stays unclassified and excluded.
    expect(build(125).summary.evidenceState).toBe("partial");
    expect(build(125).summary.unknownHours).toBeGreaterThan(0);
    expect(isPassiveHeatPumpTime(build(125), "2026-08-01T02:02:00.000Z")).toBe(false);
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
