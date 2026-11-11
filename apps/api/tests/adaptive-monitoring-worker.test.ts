import { describe, expect, it } from "vitest";
import { adaptiveFinding as findingFixture, adaptiveFixture, adaptiveHour, START } from "./adaptive-monitoring-test-support.js";
import { HOUR } from "../src/analytics/adaptive-monitoring/evidence.js";
import { ownAdaptiveReview, reviewAdaptiveFinding } from "../src/analytics/adaptive-monitoring/reviews.js";


describe("adaptive monitoring worker and review persistence", () => {
  it("captures a closed hour once with coverage and truthful availability time", async () => {
    const f = adaptiveFixture();
    try {
      const now = START + 2 * HOUR + 10 * 60_000;
      f.setNow(now);
      f.database.insertMeasurementSamples(Array.from({ length: 120 }, (_, i) => ({
        sensorId: "sensor-one", metric: "temperature", canonicalUnit: "°C", value: 21,
        timestamp: new Date(START + i * 60_000).toISOString(), source: "home-assistant" as const, quality: "good" as const,
      })));
      await f.service.process(f.stream, new AbortController().signal);
      const hours = f.service.store.hours(f.stream, now);
      expect(hours.find(h => h.time === START + 2 * HOUR)).toMatchObject({ value: 21, availableAt: now, coverage: 1 });
      await f.service.process(f.stream, new AbortController().signal);
      expect(f.service.store.hours(f.stream, now)).toHaveLength(2);
      expect(f.service.store.streams(f.home.id, "live")[0]!.stream.evaluation?.qualified ?? false).toBe(false);
    } finally { f.database.close(); }
  });
  it("abstains on insufficient polling coverage instead of learning a flat zero", async () => {
    const f = adaptiveFixture();
    try {
      const now = START + 2 * HOUR + 10 * 60_000;
      f.setNow(now);
      await f.service.process(f.stream, new AbortController().signal);
      expect(f.service.store.hours(f.stream, now).find(h => h.time === START + 2 * HOUR)?.value).toBeNull();
    } finally { f.database.close(); }
  });
  it("retries reviews idempotently, preserves the candidate, and isolates personal feedback", () => {
    const f = adaptiveFixture();
    try {
      const finding = findingFixture(f);
      f.service.store.saveFinding(finding, f.stream.stream.id, "live");
      const input = { finding, streamId: f.stream.stream.id, mode: "live", actor: "owner-one", now: new Date(START).toISOString(),
        body: { dataMode: "live" as const, baseRevision: 1, idempotencyKey: "review-retry", disposition: "useful" as const, note: "Worth checking" } };
      const first = reviewAdaptiveFinding(f.service.store, input);
      expect(reviewAdaptiveFinding(f.service.store, input)).toEqual(first);
      expect(first.state).toBe("candidate");
      const current = f.service.store.findings(f.home.id, "live")[0]!;
      expect(ownAdaptiveReview(f.service.store, current, "owner-one").review?.disposition).toBe("useful");
      expect(ownAdaptiveReview(f.service.store, current, "owner-two").review).toBeNull();
      reviewAdaptiveFinding(f.service.store, { ...input, finding: current, now: new Date(START - HOUR).toISOString(),
        body: { ...input.body, baseRevision: current.revision, idempotencyKey: "new-review", note: "Latest review despite clock adjustment" } });
      expect(ownAdaptiveReview(f.service.store, current, "owner-one").review?.note).toBe("Latest review despite clock adjustment");
      expect(() => reviewAdaptiveFinding(f.service.store, { ...input, body: { ...input.body, idempotencyKey: "stale-write" } })).toThrow("Refresh");
      expect(() => reviewAdaptiveFinding(f.service.store, { ...input, body: { ...input.body, note: "Different request" } })).toThrow("different review");
    } finally { f.database.close(); }
  });
  it("keeps shadow candidates private and expires them on an explicit baseline reset", () => {
    const f = adaptiveFixture();
    try {
      f.service.store.saveFinding(findingFixture(f), f.stream.stream.id, "live");
      const publicViewer = { actor: "member", admin: false, visibleSensor: () => true };
      expect(f.service.visibleFindings(f.home, "live", publicViewer)).toEqual([]);
      const owner = { ...publicViewer, actor: "test-owner", admin: true };
      expect(f.service.visibleFindings(f.home, "live", owner)).toHaveLength(1);
      f.setNow(START + HOUR);
      f.service.settings(f.home.id, { dataMode: "live", baseRevision: 1, resetBaseline: { sensorId: "sensor-one", reason: "Confirmed sensor move" } }, "test-owner");
      expect(f.service.store.findings(f.home.id, "live")[0]?.state).toBe("expired");
      expect(f.service.store.streams(f.home.id, "live")[0]!.stream.epoch).not.toBe(f.stream.stream.epoch);
    } finally { f.database.close(); }
  });
  it("never overwrites the initial evidence cutoff when a pending future hour is captured", () => {
    const f = adaptiveFixture();
    try {
      const pending = adaptiveHour(2, { value: null });
      f.service.store.saveHour(f.stream, pending, true);
      const observed = { ...pending, value: 21, availableAt: pending.time + 5 * 60_000 };
      f.service.store.saveHour(f.stream, observed);
      expect(f.service.store.hours(f.stream, observed.availableAt)[0]!.predictions).toEqual(pending.predictions);
    } finally { f.database.close(); }
  });
});
