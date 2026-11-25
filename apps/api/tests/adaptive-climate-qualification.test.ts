import { describe, expect, it } from "vitest";
import type { AdaptiveHourlyEvidence } from "@climate-twin/contracts";
import { CausalClimatePredictor, climateBaselines, outdoorHours, tuneClimatePolicies } from "../src/analytics/adaptive-monitoring/climate-prediction.js";
import { qualifyAdaptiveClimateModel } from "../src/analytics/adaptive-monitoring/climate-qualification.js";
import { evidenceByHour } from "../src/analytics/adaptive-monitoring/evidence.js";
import { HOUR_MS } from "../src/analytics/forecast/models.js";

const start = Date.parse("2026-02-01T00:00:00Z");
const hoursPerWeek = 168;
const week = hoursPerWeek * HOUR_MS;
const epochId = "synthetic-climate-epoch";
const policy = { epochId, dataMode: "live", trustworthyFrom: start } as const;
const evaluatedAt = start + 4 * week;

function fixture(value: (index: number) => number = (index) =>
  18 + index / 48 + 4 * Math.sin(index * Math.PI / 12)): AdaptiveHourlyEvidence[] {
  return Array.from({ length: 4 * hoursPerWeek }, (_, index) => ({
    time: start + index * HOUR_MS, availableAt: start + (index + 1) * HOUR_MS + 2_000,
    value: value(index), coverage: 1, quality: "good", source: "observed", epochId, archiveComplete: true,
  }));
}

function qualify(evidence: AdaptiveHourlyEvidence[]) {
  return qualifyAdaptiveClimateModel({ evidence, policy, metric: "temperature", evaluatedAt });
}

