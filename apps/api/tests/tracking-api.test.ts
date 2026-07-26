import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";
import {
  encodeTrackingAdvertisement,
  trackingEpochCounter,
  TRACKING_FLAGS,
} from "../src/tracking/protocol.js";
import { TrackingSecretBox } from "../src/tracking/crypto.js";
import { TrackingStore } from "../src/tracking/store.js";

describe("property equipment tracking API", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    const database = new ClimateDatabase(":memory:", false);
    database.createPropertyArea({
      id: "zone-tool-shed",
      propertyId: "property-main",
      name: "Tool shed",
      kind: "building",
      polygon: [
        { latitude: 60.1700, longitude: 24.9300 },
        { latitude: 60.1700, longitude: 24.9304 },
        { latitude: 60.1703, longitude: 24.9304 },
        { latitude: 60.1703, longitude: 24.9300 },
      ],
    });
    database.createAreaEquipment({
      id: "equipment-chainsaw",
      propertyId: "property-main",
      areaId: "zone-tool-shed",
      name: "Chainsaw",
      kind: "tool",
    });
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        TRACKING_ENABLED: "true",
        TRACKING_MOBILE_OBSERVER_ENABLED: "true",
        TRACKING_IOS_BACKGROUND_ENABLED: "true",
        TRACKING_ANDROID_BACKGROUND_ENABLED: "true",
        TRACKING_ANDROID_GATEWAY_MODE_ENABLED: "true",
        TRACKING_LIVE_MAP_ENABLED: "true",
        TRACKING_EXIT_ALERTS_ENABLED: "true",
        TRACKING_USER_LOCATION_SHARING_ENABLED: "true",
        TRACKING_EXPERIMENTAL_COORDINATE_INFERENCE_ENABLED: "true",
      }),
      database,
      startBackground: false,
    });
  });

  afterEach(() => runtime.close());

  it("ingests authenticated evidence and distinguishes zone, nearby, duplicate, and rejected states", async () => {
    const provisioned = await request(runtime.app)
      .post("/api/v1/tracking/tags")
      .send({
        propertyId: "property-main",
        serialNumber: "TAG-0001",
        hardwareModel: "stugu-motion-v1",
        capabilities: { motion: true, battery: true },
      })
      .expect(201);
    const tagId = provisioned.body.tag.id as string;
    const secretValue = provisioned.body.provisioningSecret as string;
    const secret = Buffer.from(secretValue, "base64url");
    expect(secret).toHaveLength(32);

    await request(runtime.app)
      .post(`/api/v1/tracking/tags/${tagId}/claim`)
      .send({})
      .expect(200);
    await request(runtime.app)
      .post(`/api/v1/tracking/tags/${tagId}/assign`)
      .send({ equipmentId: "equipment-chainsaw" })
      .expect(201);

    const gatewayRegistration = await request(runtime.app)
      .post("/api/v1/tracking/observers/register")
      .send({
        propertyId: "property-main",
        type: "linux-gateway",
        name: "Tool shed gateway",
        zoneId: "zone-tool-shed",
      })
      .expect(201);
    const gatewayId = gatewayRegistration.body.observer.id as string;
    const gatewayCredential = gatewayRegistration.body.credential as string;
    await request(runtime.app)
      .post("/api/v1/tracking/observations:batch")
      .set("Authorization", `Bearer ${gatewayCredential}`)
      .send({ observations: [], padding: "x".repeat(300 * 1024) })
      .expect(413)
      .expect({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body exceeds the 256 KiB limit",
        },
      });
    await request(runtime.app)
      .post(`/api/v1/tracking/observers/${gatewayId}/heartbeat`)
      .set("Authorization", `Bearer ${gatewayCredential}`)
      .send({ status: "online", hardwareMetadata: { scannerStatus: "RUNNING", queueDepth: 0 } })
      .expect(200);
    const openapi = await request(runtime.app).get("/api/v1/openapi.json").expect(200);
    expect(openapi.body.paths["/tracking/observers/{observerId}/heartbeat"].post.security)
      .toEqual([{ trackingObserverBearer: [] }]);
    await request(runtime.app)
      .post(`/api/v1/tracking/observers/${gatewayId}/nested/heartbeat`)
      .set("Authorization", "Bearer stuga_observer_v1.invalid")
      .send({})
      .expect(404);

    const observedAt = new Date();
    const epochCounter = trackingEpochCounter(observedAt, 15);
    const gatewayAdvertisement = encodeTrackingAdvertisement(secret, {
      epochCounter,
      eventCounter: 100,
      batteryPercent: 72,
    });
    const gatewayObservation = {
      observationId: randomUUID(),
      propertyId: "property-main",
      observerId: gatewayId,
      observedAt: observedAt.toISOString(),
      rotatingTagId: gatewayAdvertisement.rotatingTagId,
      authenticator: gatewayAdvertisement.authenticator,
      protocolVersion: gatewayAdvertisement.protocolVersion,
      advertisementFlags: gatewayAdvertisement.flags,
      epochCounter,
      eventCounter: gatewayAdvertisement.eventCounter,
      rssi: -61,
      batteryPercent: gatewayAdvertisement.batteryPercent,
      scanMode: "gateway",
      appState: "background",
      rawPayload: gatewayAdvertisement.rawPayload,
      metadata: { platform: "LINUX", agentVersion: "1.0.0" },
    };
    const ingested = await request(runtime.app)
      .post("/api/v1/tracking/observations:batch")
      .set("Authorization", `Bearer ${gatewayCredential}`)
      .send({ observations: [gatewayObservation] })
      .expect(200);
    expect(ingested.body).toMatchObject({ accepted: 1, duplicates: 0, rejected: 0 });
    await request(runtime.app)
      .post("/api/v1/tracking/observations-not-a-batch")
      .set("Authorization", `Bearer ${gatewayCredential}`)
      .send({ observations: [gatewayObservation] })
      .expect(404);

    const zonePosition = await request(runtime.app)
      .get("/api/v1/assets/equipment-chainsaw/position")
      .expect(200);
    expect(zonePosition.body.position).toMatchObject({
      positionType: "confirmed-zone",
      zoneId: "zone-tool-shed",
      freshnessState: "live",
    });
    expect(zonePosition.body.position.coordinate).toBeNull();

    const scanToken = await request(runtime.app)
      .get("/api/v1/assets/equipment-chainsaw/tracking-scan-token")
      .expect(200);
    expect(scanToken.body).toMatchObject({
      equipmentId: "equipment-chainsaw",
      protocolVersion: 1,
    });
    expect(scanToken.body.rotatingTagIds).toHaveLength(3);
    expect(JSON.stringify(scanToken.body)).not.toContain(secretValue);

    const duplicate = await request(runtime.app)
      .post("/api/v1/tracking/observations:batch")
      .set("Authorization", `Bearer ${gatewayCredential}`)
      .send({ observations: [gatewayObservation] })
      .expect(200);
    expect(duplicate.body).toMatchObject({ accepted: 0, duplicates: 1, rejected: 0 });

    const invalid = await request(runtime.app)
      .post("/api/v1/tracking/observations:batch")
      .set("Authorization", `Bearer ${gatewayCredential}`)
      .send({
        observations: [{
          ...gatewayObservation,
          observationId: randomUUID(),
          eventCounter: 101,
          authenticator: Buffer.alloc(4, 0xff).toString("base64url"),
          rawPayload: undefined,
        }],
      })
      .expect(200);
    expect(invalid.body).toMatchObject({
      accepted: 0,
      duplicates: 0,
      rejected: 1,
      errors: [{ index: 0, code: "INVALID_AUTHENTICATOR" }],
    });

    const replayEpoch = (epochCounter + 0x1_0000 - 10) & 0xffff;
    const replayedAdvertisement = encodeTrackingAdvertisement(secret, {
      epochCounter: replayEpoch,
      eventCounter: 101,
      batteryPercent: 72,
    });
    const replayed = await request(runtime.app)
      .post("/api/v1/tracking/observations:batch")
      .set("Authorization", `Bearer ${gatewayCredential}`)
      .send({
        observations: [{
          ...gatewayObservation,
          observationId: randomUUID(),
          observedAt: new Date().toISOString(),
          rotatingTagId: replayedAdvertisement.rotatingTagId,
          authenticator: replayedAdvertisement.authenticator,
          epochCounter: replayEpoch,
          eventCounter: replayedAdvertisement.eventCounter,
          rawPayload: replayedAdvertisement.rawPayload,
        }],
      })
      .expect(200);
    expect(replayed.body).toMatchObject({
      accepted: 0,
      duplicates: 0,
      rejected: 1,
      errors: [{ index: 0, code: "CLOCK_UNRELIABLE" }],
    });

    const fixedGatewayObservationId = randomUUID();
    const fixedGatewayAdvertisement = encodeTrackingAdvertisement(secret, {
      epochCounter,
      eventCounter: 102,
      batteryPercent: 72,
    });
    await request(runtime.app)
      .post("/api/v1/tracking/observations:batch")
      .set("Authorization", `Bearer ${gatewayCredential}`)
      .send({
        observations: [{
          ...gatewayObservation,
          observationId: fixedGatewayObservationId,
          observedAt: new Date().toISOString(),
          rotatingTagId: fixedGatewayAdvertisement.rotatingTagId,
          authenticator: fixedGatewayAdvertisement.authenticator,
          eventCounter: fixedGatewayAdvertisement.eventCounter,
          observerPosition: {
            latitude: 60.17012,
            longitude: 24.93016,
            horizontalAccuracyMeters: 2,
            source: "fixed",
          },
          rawPayload: fixedGatewayAdvertisement.rawPayload,
        }],
      })
      .expect(200)
      .expect(({ body }) => expect(body.accepted).toBe(1));

    const phoneRegistration = await request(runtime.app)
      .post("/api/v1/tracking/observers/register")
      .send({
        propertyId: "property-main",
        type: "ios-phone",
        name: "Field iPhone",
        appInstallationId: "ios-installation-1",
      })
      .expect(201);
    const phoneId = phoneRegistration.body.observer.id as string;
    const phoneCredential = phoneRegistration.body.credential as string;
    const phoneAdvertisement = encodeTrackingAdvertisement(secret, {
      flags: TRACKING_FLAGS.moving,
      epochCounter,
      eventCounter: 103,
      batteryPercent: 71,
    });
    const phoneObservationId = randomUUID();
    await request(runtime.app)
      .post("/api/v1/tracking/observations:batch")
      .set("Authorization", `Bearer ${phoneCredential}`)
      .send({
        observations: [{
          observationId: phoneObservationId,
          propertyId: "property-main",
          observerId: phoneId,
          observedAt: new Date().toISOString(),
          rotatingTagId: phoneAdvertisement.rotatingTagId,
          authenticator: phoneAdvertisement.authenticator,
          protocolVersion: phoneAdvertisement.protocolVersion,
          advertisementFlags: phoneAdvertisement.flags,
          epochCounter,
          eventCounter: phoneAdvertisement.eventCounter,
          rssi: -49,
          motion: true,
          batteryPercent: 71,
          scanMode: "find-nearby",
          appState: "foreground",
          observerPosition: {
            latitude: 60.17015,
            longitude: 24.93018,
            horizontalAccuracyMeters: 5,
            source: "gps",
            capturedAt: new Date().toISOString(),
          },
          rawPayload: phoneAdvertisement.rawPayload,
          metadata: { platform: "IOS", appVersion: "1.0.0" },
        }],
      })
      .expect(200)
      .expect(({ body }) => expect(body.accepted).toBe(1));

    const snapshot = await request(runtime.app)
      .get("/api/v1/properties/property-main/tracking-map-snapshot")
      .expect(200);
    expect(snapshot.body.assets).toHaveLength(1);
    expect(snapshot.body.assets[0].position).toMatchObject({
      positionType: "nearby-live",
      movementState: "moving",
    });
    expect(snapshot.body.assets[0].position.accuracyRadiusMeters).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(snapshot.body)).not.toContain(secretValue);

    const evidence = await request(runtime.app)
      .get("/api/v1/assets/equipment-chainsaw/observations")
      .expect(200);
    expect(evidence.body.observations).toHaveLength(5);
    expect(evidence.body.observations.filter((item: { accepted: boolean }) => item.accepted))
      .toHaveLength(3);
    expect(evidence.body.observations.filter((item: { accepted: boolean }) => !item.accepted))
      .toHaveLength(2);
    const roleRedactedEvidence = runtime.tracking.equipmentObservations(
      "equipment-chainsaw",
      100,
      false,
    );
    expect(roleRedactedEvidence.find((item) => item.id === fixedGatewayObservationId)?.observerPosition)
      .toMatchObject({ source: "fixed" });
    expect(roleRedactedEvidence.find((item) => item.id === phoneObservationId)?.observerPosition)
      .toBeNull();

    await request(runtime.app)
      .patch(`/api/v1/tracking/observers/${phoneId}`)
      .send({ status: "disabled" })
      .expect(200);
    await request(runtime.app)
      .post("/api/v1/tracking/observations:batch")
      .set("Authorization", `Bearer ${phoneCredential}`)
      .send({ observations: [] })
      .expect(401);
    const reregisteredPhone = await request(runtime.app)
      .post("/api/v1/tracking/observers/register")
      .send({
        propertyId: "property-main",
        type: "ios-phone",
        name: "Field iPhone",
        appInstallationId: "ios-installation-1",
      })
      .expect(201);
    expect(reregisteredPhone.body.observer.id).toBe(phoneId);
    expect(reregisteredPhone.body.credential).not.toBe(phoneCredential);

    runtime.tracking.refreshProperty(
      "property-main",
      new Date(observedAt.getTime() + 91_000),
    );
    expect(runtime.tracking.store.getObserver(gatewayId)?.status).toBe("offline");
  });

  it("checks equipment out and shares only an expiring current member position", async () => {
    const expectedReturnAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const borrowed = await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-chainsaw/borrow")
      .send({ expectedReturnAt, note: "For the north fence" })
      .expect(201);
    expect(borrowed.body.loan).toMatchObject({
      propertyId: "property-main",
      equipmentId: "equipment-chainsaw",
      borrowerLabel: "Property member",
      expectedReturnAt,
      returnedAt: null,
    });

    await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-chainsaw/borrow")
      .send({})
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("EQUIPMENT_ALREADY_BORROWED"));

    const active = await request(runtime.app)
      .get("/api/v1/properties/property-main/equipment-loans?active=true&equipmentId=equipment-chainsaw")
      .expect(200);
    expect(active.body.loans).toHaveLength(1);

    const returned = await request(runtime.app)
      .post(`/api/v1/equipment-loans/${borrowed.body.loan.id}/return`)
      .send({ note: "Back in the shed" })
      .expect(200);
    expect(returned.body.loan).toMatchObject({
      returnedByLabel: "Property member",
      returnNote: "Back in the shed",
    });
    const returnedAgain = await request(runtime.app)
      .post(`/api/v1/equipment-loans/${borrowed.body.loan.id}/return`)
      .send({ note: "Retry must not overwrite history" })
      .expect(200);
    expect(returnedAgain.body.loan.returnedAt).toBe(returned.body.loan.returnedAt);
    expect(returnedAgain.body.loan.returnNote).toBe("Back in the shed");

    const capturedAt = new Date();
    const shared = await request(runtime.app)
      .put("/api/v1/properties/property-main/member-location")
      .send({
        coordinate: { latitude: 60.17015, longitude: 24.93018 },
        horizontalAccuracyMeters: 18,
        reducedAccuracy: true,
        capturedAt: capturedAt.toISOString(),
        sharingUntil: new Date(capturedAt.getTime() + 60 * 60_000).toISOString(),
      })
      .expect(200);
    expect(shared.body.location).toMatchObject({
      propertyId: "property-main",
      memberLabel: "Property member",
      horizontalAccuracyMeters: 18,
      reducedAccuracy: true,
    });

    const locations = await request(runtime.app)
      .get("/api/v1/properties/property-main/member-locations")
      .expect(200);
    expect(locations.body.locations).toHaveLength(1);
    const map = await request(runtime.app)
      .get("/api/v1/properties/property-main/tracking-map-snapshot")
      .expect(200);
    expect(map.body.members).toHaveLength(1);

    const signals = runtime.database.db.prepare(`SELECT state_json FROM tracking_events
      WHERE type LIKE 'member.location.%'`).all() as Array<{ state_json: string }>;
    expect(signals).not.toHaveLength(0);
    expect(JSON.stringify(signals)).not.toContain("60.17015");
    expect(JSON.stringify(signals)).not.toContain("24.93018");

    runtime.tracking.flags["tracking.userLocationSharing.enabled"] = false;
    runtime.tracking.refreshProperty(
      "property-main",
      new Date(capturedAt.getTime() + 91_000),
    );
    expect(runtime.tracking.store.memberLocations(
      "property-main",
      new Date(capturedAt.getTime() + 91_000),
    )).toEqual([]);
    runtime.tracking.flags["tracking.userLocationSharing.enabled"] = true;

    const refreshedAt = new Date();
    await request(runtime.app)
      .put("/api/v1/properties/property-main/member-location")
      .send({
        coordinate: { latitude: 60.17016, longitude: 24.93019 },
        horizontalAccuracyMeters: 9,
        reducedAccuracy: false,
        capturedAt: refreshedAt.toISOString(),
        sharingUntil: new Date(refreshedAt.getTime() + 60 * 60_000).toISOString(),
      })
      .expect(200);
    runtime.tracking.flags["tracking.userLocationSharing.enabled"] = false;
    await request(runtime.app)
      .delete("/api/v1/properties/property-main/member-location")
      .expect(204);
    expect(runtime.tracking.store.memberLocations("property-main")).toEqual([]);
    runtime.tracking.flags["tracking.userLocationSharing.enabled"] = true;
    await request(runtime.app)
      .get("/api/v1/properties/property-main/member-locations")
      .expect(200)
      .expect(({ body }) => expect(body.locations).toEqual([]));

    await request(runtime.app)
      .put("/api/v1/properties/property-main/member-location")
      .send({
        coordinate: { latitude: 60.17016, longitude: 24.93019 },
        horizontalAccuracyMeters: 9,
        reducedAccuracy: false,
        capturedAt: refreshedAt.toISOString(),
        sharingUntil: new Date(refreshedAt.getTime() + 60 * 60_000).toISOString(),
      })
      .expect(200);
    const restartedStore = new TrackingStore(
      runtime.database,
      new TrackingSecretBox(randomBytes(32)),
    );
    expect(restartedStore.memberLocations("property-main")).toEqual([]);

    runtime.database.createProperty({
      id: "property-workshop",
      name: "Workshop Property",
    });
    runtime.database.createPropertyArea({
      id: "zone-workshop",
      propertyId: "property-workshop",
      name: "Workshop",
      kind: "building",
      polygon: [],
    });
    runtime.database.updateAreaEquipment(
      "equipment-chainsaw",
      { areaId: "zone-workshop" },
    );
    expect(runtime.tracking.store.getEquipmentLoan(borrowed.body.loan.id)?.propertyId)
      .toBe("property-workshop");
  });

  it("keeps tracking disabled unless the deployment explicitly opts in", async () => {
    await runtime.close();
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", TRACKING_ENABLED: "false" }),
      database: new ClimateDatabase(":memory:", false),
      startBackground: false,
    });
    const capabilities = await request(runtime.app).get("/api/v1/tracking/capabilities").expect(200);
    expect(capabilities.body.flags["tracking.enabled"]).toBe(false);
    await request(runtime.app)
      .get("/api/v1/properties/property-main/tracking-map-snapshot")
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe("TRACKING_DISABLED"));
  });

  it("rate-limits repeated observer credential failures", async () => {
    const invalidCredential = `stuga_observer_v1.${randomUUID()}.${randomBytes(32).toString("base64url")}`;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await request(runtime.app)
        .post("/api/v1/tracking/observations:batch")
        .set("Authorization", `Bearer ${invalidCredential}`)
        .send({ observations: [] })
        .expect(401);
    }
    await request(runtime.app)
      .post("/api/v1/tracking/observations:batch")
      .set("Authorization", `Bearer ${invalidCredential}`)
      .send({ observations: [] })
      .expect(429)
      .expect(({ body, headers }) => {
        expect(body.error.code).toBe("AUTH_RATE_LIMITED");
        expect(Number(headers["retry-after"])).toBeGreaterThan(0);
      });
  });

  it("does not count successful observer authentication against the failure budget", async () => {
    const registration = await request(runtime.app)
      .post("/api/v1/tracking/observers/register")
      .send({
        propertyId: "property-main",
        type: "linux-gateway",
        name: "Busy gateway",
        zoneId: "zone-tool-shed",
      })
      .expect(201);
    const credential = registration.body.credential as string;
    for (let attempt = 0; attempt < 121; attempt += 1) {
      await request(runtime.app)
        .post("/api/v1/tracking/observations:batch")
        .set("Authorization", `Bearer ${credential}`)
        .send({ observations: [] })
        .expect(200);
    }
  });

  it("refuses tracking scan tokens to property guests", async () => {
    await runtime.close();
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        TRACKING_ENABLED: "true",
        TRACKING_MOBILE_OBSERVER_ENABLED: "true",
      }),
      startBackground: false,
    });
    runtime.database.createPropertyArea({
      id: "guest-token-area",
      propertyId: "property-main",
      name: "Guest token area",
      kind: "building",
      polygon: [],
    });
    runtime.database.createAreaEquipment({
      id: "guest-token-equipment",
      propertyId: "property-main",
      areaId: "guest-token-area",
      name: "Tracked guest-visible tool",
      kind: "tool",
    });

    const owner = request.agent(runtime.app);
    const setup = await owner.post("/api/v1/auth/setup")
      .send({ email: "owner@example.test", password: "correct horse battery staple" })
      .expect(201);
    const csrf = setup.body.csrfToken as string;
    const provisioned = await owner.post("/api/v1/tracking/tags")
      .set("x-csrf-token", csrf)
      .send({
        propertyId: "property-main",
        serialNumber: "TAG-GUEST-TOKEN",
        hardwareModel: "stugu-motion-v1",
        capabilities: { motion: true, battery: true },
      })
      .expect(201);
    const tagId = provisioned.body.tag.id as string;
    await owner.post(`/api/v1/tracking/tags/${tagId}/claim`)
      .set("x-csrf-token", csrf)
      .send({})
      .expect(200);
    await owner.post(`/api/v1/tracking/tags/${tagId}/assign`)
      .set("x-csrf-token", csrf)
      .send({ equipmentId: "guest-token-equipment" })
      .expect(201);

    const invitation = await owner.post("/api/v1/tenant/members")
      .set("x-csrf-token", csrf)
      .send({
        email: "guest@example.test",
        role: "guest",
        grants: [{ scopeType: "property", scopeId: "property-main" }],
      })
      .expect(201);
    const guest = request.agent(runtime.app);
    await guest.post("/api/v1/auth/register")
      .send({
        token: invitation.body.registrationToken,
        password: "guest password long enough",
      })
      .expect(201);

    await owner.get("/api/v1/assets/guest-token-equipment/tracking-scan-token").expect(200);
    await guest.get("/api/v1/assets/guest-token-equipment/tracking-scan-token")
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("FORBIDDEN"));
  });

  it("rejects unsafe tracking settings before they reach inference", async () => {
    await request(runtime.app)
      .patch("/api/v1/properties/property-main/tracking-settings")
      .send({ liveNearbySeconds: 0 })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    await request(runtime.app)
      .patch("/api/v1/properties/property-main/tracking-settings")
      .send({ minimumMovementConfidence: 1.1 })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    await request(runtime.app)
      .patch("/api/v1/properties/property-main/tracking-settings")
      .send({ liveNearbySeconds: 200, recentlySeenSeconds: 120 })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_TRACKING_WINDOWS"));
  });

  it("joins assigned inventory beyond the first equipment page", async () => {
    for (let index = 0; index < 500; index += 1) {
      runtime.database.createAreaEquipment({
        id: `equipment-bulk-${String(index).padStart(3, "0")}`,
        propertyId: "property-main",
        areaId: "zone-tool-shed",
        name: `Asset ${String(index).padStart(3, "0")}`,
        kind: "tool",
      });
    }
    const provisioned = await request(runtime.app)
      .post("/api/v1/tracking/tags")
      .send({
        propertyId: "property-main",
        serialNumber: "TAG-PAGED",
        hardwareModel: "stugu-basic-v1",
      })
      .expect(201);
    const tagId = provisioned.body.tag.id as string;
    await request(runtime.app).post(`/api/v1/tracking/tags/${tagId}/claim`).send({}).expect(200);
    await request(runtime.app)
      .post(`/api/v1/tracking/tags/${tagId}/assign`)
      .send({ equipmentId: "equipment-chainsaw" })
      .expect(201);

    await request(runtime.app)
      .get("/api/v1/properties/property-main/tracked-assets")
      .expect(200)
      .expect(({ body }) => {
        expect(body.assets).toHaveLength(1);
        expect(body.assets[0].equipment.id).toBe("equipment-chainsaw");
      });
    await request(runtime.app)
      .get("/api/v1/properties/property-main/inventory")
      .expect(200)
      .expect(({ body }) => {
        expect(body.inventory.equipment).toHaveLength(501);
        expect(body.inventory.equipment.at(-1).id).toBe("equipment-chainsaw");
      });
  });
});
