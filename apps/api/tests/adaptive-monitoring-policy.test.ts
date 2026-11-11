import { describe, expect, it } from "vitest";
import { analyseAdaptiveHour, predictAdaptiveHour } from "../src/analytics/adaptive-monitoring/policy.js";
import { DAY, HOUR } from "../src/analytics/adaptive-monitoring/evidence.js";
import { adaptiveFixture, adaptiveHour, qualifiedStream, START } from "./adaptive-monitoring-test-support.js";

describe("causal adaptive monitoring policy", () => {
  it("qualifies only after all four chronological blocks have enough scored evidence", () => {
    const f = adaptiveFixture();
    try {
      const history = Array.from({ length: 671 }, (_, i) => adaptiveHour(i + 1));
      const result = analyseAdaptiveHour(f.stream, { hours: history, current: adaptiveHour(672) });
      expect(result.evaluation).toMatchObject({ qualified: true, holdoutHours: 168 });
      const early = analyseAdaptiveHour(f.stream, { hours: history.slice(0, 600), current: adaptiveHour(601) });
      expect(early.evaluation?.qualified).toBe(false);
    } finally { f.database.close(); }
  });
  it("withholds qualification when forecasts did not beat the simpler baseline", () => {
    const f = adaptiveFixture();
    try {
      const history = Array.from({ length: 671 }, (_, i) => adaptiveHour(i + 1, { seasonal: 20, persistence: 20 }));
      const result = analyseAdaptiveHour(f.stream, { hours: history, current: adaptiveHour(672, {
        persistence: adaptiveHour(672).value, seasonal: adaptiveHour(672).value,
      }) });
      expect(result.evaluation).not.toBeNull();
      const flat = history.map(h => ({ ...h, persistence: h.value, seasonal: h.value }));
      expect(analyseAdaptiveHour(f.stream, { hours: flat, current: adaptiveHour(672) }).evaluation?.qualified).toBe(false);
    } finally { f.database.close(); }
  });
  it("does not select a family using incomplete selection data or future predictions", () => {
    const f = adaptiveFixture();
    try {
      const hours = Array.from({ length: 300 }, (_, i) => adaptiveHour(i + 1));
      expect(analyseAdaptiveHour(f.stream, { hours, current: adaptiveHour(301) }).selected).toBeNull();
      const leaked = Array.from({ length: 671 }, (_, i) => {
        const h = adaptiveHour(i + 1);
        return { ...h, predictions: { "daily-profile": { value: h.value!, madeAt: h.time, cutoff: h.time } } };
      });
      expect(analyseAdaptiveHour(f.stream, { hours: leaked, current: adaptiveHour(672) }).evaluation?.qualified ?? false).toBe(false);
    } finally { f.database.close(); }
  });
  it("finds a persistent departure while freezing calibration before the first breach", () => {
    const f = adaptiveFixture();
    try {
      let stored = qualifiedStream(f.stream);
      const hours = Array.from({ length: 672 }, (_, i) => adaptiveHour(i + 1));
      const first = adaptiveHour(673); first.value! += 4;
      const a = analyseAdaptiveHour(stored, { hours, current: first });
      expect(a.direction).toBeNull();
      expect(a.hour.excluded).toBe(true);
      stored = { ...stored, runtime: a.runtime };
      const second = adaptiveHour(674); second.value! += 4;
      const b = analyseAdaptiveHour(stored, { hours: [...hours, a.hour], current: second });
      expect(b.direction).toBe("high");
      expect(b.runtime.calibrationBefore).toBe(first.time);
      expect(b.hour.score!.threshold).toBe(1);
    } finally { f.database.close(); }
  });
  it("does not bridge gaps or call missing evidence a recovery", () => {
    const f = adaptiveFixture();
    try {
      const stored = qualifiedStream(f.stream);
      const hours = Array.from({ length: 672 }, (_, i) => adaptiveHour(i + 1));
      const current = adaptiveHour(674, { value: null, score: null });
      const r = analyseAdaptiveHour(stored, { hours, current });
      expect(r.direction).toBeNull(); expect(r.recovered).toBe(false);
      const guarded = analyseAdaptiveHour(stored, { hours, current: adaptiveHour(673, { guarded: true }) });
      expect(guarded.hour.score).toBeNull();
    } finally { f.database.close(); }
  });
  it("requires three contiguous recovered hours and expires a frozen model", () => {
    const f = adaptiveFixture();
    try {
      const stored = qualifiedStream(f.stream);
      const hours = Array.from({ length: 672 }, (_, i) => adaptiveHour(i + 1));
      expect(analyseAdaptiveHour(stored, { hours, current: adaptiveHour(673) }).recovered).toBe(true);
      const frozen = { ...stored, runtime: { ...stored.runtime, frozenAt: START, calibrationBefore: START } };
      const r = analyseAdaptiveHour(frozen, { hours: [], current: adaptiveHour(673) });
      expect(r.state).toBe("stale");
    } finally { f.database.close(); }
  });
  it("ignores late/future evidence during prediction and never fits a thermal model to humidity", () => {
    const hours = Array.from({ length: 120 }, (_, i) => adaptiveHour(i + 1, { predictions: {} }));
    const until = START + 120 * HOUR + 10 * 60_000;
    const original = predictAdaptiveHour({ metric: "humidity", hours, until, frozenAt: null });
    const future = adaptiveHour(200, { value: 1000, availableAt: until - 1 });
    const late = adaptiveHour(121, { value: 1000, availableAt: until + DAY });
    expect(predictAdaptiveHour({ metric: "humidity", hours: [...hours, future, late], until, frozenAt: null })).toEqual(original);
    expect(original["thermal-relaxation"]).toBeUndefined();
    expect(original["daily-profile"]?.madeAt).toBe(until);
  });
});
