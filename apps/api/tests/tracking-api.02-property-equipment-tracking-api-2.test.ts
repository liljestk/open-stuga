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

import "./tracking-apiTestSupport.js";

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
