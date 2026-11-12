import { describe, expect, it } from "vitest";
import type { AdaptiveHourlyEvidence } from "@climate-twin/contracts";
import { auditAdaptiveReadiness, evidenceByHour } from "../src/analytics/adaptive-monitoring/evidence.js";
import { replayAdaptiveBaseline } from "../src/analytics/adaptive-monitoring/replay.js";
import { advanceDeparture, calibrateResiduals, initialDepartureState, interruptDeparture } from "../src/analytics/adaptive-monitoring/residual-policy.js";

const HOUR = 3_600_000;
const policy = { epochId: "epoch-test", dataMode: "live" as const, trustworthyFrom: 0 };
function evidence(hours = 28 * 24): AdaptiveHourlyEvidence[] {
  return Array.from({ length: hours }, (_, index) => ({
    time: index * HOUR, availableAt: (index + 1) * HOUR, value: 20,
    coverage: 1, quality: "good", source: "observed", epochId: policy.epochId, archiveComplete: true,
  }));
}

describe("adaptive evidence readiness", () => {
  it("requires adequate evidence in every chronological week", () => {
    const points = evidence();
    expect(auditAdaptiveReadiness({ evidence: points, policy, evaluatedAt: 672 * HOUR })).toMatchObject({ state: "evaluation-ready", advisoryEligible: false });
    const sparse = points.filter((point) => point.time >= 40 * HOUR);
    const result = auditAdaptiveReadiness({ evidence: sparse, policy, evaluatedAt: 672 * HOUR });
    expect(result.state).toBe("collecting");
    expect(result.blocks[0]!.coverage).toBeLessThan(0.8);
    expect(auditAdaptiveReadiness({ evidence: points, policy, evaluatedAt: 671 * HOUR }).state).toBe("collecting");
  });

  it.each([
    { quality: "estimated" }, { source: "replay" }, { source: "demo" },
    { epochId: "old" }, { archiveComplete: false }, { coverage: 0.79 },
    { availableAt: 0 }, { value: Infinity }, { time: 1 },
  ] as const)("withholds ineligible evidence %j", (patch) => {
    expect(evidenceByHour([{ ...evidence(1)[0]!, ...patch }], policy).size).toBe(0);
  });

  it("fails closed on duplicate hours regardless of ordering", () => {
    const point = evidence(1)[0]!;
    expect(evidenceByHour([point, { ...point, value: 24 }, point], policy).size).toBe(0);
    expect(evidenceByHour([{ ...point, source: "demo" }, point], policy).size).toBe(0);
  });

  it("separates demo and live epochs and respects the trustworthy boundary", () => {
    expect(evidenceByHour(evidence(2), { ...policy, trustworthyFrom: HOUR }).size).toBe(1);
    expect(evidenceByHour(evidence(2), { ...policy, dataMode: "demo" }).size).toBe(0);
  });
});

describe("causal residual policy", () => {
  it("cannot calibrate on future, late or insufficient outcomes", () => {
    const errors = Array.from({ length: 120 }, (_, index) => ({ time: index * HOUR, availableAt: (index + 1) * HOUR, error: 0 }));
    expect(calibrateResiduals({ errors, predictedAt: 120 * HOUR, metric: "temperature" })).toMatchObject({ bias: 0, scale: 0, threshold: 1, count: 120 });
    expect(calibrateResiduals({ errors, predictedAt: 119 * HOUR, metric: "temperature" })).toBeNull();
    errors[0]!.availableAt = 121 * HOUR;
    expect(calibrateResiduals({ errors, predictedAt: 120 * HOUR, metric: "temperature" })).toBeNull();
  });

  it("requires two same-direction breaches and three continuous recovery hours", () => {
    const state = initialDepartureState();
    const score = (time: number, centeredError: number) => advanceDeparture(state, { time: time * HOUR, centeredError, threshold: 1 });
    expect(score(0, 2).opened).toBe(false);
    expect(score(1, -2).opened).toBe(false);
    expect(score(2, 2).opened).toBe(true);
    expect(score(3, 0).resolved).toBe(false);
    interruptDeparture(state);
    expect(state.direction).toBe("higher");
    expect(score(5, 0).resolved).toBe(false);
    expect(score(6, 0).resolved).toBe(false);
    expect(score(7, 0).resolved).toBe(true);
  });

  it("does not join breaches across a missing UTC hour", () => {
    const state = initialDepartureState();
    advanceDeparture(state, { time: 0, centeredError: 2, threshold: 1 });
    expect(advanceDeparture(state, { time: 2 * HOUR, centeredError: 2, threshold: 1 }).opened).toBe(false);
  });
});

