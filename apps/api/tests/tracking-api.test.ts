import { randomUUID } from "node:crypto";
import { TRACKING_SCHEMA_VERSION } from "@climate-twin/contracts";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";

describe("profile-driven equipment tracking API", () => {
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
      }),
      database,
      startBackground: false,
    });
  });

  afterEach(() => runtime.close());

  async function enrollAndBind() {
    const enrolled = await request(runtime.app)
      .post("/api/v1/tracking/endpoints")
      .send({
        propertyId: "property-main",
        profileId: "org.bluetooth.ibeacon",
        profileVersion: "2026.07",
        identityFields: {
          proximityUuid: "7f7e4b10-2f5f-4fc9-a66a-06db0fa042f8",
          major: "1",
          minor: "7",
        },
        displayName: "Chainsaw beacon",
        manufacturer: "Example",
        model: "Beacon",
        proof: { kind: "PHYSICAL_ACCESS" },
      })
      .expect(201);
    const endpoint = enrolled.body.endpoint;
    expect(endpoint).toMatchObject({
      propertyId: "property-main",
      profileId: "org.bluetooth.ibeacon",
      identityScope: "GLOBAL",
      identityStrength: "STATIC_CLEAR",
      trackabilityTier: "PROPERTY_BEACON",
      claimStatus: "CLAIMED",
    });
    expect(endpoint.identityFields).toBeUndefined();
    const bound = await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-chainsaw/tracking-binding")
      .send({ endpointId: endpoint.id })
      .expect(201);
    expect(bound.body.binding).toMatchObject({
      equipmentId: "equipment-chainsaw",
      endpointId: endpoint.id,
      observerId: null,
    });
    return endpoint as { id: string; identityReference: string };
  }

  it("accepts only claimed, bound, normalized evidence and derives a zone estimate", async () => {
    const manifest = await request(runtime.app).get("/api/v1/tracking/profiles").expect(200);
    expect(manifest.body.schemaVersion).toBe("2026-07-01");
    expect(manifest.body.profiles.map((item: { profile: { id: string } }) => item.profile.id))
      .toContain("org.bluetooth.ibeacon");
    expect(manifest.body.profiles[0].integrity).toMatchObject({
      digestAlgorithm: "SHA-256",
      signatureAlgorithm: null,
    });

    const endpoint = await enrollAndBind();
    const registration = await request(runtime.app)
      .post("/api/v1/tracking/observers/register")
      .send({
        propertyId: "property-main",
        type: "linux-gateway",
        name: "Tool shed gateway",
        zoneId: "zone-tool-shed",
      })
      .expect(201);
    const observerId = registration.body.observer.id as string;
    const credential = registration.body.credential as string;
    expect(credential).toMatch(/^stugu_observer\./u);

    const resolutionManifest = await request(runtime.app)
      .get(`/api/v1/tracking/observers/${observerId}/resolution-manifest`)
      .set("Authorization", `Bearer ${credential}`)
      .expect(200);
    expect(resolutionManifest.headers["cache-control"]).toContain("no-store");
    expect(resolutionManifest.body).toMatchObject({
      propertyId: "property-main",
      observerId,
      dataMode: "demo",
      entries: [{
        equipmentId: "equipment-chainsaw",
        endpointId: endpoint.id,
        profileId: "org.bluetooth.ibeacon",
        identityFields: { major: "1", minor: "7" },
      }],
    });

    const observedAt = new Date().toISOString();
    const evidence = {
      schemaVersion: TRACKING_SCHEMA_VERSION,
      dataMode: "demo",
      observationId: randomUUID(),
      idempotencyKey: randomUUID(),
      propertyId: "property-main",
      endpointId: endpoint.id,
      equipmentId: "equipment-chainsaw",
      observerId,
      observedAt,
      profileId: "org.bluetooth.ibeacon",
      profileVersion: "2026.07",
      rssi: -61,
      batteryPercent: 72,
      scanContext: "fixed-gateway",
      telemetry: { packetType: "ibeacon" },
    };
    const ingested = await request(runtime.app)
      .post("/api/v1/tracking/evidence:batch")
      .set("Authorization", `Bearer ${credential}`)
      .send({ observations: [evidence] })
      .expect(200);
    expect(ingested.body).toMatchObject({ accepted: 1, duplicates: 0, rejected: 0 });

    const duplicate = await request(runtime.app)
      .post("/api/v1/tracking/evidence:batch")
      .set("Authorization", `Bearer ${credential}`)
      .send({ observations: [evidence] })
      .expect(200);
    expect(duplicate.body).toMatchObject({ accepted: 0, duplicates: 1, rejected: 0 });

    const position = await request(runtime.app)
      .get("/api/v1/area-equipment/equipment-chainsaw/tracking-position")
      .expect(200);
    expect(position.body.position).toMatchObject({
      dataMode: "demo",
      equipmentId: "equipment-chainsaw",
      endpointId: endpoint.id,
      kind: "zone",
      zoneId: "zone-tool-shed",
      truthClass: "inferred",
      source: "fixed-gateway",
      freshness: "live",
    });
    expect(position.body.position.coordinate).toBeNull();
    expect(position.body.position.provenance.observationIds).toEqual([evidence.observationId]);

    const snapshot = await request(runtime.app)
      .get("/api/v1/properties/property-main/tracking-map-snapshot")
      .expect(200);
    expect(snapshot.body).toMatchObject({ propertyId: "property-main", dataMode: "demo" });
    expect(snapshot.body.equipment[0]).toMatchObject({
      equipment: { id: "equipment-chainsaw" },
      endpoint: { id: endpoint.id },
      position: { kind: "zone" },
    });

    const descriptor = await request(runtime.app)
      .get("/api/v1/area-equipment/equipment-chainsaw/tracking-find-descriptor")
      .expect(200);
    expect(descriptor.headers["cache-control"]).toContain("no-store");
    expect(descriptor.body).toMatchObject({
      equipmentId: "equipment-chainsaw",
      endpointId: endpoint.id,
      identityFields: { major: "1", minor: "7" },
      profile: { profile: { id: "org.bluetooth.ibeacon", version: "2026.07" } },
    });

    const openApi = await request(runtime.app).get("/api/v1/openapi.json").expect(200);
    expect(openApi.body.paths).toHaveProperty("/tracking/profiles");
    expect(openApi.body.paths).toHaveProperty("/tracking/endpoints");
    expect(openApi.body.paths).toHaveProperty("/tracking/evidence:batch");
    expect(openApi.body.paths).toHaveProperty("/properties/{propertyId}/tracked-equipment");
    expect(openApi.body.paths).not.toHaveProperty("/tracking/tags");
    expect(openApi.body.components.schemas.TrackingObservationInput.properties)
      .not.toHaveProperty("rawPayload");

    await request(runtime.app).get("/api/v1/tracking/tags").expect(404);
    await request(runtime.app).get("/api/v1/assets/equipment-chainsaw/position").expect(404);
  });

  it("does not admit raw, unknown, unbound, cross-mode, or cross-profile evidence", async () => {
    const endpoint = await enrollAndBind();
    const registration = await request(runtime.app)
      .post("/api/v1/tracking/observers/register")
      .send({
        propertyId: "property-main",
        type: "linux-gateway",
        name: "Gateway",
        zoneId: "zone-tool-shed",
      })
      .expect(201);
    const observerId = registration.body.observer.id as string;
    const credential = registration.body.credential as string;
    const base = {
      schemaVersion: TRACKING_SCHEMA_VERSION,
      dataMode: "demo",
      observationId: randomUUID(),
      idempotencyKey: randomUUID(),
      propertyId: "property-main",
      endpointId: endpoint.id,
      equipmentId: "equipment-chainsaw",
      observerId,
      observedAt: new Date().toISOString(),
      profileId: "org.bluetooth.ibeacon",
      profileVersion: "2026.07",
      rssi: -70,
      scanContext: "fixed-gateway",
    };
    await request(runtime.app)
      .post("/api/v1/tracking/evidence:batch")
      .set("Authorization", `Bearer ${credential}`)
      .send({ observations: [{ ...base, rawPayload: "unknown-frame" }] })
      .expect(400)
      .expect((response) => expect(response.body.error.code).toBe("UNKNOWN_FIELD"));

    const crossMode = await request(runtime.app)
      .post("/api/v1/tracking/evidence:batch")
      .set("Authorization", `Bearer ${credential}`)
      .send({
        observations: [{
          ...base,
          observationId: randomUUID(),
          idempotencyKey: randomUUID(),
          dataMode: "live",
        }],
      })
      .expect(200);
    expect(crossMode.body).toMatchObject({
      accepted: 0,
      rejected: 1,
      errors: [{ kind: "observation", code: "DATA_MODE_MISMATCH" }],
    });

    const wrongProfile = await request(runtime.app)
      .post("/api/v1/tracking/evidence:batch")
      .set("Authorization", `Bearer ${credential}`)
      .send({
        observations: [{
          ...base,
          observationId: randomUUID(),
          idempotencyKey: randomUUID(),
          profileVersion: "2099.01",
        }],
      })
      .expect(200);
    expect(wrongProfile.body.errors[0].code).toBe("PROFILE_VERSION_MISMATCH");

    const observations = await request(runtime.app)
      .get("/api/v1/area-equipment/equipment-chainsaw/tracking-observations")
      .expect(200);
    expect(observations.body.observations).toEqual([]);
  });

  it("enforces observer scope for observer-local identities", async () => {
    const first = await request(runtime.app)
      .post("/api/v1/tracking/observers/register")
      .send({
        propertyId: "property-main",
        type: "ios-phone",
        name: "First phone",
        appInstallationId: "install-first",
      })
      .expect(201);
    const second = await request(runtime.app)
      .post("/api/v1/tracking/observers/register")
      .send({
        propertyId: "property-main",
        type: "ios-phone",
        name: "Second phone",
        appInstallationId: "install-second",
      })
      .expect(201);
    const endpoint = await request(runtime.app)
      .post("/api/v1/tracking/endpoints")
      .send({
        propertyId: "property-main",
        profileId: "org.stugu.generic-gatt-observer-local",
        profileVersion: "2026.07",
        identityFields: { peripheralIdentifier: "8B5035B8-6C35-4D59-A24D-E470E87D9F41" },
        observerScopeId: first.body.observer.id,
        displayName: "Local peripheral",
        proof: { kind: "PHYSICAL_ACCESS" },
      })
      .expect(201);
    await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-chainsaw/tracking-binding")
      .send({ endpointId: endpoint.body.endpoint.id, observerId: second.body.observer.id })
      .expect(409)
      .expect((response) => expect(response.body.error.code).toBe("BINDING_OBSERVER_SCOPE"));
    await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-chainsaw/tracking-binding")
      .send({ endpointId: endpoint.body.endpoint.id, observerId: first.body.observer.id })
      .expect(201);
  });
});