describe("Adaptive Home climate qualification", () => {
  it("requires four independently usable chronological blocks and cannot borrow late evidence", () => {
    const evidence = fixture();
    const early = qualifyAdaptiveClimateModel({ evidence, policy, metric: "temperature", evaluatedAt: evaluatedAt - 1 });
    expect(early).toMatchObject({ state: "collecting", advisoryEligible: false });
    const late = evidence.map((point, index) => index < 34
      ? { ...point, availableAt: evaluatedAt - HOUR_MS }
      : point);
    const result = qualify(late);
    expect(result).toMatchObject({ state: "collecting", reason: "evidence-coverage" });
    expect(result.blocks[0]!.usableHours).toBe(133);
  });

  it("selects and calibrates on matching earlier evidence regardless of the held-out targets", () => {
    const evidence = fixture();
    const changed = evidence.map((point, index) => index >= 3 * hoursPerWeek
      ? { ...point, value: point.value + (index % 3 === 0 ? 20 : -8) }
      : point);
    const reference = qualify(evidence);
    const modified = qualify(changed);
    expect(reference.candidates[0]?.policy.kind).toBe("daily-profile");
    expect(modified.candidates).toEqual(reference.candidates);
    expect(reference.evaluation?.calibration?.count).toBeGreaterThanOrEqual(120);
    expect(modified.evaluation?.calibration).toEqual(reference.evaluation?.calibration);
    expect(modified.evaluation?.holdout.modelMae).not.toBe(reference.evaluation?.holdout.modelMae);
    expect(reference.evaluation?.holdout.pairedHours).toBe(167);
    expect(reference).toMatchObject({ state: "technical-pass", advisoryEligible: false, evaluation: {
      range: { insideHours: 167, scoredHours: 167, leaveOneDayOut: { days: 7, low: 1, high: 1 } },
    } });
    expect(modified.advisoryEligible).toBe(false);
  });

  it("rejects inadequate empirical range coverage even when the point forecasts beat both baselines", () => {
    const evidence = fixture((index) =>
      18 + index / 32 + 2 * Math.sin(index * Math.PI / 12) + ([520, 560].includes(index) ? 5 : 0));
    const result = qualify(evidence);
    expect(result).toMatchObject({ state: "rejected", reason: "holdout-range-coverage", advisoryEligible: false });
    expect(result.evaluation?.holdout.gainAgainstBestBaseline).toBeGreaterThan(0.05);
    expect(result.evaluation?.range.coverage).toBeLessThan(0.95);
    expect(result.evaluation?.range.leaveOneDayOut?.low).toBeLessThan(result.evaluation?.range.leaveOneDayOut?.high ?? 0);
  });

  it("does not use a recent target or the same hour yesterday before its sealed availability", () => {
    const at = start + week + HOUR_MS;
    const evidence = fixture();
    const changed = evidence.map((point) => point.time === at - HOUR_MS || point.time >= at
      ? { ...point, value: 10_000 }
      : point);
    const initial = { target: evidenceByHour(evidence, policy), outdoor: new Map() };
    const variant = { ...initial, target: evidenceByHour(changed, policy) };
    const selected = tuneClimatePolicies(initial, "temperature", start + week)[0]!;
    expect(climateBaselines(initial.target, at).persistence).toBe(initial.target.get(at - 2 * HOUR_MS)?.value);
    const predicted = new CausalClimatePredictor(initial, selected).predict(at);
    expect(predicted).toBeTypeOf("number");
    expect(new CausalClimatePredictor(variant, selected).predict(at)).toBe(predicted);
    const delayedYesterday = new Map(initial.target);
    const yesterday = initial.target.get(at - 24 * HOUR_MS)!;
    delayedYesterday.set(yesterday.time, { ...yesterday, availableAt: at + 1 });
    expect(climateBaselines(delayedYesterday, at).seasonal).toBeNull();
  });

  it("tunes a thermal candidate from timely outdoor observations and ignores later weather at prediction time", () => {
    const outdoor = fixture((index) => 4 + 9 * Math.sin(index / 26))
      .map(({ time, value, availableAt }) => ({ time, value, availableAt }));
    let indoor = 17;
    const evidence = fixture((index) => {
      indoor = 0.85 * indoor + 0.15 * (outdoor[index]!.value + 12);
      return indoor;
    });
    const target = evidenceByHour(evidence, policy);
    const normal = { target, outdoor: outdoorHours(outdoor) };
    const delayed = { target, outdoor: outdoorHours(outdoor.map((point) => ({ ...point, availableAt: evaluatedAt }))) };
    const thermal = tuneClimatePolicies(normal, "temperature", start + week).find((model) => model.kind === "thermal-relaxation")!;
    expect(thermal?.kind).toBe("thermal-relaxation");
    expect(tuneClimatePolicies(delayed, "temperature", start + week).map((model) => model.kind)).toEqual(["daily-profile"]);
    const at = start + 2 * week + 7 * HOUR_MS;
    const changed = { target, outdoor: outdoorHours(outdoor.map((point) =>
      point.availableAt > at ? { ...point, value: 900 } : point)) };
    const forecast = new CausalClimatePredictor(normal, thermal).predict(at);
    expect(forecast).toBeTypeOf("number");
    expect(new CausalClimatePredictor(changed, thermal).predict(at)).toBe(forecast);
  });

  it("requires improvement over both baselines on the same hours and honors timely context guards", () => {
    const flat = qualify(fixture(() => 20));
    expect(flat).toMatchObject({ state: "rejected", reason: "holdout-forecast-skill", evaluation: {
      holdout: { persistenceMae: 0, seasonalMae: 0, gainAgainstBestBaseline: null },
    } });
    const periodic = qualify(fixture((index) => 20 + Math.sin(index * Math.PI / 12)));
    expect(periodic).toMatchObject({ state: "rejected", reason: "holdout-forecast-skill", evaluation: {
      holdout: { gainAgainstBestBaseline: null },
    } });
    const evidence = fixture();
    const event = start + 3 * week + 10 * HOUR_MS;
    const timely = qualifyAdaptiveClimateModel({
      evidence, policy, metric: "temperature", evaluatedAt,
      contextTransitions: [{ occurredAt: event, availableAt: event + 500 }],
    });
    const delayed = qualifyAdaptiveClimateModel({
      evidence, policy, metric: "temperature", evaluatedAt,
      contextTransitions: [{ occurredAt: event, availableAt: event + 3 * HOUR_MS }],
    });
    expect(timely.evaluation?.holdout.eligibleHours).toBe(165);
    expect(delayed.evaluation?.holdout.eligibleHours).toBe(167);
    expect(timely.evaluation?.range.width).toBeGreaterThan(0);
  });
});