describe("fixed-baseline replay", () => {
  const replay = (points: AdaptiveHourlyEvidence[], overrides = {}) => replayAdaptiveBaseline({
    evidence: points, policy, metric: "temperature", baseline: "same-hour-yesterday", from: 0, to: points.length * HOUR, ...overrides,
  });

  it("establishes a quiet baseline without claiming advisory qualification", () => {
    const result = replay(evidence());
    expect(result.candidateEpisodes).toBe(0);
    expect(result.scoredHours).toBeGreaterThan(120);
    expect(result.advisoryEligible).toBe(false);
  });

  it("detects a sustained material step, freezes calibration, and records recovery", () => {
    const points = evidence();
    for (let index = 200; index < 220; index += 1) points[index]!.value += 3;
    const result = replay(points);
    expect(result.points[200]!.calibration?.threshold).toBe(1);
    expect(result.points[201]!.episode).toBe("candidate");
    expect(result.points[210]!.calibration).toEqual(result.points[200]!.calibration);
    expect(result.points.some((point) => point.episode === "resolved")).toBe(true);
  });

  it("does not let future target values alter earlier predictions or calibration", () => {
    const points = evidence();
    const original = replay(points);
    for (const point of points) if (point.time >= 300 * HOUR) point.value += 100;
    expect(replay(points).points.slice(0, 300)).toEqual(original.points.slice(0, 300));
  });

  it("withholds late targets instead of pretending they were available on time", () => {
    const points = evidence();
    points[200]!.availableAt = 250 * HOUR;
    const result = replay(points);
    expect(result.points[200]!.reason).toBe("missing-target");
    expect(result.points[224]!.predicted).toBeNull();
  });

  it("keeps a missing active episode stale and observes context guards", () => {
    const points = evidence();
    for (let index = 200; index < 215; index += 1) points[index]!.value += 3;
    points[203]!.quality = "stale";
    const result = replay(points, { contextTransitions: [206 * HOUR] });
    expect(result.points[203]).toMatchObject({ reason: "missing-target", episode: "stale" });
    expect(result.points[206]!.reason).toBe("context-guard");
    expect(result.points[207]!.reason).toBe("context-guard");
    expect(result.points[208]!.reason).toBeNull();
  });

  it("expires a frozen model after seven days without treating expiry as recovery", () => {
    const points = evidence();
    for (let index = 200; index < points.length; index += 1) points[index]!.value += (index - 199) * 3;
    const result = replay(points);
    expect(result.points[367]!.episode).toBe("candidate");
    expect(result.points[368]).toMatchObject({ episode: "expired", reason: "expired-model" });
    expect(result.points.at(-1)!.episode).toBe("expired");
    expect(result.candidateEpisodes).toBe(1);
  });

  it("keeps model materiality specific to the measurement", () => {
    const points = evidence();
    for (let index = 200; index < 220; index += 1) points[index]!.value += 3;
    expect(replay(points, { metric: "humidity" }).candidateEpisodes).toBe(0);
    expect(replay(points, { metric: "co2" }).candidateEpisodes).toBe(0);
  });

  it("bounds work instead of silently truncating evidence", () => {
    expect(() => replay(evidence(2), { to: 50_001 * HOUR })).toThrow(RangeError);
    expect(() => replay(evidence(2), { from: 1 })).toThrow(RangeError);
  });
});
