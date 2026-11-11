import { describe, expect, it } from "vitest";
import { HOUR } from "../src/analytics/adaptive-monitoring/evidence.js";
import { adaptiveFixture, adaptiveHour, START } from "./adaptive-monitoring-test-support.js";
import { validateReferenceGroups } from "../src/analytics/adaptive-monitoring/scope.js";
import { adaptivePage } from "../src/analytics/adaptive-monitoring/service.js";
import { isAdaptiveSnapshot } from "@climate-twin/contracts";

describe("adaptive monitoring storage, scope and settings", () => {
  it("starts off, opts into shadow explicitly, and prevents advisory without evidence", () => {
    const f = adaptiveFixture();
    try {
      expect(f.service.store.settings("absent", "live").mode).toBe("off");
      expect(f.settings.mode).toBe("shadow");
      expect(() => f.service.settings(f.home.id, { dataMode: "live", baseRevision: 1, mode: "advisory" }, "test-owner")).toThrow("Prospective evaluation");
      expect(f.service.store.settings(f.home.id, "live").revision).toBe(1);
    } finally { f.database.close(); }
  });
  it("revision-checks settings and rejects cross-mode writes", () => {
    const f = adaptiveFixture();
    try {
      expect(() => f.service.settings(f.home.id, { dataMode: "live", baseRevision: 0, mode: "off" }, "test-owner")).toThrow("Refresh");
      expect(() => f.service.settings(f.home.id, { dataMode: "demo", baseRevision: 1, mode: "off" }, "test-owner")).toThrow("active data mode");
    } finally { f.database.close(); }
  });
  it("fences epochs on sensor moves and leaves renaming in the same epoch", () => {
    const f = adaptiveFixture();
    try {
      f.database.updateSensor("sensor-one", { name: "Bedroom thermometer" });
      f.service.invalidate();
      expect(f.service.store.streams(f.home.id, "live")[0]!.stream.epoch).toBe(f.stream.stream.epoch);
      f.setNow(START + HOUR);
      f.database.updateSensor("sensor-one", { x: 5 });
      f.service.invalidate();
      const moved = f.service.store.streams(f.home.id, "live")[0]!;
      expect(moved.stream.epoch).not.toBe(f.stream.stream.epoch);
      expect(moved.stream.epochStartedAt).toBe(new Date(START + HOUR).toISOString());
      f.database.updateHouse(f.home.id, { floors: [...f.home.floors,
        { ...f.home.floors[0]!, id: "upper-floor", name: "Upper floor", elevation: 3 }] });
      f.database.updateSensor("sensor-one", { floorId: "upper-floor" });
      f.service.invalidate();
      const upstairs = f.service.store.streams(f.home.id, "live")[0]!;
      expect(upstairs.stream.epoch).not.toBe(moved.stream.epoch);
      expect(upstairs.stream.floorId).toBe("upper-floor");
    } finally { f.database.close(); }
  });
  it("creates durable single-hour job claims and makes successful retries no-ops", () => {
    const f = adaptiveFixture();
    try {
      const args = { hour: START + HOUR, revision: 1, now: START };
      const id = f.service.store.claim(f.stream, args)!;
      expect(id).toBeTruthy();
      expect(f.service.store.claim(f.stream, args)).toBeNull();
      f.service.store.finishJob(id, "succeeded", new Date(START).toISOString());
      expect(f.service.store.claim(f.stream, { ...args, now: START + 3 * HOUR })).toBeNull();
    } finally { f.database.close(); }
  });
  it("does not rewrite an already-issued pending prediction on restart", () => {
    const f = adaptiveFixture();
    try {
      const h = adaptiveHour(1, { value: null });
      f.service.store.saveHour(f.stream, h, true);
      f.service.store.saveHour(f.stream, { ...h, predictions: {} }, true);
      expect(f.service.store.hours(f.stream, START + HOUR)[0]?.predictions).toEqual(h.predictions);
    } finally { f.database.close(); }
  });
  it("cannot count one physical source twice as independent references", () => {
    const f = adaptiveFixture();
    try {
      const target = f.database.getSensor("sensor-one")!;
      const duplicate = { ...target, id: "duplicate" };
      expect(() => validateReferenceGroups([{ sensorId: target.id, peerIds: [duplicate.id], designatedReference: true }], [target, duplicate]))
        .toThrow("distinct physical");
    } finally { f.database.close(); }
  });
  it("returns a validated collecting state and scopes pagination to the snapshot", () => {
    const f = adaptiveFixture();
    try {
      const viewer = { actor: "test-owner", admin: true, visibleSensor: () => true };
      const snapshot = f.service.snapshot(f.home, { mode: "live", viewer });
      expect(isAdaptiveSnapshot(snapshot)).toBe(true);
      expect(snapshot.state).toBe("collecting");
      const page = adaptivePage([{ id: "a" }, { id: "b" }], { binding: ["home-a"], limit: 1 });
      expect(() => adaptivePage([{ id: "b" }], { binding: ["home-b"], cursor: page.nextCursor!, limit: 1 })).toThrow("Refresh");
    } finally { f.database.close(); }
  });
});
