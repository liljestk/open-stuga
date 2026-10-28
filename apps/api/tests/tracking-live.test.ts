import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { TrackingFeatureFlags } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiErrorMiddleware } from "../src/app/error-handling.js";
import { ClimateDatabase } from "../src/db.js";
import { TrackingSecretBox } from "../src/tracking/crypto.js";
import { registerTrackingLiveRoutes } from "../src/tracking/routes-live.js";
import { TrackingService } from "../src/tracking/service.js";
import { TrackingError, TrackingStore } from "../src/tracking/store.js";

const NOW = new Date("2026-10-28T08:00:00.000Z");
const flags: TrackingFeatureFlags = {
  "tracking.enabled": true,
  "tracking.mobileObserver.enabled": true,
  "tracking.mobileObserver.iosBackground.enabled": false,
  "tracking.mobileObserver.androidBackground.enabled": false,
  "tracking.androidGatewayMode.enabled": false,
  "tracking.liveMap.enabled": true,
  "tracking.movementTrails.enabled": false,
  "tracking.exitAlerts.enabled": false,
  "tracking.userLocationSharing.enabled": true,
};

function locationInput(sharingForMs: number, at = NOW) {
  return {
    coordinate: { latitude: 60.1701, longitude: 24.9301 },
    horizontalAccuracyMeters: 12,
    reducedAccuracy: false,
    capturedAt: at.toISOString(),
    sharingUntil: new Date(at.getTime() + sharingForMs).toISOString(),
  };
}

let database: ClimateDatabase;
let store: TrackingStore;

beforeEach(() => {
  database = new ClimateDatabase(":memory:", false);
  database.createAreaEquipment({ id: "equipment-ladder", propertyId: "property-main", name: "Ladder", kind: "tool" });
  store = new TrackingStore(database, new TrackingSecretBox(randomBytes(32)));
});

afterEach(() => database.close());

describe("member location sharing", () => {
  it("reads a shared location back until its sharing window ends", () => {
    store.people.upsertMemberLocation("property-main", "user-1", "Alex", locationInput(30 * 60_000), NOW);
    expect(store.people.memberLocations("property-main", NOW)).toEqual([
      expect.objectContaining({ memberLabel: "Alex", coordinate: { latitude: 60.1701, longitude: 24.9301 } }),
    ]);
    const afterWindow = new Date(NOW.getTime() + 31 * 60_000);
    expect(store.people.memberLocations("property-main", afterWindow)).toEqual([]);
    expect(store.people.removeExpiredMemberLocations(afterWindow)).toHaveLength(1);
    expect(store.people.memberLocations("property-main", NOW)).toEqual([]);
  });

  it("hides a location that stopped updating for 90 seconds even inside its window", () => {
    store.people.upsertMemberLocation("property-main", "user-1", "Alex", locationInput(60 * 60_000), NOW);
    expect(store.people.memberLocations("property-main", new Date(NOW.getTime() + 89_000))).toHaveLength(1);
    expect(store.people.memberLocations("property-main", new Date(NOW.getTime() + 91_000))).toEqual([]);
  });

  it("refuses a sharing window that has ended or lasts beyond 24 hours", () => {
    for (const sharingForMs of [-1_000, 25 * 60 * 60_000]) {
      expect(() => store.people.upsertMemberLocation("property-main", "user-1", "Alex", locationInput(sharingForMs), NOW))
        .toThrow(expect.objectContaining({ status: 422, code: "INVALID_SHARING_WINDOW" }));
    }
  });
});

describe("equipment loans", () => {
  it("lets one member borrow equipment at a time and returns a loan idempotently", () => {
    const loan = store.people.borrowEquipment("equipment-ladder", "user-1", "Alex", {}, NOW);
    expect(() => store.people.borrowEquipment("equipment-ladder", "user-2", "Sam", {}, NOW))
      .toThrow(expect.objectContaining({ status: 409, code: "EQUIPMENT_ALREADY_BORROWED" }));
    const returned = store.people.returnEquipment(loan.id, "user-1", "Alex", {}, new Date(NOW.getTime() + 60_000));
    expect(returned.returnedAt).toBe("2026-10-28T08:01:00.000Z");
    expect(store.people.returnEquipment(loan.id, "user-2", "Sam", { note: "again" }, new Date(NOW.getTime() + 120_000)))
      .toEqual(returned);
    expect(store.people.borrowEquipment("equipment-ladder", "user-2", "Sam", {}, NOW).borrowerLabel).toBe("Sam");
  });

  it("rejects a return time in the past and unknown equipment", () => {
    expect(() => store.people.borrowEquipment("equipment-ladder", "user-1", "Alex", { expectedReturnAt: "2026-10-27T08:00:00.000Z" }, NOW))
      .toThrow(expect.objectContaining({ status: 422, code: "INVALID_RETURN_TIME" }));
    expect(() => store.people.borrowEquipment("equipment-missing", "user-1", "Alex", {}, NOW)).toThrow(TrackingError);
  });
});

describe("tracking stream", () => {
  let server: Server;

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("ends with an authorization event once the viewer loses access to the Property", async () => {
    const service = new TrackingService(store, { flags });
    let authorized = true;
    const app = express();
    registerTrackingLiveRoutes(app, {
      service,
      principal: () => ({ userId: "user-1", label: "Alex", role: "member" }),
      machineObserver: () => null,
      authorizeProperty: () => authorized,
      authorizeEquipment: () => true,
      assertPropertyWriteAllowed: () => undefined,
    });
    app.use(apiErrorMiddleware(() => undefined));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/properties/property-main/tracking-stream`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("event: ready")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before it was ready");
      received += decoder.decode(value, { stream: true });
    }

    authorized = false;
    service.shareMemberLocation("property-main", "user-1", "Alex", locationInput(30 * 60_000, new Date()));
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    expect(received).toContain("event: authorization");
    expect(received).not.toContain("event: member.location.updated");
  });
});
