import { createServer, type Server } from "node:http";

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import type { MeasurementSample } from "@climate-twin/contracts";

import {
  STUGBY_DATASETS,
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  validateDatasetPayload,
  validateWireEvent,
  type StugubyDatasetGrant,
} from "@climate-twin/stuguby-protocol";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { StugubyService } from "../src/stuguby/service.js";

import { StugubyStore } from "../src/stuguby/store.js";

import {
  RunningNode,
  editableHomeDatasets,
  fullRecoveryDatasets,
  node,
  stop,
  verifyMembershipProjectionCleanup,
} from "./stugubyTestSupport.js";

describe("Stuguby federation", () => {
  const nodes: RunningNode[] = [];

  afterEach(async () => {
    for (const current of nodes.splice(0).reverse()) await stop(current);
  });

  it("joins independent nodes, shares only granted datasets, syncs common property, and purges on revoke", async () => {
    const coordinator = await node("Common property coordinator");
    const household = await node("Household A");
    const unsharedHousehold = await node("Household B");
    nodes.push(coordinator, household, unsharedHousehold);

    const created = await request(coordinator.url).post("/api/v1/stugbys").send({
      name: "Lake Stuguby",
      description: "Three independently managed households",
    }).expect(201);
    const stugubyId = created.body.id as string;
    const coordinatorPropertyId = coordinator.runtime.database.getHouse("house-main")!.propertyId;
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/adopt`)
      .send({ localPropertyId: coordinatorPropertyId }).expect(201);
    for (const grant of coordinator.runtime.stuguby!.store.listGrants(
      stugubyId,
      coordinator.runtime.stuguby!.identity.nodeId,
    ).filter((candidate) => !candidate.revokedAt)) {
      await request(coordinator.runtime.app)
        .delete(`/api/v1/stugbys/${stugubyId}/grants/${grant.id}`).expect(200);
    }

    const inviteA = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    const inviteB = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "viewer" }).expect(201);

    await request(household.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: inviteA.body.id,
      joinSecret: inviteA.body.joinSecret,
    }).expect(201);
    const duplicateInvite = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    const duplicateJoin = await request(household.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: duplicateInvite.body.id,
      joinSecret: duplicateInvite.body.joinSecret,
    }).expect(409);
    expect(duplicateJoin.body.error.code).toBe("NODE_ALREADY_MEMBER");
    await request(unsharedHousehold.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: inviteB.body.id,
      joinSecret: inviteB.body.joinSecret,
    }).expect(201);

    const viewerGrant = await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(403);
    expect(viewerGrant.body.error.code).toBe("PUBLISHING_FORBIDDEN");
    const viewerProperty = await request(unsharedHousehold.runtime.app).put(`/api/v1/stugbys/${stugubyId}/property`).send({
      baseRevision: 1,
      property: { name: "Unauthorized", description: null, location: null, areas: [], equipment: [], notes: [], maintenance: [] },
    }).expect(403);
    expect(viewerProperty.body.error.code).toBe("PROPERTY_WRITE_FORBIDDEN");

    const house = household.runtime.database.getHouse("house-main")!;
    household.runtime.database.createHouse({
      id: "house-annex",
      propertyId: house.propertyId,
      name: "Household A annex",
      timezone: house.timezone,
      floors: [{ id: "annex-floor", name: "Ground", width: 8, height: 6, elevation: 0, walls: [], rooms: [] }],
    });
    household.runtime.database.updateHouse(house.id, {
      location: { latitude: 60.1699, longitude: 24.9384, label: "Shared shore" },
      floors: house.floors.map((floor, index) => index === 0 ? {
        ...floor,
        backgroundImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDNwAAAABJRU5ErkJggg==",
      } : floor),
    });
    const publicationCatalog = await request(household.runtime.app)
      .get(`/api/v1/stugbys/${stugubyId}/publications/house-main`).expect(200);
    expect(publicationCatalog.body.house).toMatchObject({ localHouseId: "house-main", name: house.name });
    expect(publicationCatalog.body.sensors.length).toBeGreaterThan(0);
    expect(JSON.stringify(publicationCatalog.body)).not.toMatch(/provider|connection|entity|credential/i);

    const datasets: StugubyDatasetGrant[] = [
      { dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.location.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.structure.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.floorplan.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.sensor-catalog.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.notes.v1", enabled: true, includeLocalIds: false, allowReplicaCache: false, retentionDays: 0 },
      {
        dataset: "home.telemetry.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 7,
        telemetry: {
          sensorPublicationIds: [], metricIds: ["temperature"],
          historyFrom: new Date(Date.now() - 2 * 3_600_000).toISOString(), live: true, maxSamplesPerHour: 5_000,
        },
      },
    ];
    const grantResponse = await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "members", nodeIds: [coordinator.runtime.stuguby!.identity.nodeId] },
      datasets,
    }).expect(201);
    const annexGrant = await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-annex",
      audience: { kind: "members", nodeIds: [coordinator.runtime.stuguby!.identity.nodeId] },
      datasets: [
        { dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
        { dataset: "home.structure.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      ],
    }).expect(201);

    const projectionSync = await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(projectionSync.status, JSON.stringify(projectionSync.body)).toBe(200);

    const coordinatorDetail = await request(coordinator.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const schemas = coordinatorDetail.body.remoteResources.map((resource: { schema: string }) => resource.schema);
    expect(schemas).toEqual(expect.arrayContaining([
      "home.directory.v1", "home.location.v1", "home.structure.v1", "home.floorplan.v1", "home.sensor-catalog.v1",
    ]));
    expect(schemas).not.toContain("home.notes.v1");
    expect(schemas).not.toContain("home.telemetry.v1");
    const serialized = JSON.stringify(coordinatorDetail.body.remoteResources);
    expect(serialized).not.toMatch(/stateBinding|connectionId|entityId|credentials|password|remoteControl|command/i);
    expect(serialized).not.toMatch(/localHouseId|localFloorId|localSensorId/);
    expect(coordinatorDetail.body.remoteResources.find((resource: { schema: string }) => resource.schema === "home.location.v1").payload)
      .toMatchObject({ latitude: 60.1699, longitude: 24.9384 });
    expect(coordinator.runtime.stuguby!.store.remoteTelemetry({ stugubyId }).length).toBeGreaterThan(0);
    const floorPlanDigest = (coordinatorDetail.body.remoteResources
      .find((resource: { schema: string }) => resource.schema === "home.floorplan.v1")
      .payload.assets[0].image.digest) as string;
    expect(coordinator.runtime.stuguby!.store.getBlob(floorPlanDigest)).not.toBeNull();
    const directories = coordinator.runtime.stuguby!.store.listRemoteResources(stugubyId)
      .filter((resource) => resource.schema === "home.directory.v1");
    expect(directories).toHaveLength(2);
    expect(new Set(directories.map((resource) => resource.publicationId)).size).toBe(2);

    const householdNodeId = household.runtime.stuguby!.identity.nodeId;
    const coordinatorStore = coordinator.runtime.stuguby!.store;
    const mainProjection = coordinatorStore.getHomeProjection(
      stugubyId,
      householdNodeId,
      grantResponse.body.publicationId,
    )!;
    const annexProjection = coordinatorStore.getHomeProjection(
      stugubyId,
      householdNodeId,
      annexGrant.body.publicationId,
    )!;
    expect(coordinator.runtime.database.getHouse(mainProjection.localHouseId)).not.toBeNull();
    expect(coordinator.runtime.database.getHouse(annexProjection.localHouseId)).not.toBeNull();

    const mainNoteId = coordinatorStore.projectionId(
      stugubyId,
      householdNodeId,
      "home-note",
      "synthetic-main-note",
    );
    const annexNoteId = coordinatorStore.projectionId(
      stugubyId,
      householdNodeId,
      "home-note",
      "synthetic-annex-note",
    );
    for (const [id, houseId, text] of [
      [mainNoteId, mainProjection.localHouseId, "Main projected note"],
      [annexNoteId, annexProjection.localHouseId, "Annex projected note"],
    ] as const) {
      coordinator.runtime.database.createPropertyNote({
        id,
        propertyId: coordinator.runtime.database.getHouse(houseId)!.propertyId,
        houseId,
        kind: "inspection",
        text,
      });
    }
    const mainObservationId = coordinatorStore.projectionId(
      stugubyId,
      householdNodeId,
      "observation",
      "synthetic-main-observation",
    );
    const annexObservationId = coordinatorStore.projectionId(
      stugubyId,
      householdNodeId,
      "observation",
      "synthetic-annex-observation",
    );
    for (const [id, houseId, note] of [
      [mainObservationId, mainProjection.localHouseId, "Main projected observation"],
      [annexObservationId, annexProjection.localHouseId, "Annex projected observation"],
    ] as const) {
      coordinator.runtime.database.createObservation({
        id,
        houseId,
        floorId: coordinator.runtime.database.getHouse(houseId)!.floors[0]!.id,
        kind: "inspection",
        severity: "info",
        note,
        source: "owner",
      }, "system-service");
    }

    coordinator.runtime.stuguby!.materializeRemoteHome(
      stugubyId,
      householdNodeId,
      grantResponse.body.publicationId,
    );
    expect(coordinator.runtime.database.getPropertyNote(mainNoteId)).toBeNull();
    expect(coordinator.runtime.database.getObservation(mainObservationId)).toBeNull();
    expect(coordinator.runtime.database.getPropertyNote(annexNoteId)).not.toBeNull();
    expect(coordinator.runtime.database.getObservation(annexObservationId)).not.toBeNull();

    const updatedDatasets = datasets.map((dataset) => dataset.dataset === "home.directory.v1"
      ? { ...dataset, includeLocalIds: true }
      : dataset);
    const updatedGrant = await request(household.runtime.app).put(`/api/v1/stugbys/${stugubyId}/grants/${grantResponse.body.id}`).send({
      baseRevision: grantResponse.body.revision,
      audience: { kind: "members", nodeIds: [coordinator.runtime.stuguby!.identity.nodeId] },
      datasets: updatedDatasets,
      housePolicy: { editPolicy: "read-only", recoveryMode: "none", designatedSuccessorNodeId: null },
      expiresAt: null,
    }).expect(200);
    expect(updatedGrant.body).toMatchObject({ epoch: 3, revision: 3 });
    const updateSync = await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(updateSync.status, JSON.stringify({
      body: updateSync.body,
      mainHouseId: mainProjection.localHouseId,
      mainHouseExists: Boolean(coordinator.runtime.database.getHouse(mainProjection.localHouseId)),
      annexHouseId: annexProjection.localHouseId,
      annexHouseExists: Boolean(coordinator.runtime.database.getHouse(annexProjection.localHouseId)),
    })).toBe(200);
    const refreshedMainProjection = coordinatorStore.getHomeProjection(
      stugubyId,
      householdNodeId,
      grantResponse.body.publicationId,
    )!;
    expect(coordinator.runtime.database.getHouse(refreshedMainProjection.localHouseId)).not.toBeNull();
    const localIdProjection = coordinator.runtime.stuguby!.store.listRemoteResources(stugubyId)
      .find((resource) => resource.schema === "home.directory.v1" && resource.publicationId === grantResponse.body.publicationId);
    expect(localIdProjection?.payload).toMatchObject({ localHouseId: "house-main" });
    expect(coordinator.runtime.stuguby!.store.getGrant(grantResponse.body.id)?.localHouseId).toBeUndefined();

    await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const unsharedBefore = await request(unsharedHousehold.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(unsharedBefore.body.remoteResources).toEqual([]);

    const property = coordinator.runtime.stuguby!.store.getSharedProperty(stugubyId)!;
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${stugubyId}/property`).send({
      baseRevision: property.revision,
      property: {
        name: "Lake Stuguby shared grounds",
        description: "Common well and shore",
        location: { latitude: 60.17, longitude: 24.94, label: "Common parcel" },
        areas: [], equipment: [], notes: [],
        maintenance: [{
          id: "maint-1", title: "Inspect the common well", description: null, areaId: null, equipmentId: null,
          state: "planned", dueAt: null, completedAt: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      },
    }).expect(200);
    await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const unsharedAfter = await request(unsharedHousehold.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(unsharedAfter.body.sharedProperty.name).toBe("Lake Stuguby shared grounds");
    expect(unsharedAfter.body.sharedProperty.maintenance[0].title).toContain("common well");
    await request(coordinator.runtime.app)
      .patch(`/api/v1/stugbys/${stugubyId}/members/${unsharedHousehold.runtime.stuguby!.identity.nodeId}`)
      .send({ role: "viewer", state: "revoked" }).expect(200);
    await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const departed = await request(unsharedHousehold.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(departed.body.stuguby.localMemberState).toBe("revoked");
    expect(departed.body.sharedProperty).toBeNull();

    await request(household.runtime.app).delete(`/api/v1/stugbys/${stugubyId}/grants/${grantResponse.body.id}`).expect(200);
    await request(household.runtime.app).delete(`/api/v1/stugbys/${stugubyId}/grants/${annexGrant.body.id}`).expect(200);
    expect(household.runtime.database.getHouse("house-main")?.stuguby).toBeUndefined();
    expect(household.runtime.database.getHouse("house-annex")?.stuguby).toBeUndefined();
    await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    expect(coordinator.runtime.stuguby!.store.listRemoteResources(stugubyId)).toEqual([]);
    expect(coordinator.runtime.stuguby!.store.remoteTelemetry({ stugubyId })).toEqual([]);
    expect(coordinatorStore.getHomeProjection(
      stugubyId,
      householdNodeId,
      grantResponse.body.publicationId,
    )).toBeNull();
    expect(coordinatorStore.getHomeProjection(
      stugubyId,
      householdNodeId,
      annexGrant.body.publicationId,
    )).toBeNull();
    expect(coordinator.runtime.database.getHouse(refreshedMainProjection.localHouseId)).toBeNull();
    expect(coordinator.runtime.database.getHouse(annexProjection.localHouseId)).toBeNull();
    expect(coordinator.runtime.database.getPropertyNote(annexNoteId)).toBeNull();
    expect(coordinator.runtime.database.getObservation(annexObservationId)).toBeNull();
    expect(coordinator.runtime.stuguby!.store.getBlob(floorPlanDigest)).toBeNull();
    expect(existsSync(join(coordinator.directory, "stuguby", floorPlanDigest))).toBe(false);
    expect(coordinator.runtime.stuguby!.store.listDeletionReceipts(stugubyId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: grantResponse.body.id, nodeId: coordinator.runtime.stuguby!.identity.nodeId }),
    ]));
  }, 30_000);

  it("keeps every Host and Client authoritative for its Homes while sharing read-only overviews in the Host Property", async () => {
    const coordinator = await node("Adoption coordinator");
    const participant = await node("Adoption participant");
    const observer = await node("Adoption observer");
    nodes.push(coordinator, participant, observer);
    const localHome = participant.runtime.database.getHouse("house-main")!;
    const sourcePropertyId = localHome.propertyId;
    const hostPropertyId = coordinator.runtime.database.getHouse("house-main")!.propertyId;

    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Adoption Stuguby" }).expect(201);
    const stugubyId = created.body.id as string;
    const connected = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`)
      .send({ localPropertyId: hostPropertyId }).expect(201);
    expect(connected.body.localPropertyId).toBe(hostPropertyId);
    const hostOverview = coordinator.runtime.stuguby!.store.listGrants(
      stugubyId,
      coordinator.runtime.stuguby!.identity.nodeId,
    ).find((candidate) => candidate.localHouseId === "house-main");
    expect(hostOverview).toMatchObject({
      audience: { kind: "all-members", nodeIds: [] },
      housePolicy: {
        editPolicy: "read-only",
        recoveryMode: "none",
        designatedSuccessorNodeId: null,
      },
    });
    expect(hostOverview?.datasets.map((dataset) => dataset.dataset)).toEqual([
      "home.directory.v1",
      "home.structure.v1",
      "home.sensor-catalog.v1",
    ]);
    const hostSpareProperty = coordinator.runtime.database.createProperty({ name: "Host spare" });
    const blockedHostMigration = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/migrate`)
      .send({ sourcePropertyId: hostSpareProperty.id, confirmation: "MIGRATE" }).expect(409);
    expect(blockedHostMigration.body.error.code).toBe("HOST_PROPERTY_MIGRATION_NOT_ALLOWED");

    const legacyHostHome = coordinator.runtime.database.createHouse({
      id: "legacy-host-home",
      propertyId: hostPropertyId,
      name: "Legacy Host Home",
      timezone: "Europe/Helsinki",
      floors: [],
    });
    coordinator.runtime.database.setHouseStugubyLink(legacyHostHome.id, {
      stugubyId,
      authorityNodeId: coordinator.runtime.stuguby!.identity.nodeId,
      publicationId: coordinator.runtime.stuguby!.store.publicationId(stugubyId, "home", legacyHostHome.id),
      ownership: "local",
      editPolicy: "editable",
      syncState: "current",
      authorityEpoch: 1,
      pendingChangeCount: 0,
      conflictCount: 0,
      recoveryState: "not-enabled",
    });
    expect(coordinator.runtime.stuguby!.store.listGrants(
      stugubyId,
      coordinator.runtime.stuguby!.identity.nodeId,
    ).some((candidate) => candidate.localHouseId === legacyHostHome.id)).toBe(false);
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    expect(coordinator.runtime.stuguby!.store.listGrants(
      stugubyId,
      coordinator.runtime.stuguby!.identity.nodeId,
    ).some((candidate) => candidate.localHouseId === legacyHostHome.id)).toBe(true);

    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const observerInvitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(observer.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: observerInvitation.body.id,
      joinSecret: observerInvitation.body.joinSecret,
    }).expect(201);

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const adoptedResponse = await request(participant.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    await request(observer.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    const adoptedPropertyId = adoptedResponse.body.localPropertyId as string;
    const adoptedDetail = await request(participant.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const hostProjection = adoptedDetail.body.homeProjections
      .find((candidate: { authorityNodeId: string }) => candidate.authorityNodeId === coordinator.runtime.stuguby!.identity.nodeId);
    const sharedHomeId = hostProjection.localHouseId as string;

    expect(adoptedPropertyId).not.toBe(sourcePropertyId);
    expect(participant.runtime.database.getProperty(sourcePropertyId)).not.toBeNull();
    expect(participant.runtime.database.getHouse(localHome.id)?.propertyId).toBe(sourcePropertyId);
    expect(participant.runtime.database.getHouse(sharedHomeId)).toMatchObject({
      propertyId: adoptedPropertyId,
      stuguby: { ownership: "shared", editPolicy: "read-only", syncState: "current" },
    });
    const createdOwnedHome = await request(participant.runtime.app).post("/api/v1/houses").send({
      propertyId: adoptedPropertyId,
      name: "Client-built Home",
      timezone: "Europe/Helsinki",
      floors: [{
        id: "client-built-ground",
        name: "Ground floor",
        type: "ground",
        width: 10,
        height: 8,
        elevation: 0,
        walls: [],
        rooms: [],
        planElements: [],
      }],
    }).expect(201);
    expect(createdOwnedHome.body.house.stuguby).toMatchObject({
      stugubyId,
      ownership: "local",
      syncState: "current",
    });
    expect(participant.runtime.stuguby!.store.listGrants(
      stugubyId,
      participant.runtime.stuguby!.identity.nodeId,
    ).some((candidate) => candidate.localHouseId === createdOwnedHome.body.house.id)).toBe(true);
    const blocked = await request(participant.runtime.app)
      .patch(`/api/v1/houses/${sharedHomeId}`).send({ name: "Must not change" }).expect(403);
    expect(blocked.body.error.code).toBe("HOME_READ_ONLY");
    const migrationRequired = await request(participant.runtime.app)
      .patch(`/api/v1/houses/${localHome.id}`).send({ propertyId: adoptedPropertyId }).expect(409);
    expect(migrationRequired.body.error.code).toBe("STUGBY_PROPERTY_MIGRATION_REQUIRED");

    const firstPropertyEdit = await request(participant.runtime.app).patch(`/api/v1/properties/${adoptedPropertyId}`)
      .send({ description: "First queued description" });
    expect(firstPropertyEdit.status, JSON.stringify(firstPropertyEdit.body)).toBe(200);
    const finalPropertyEdit = await request(participant.runtime.app).patch(`/api/v1/properties/${adoptedPropertyId}`)
      .send({ description: "Final queued description" });
    expect(finalPropertyEdit.status, JSON.stringify(finalPropertyEdit.body)).toBe(200);
    expect(participant.runtime.stuguby.store.propertyCommandCounts(stugubyId)).toEqual({
      pending: 1,
      conflicts: 0,
    });
    const queuedPropertySync = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(queuedPropertySync.status, JSON.stringify(queuedPropertySync.body)).toBe(200);
    expect(coordinator.runtime.stuguby.store.getSharedProperty(stugubyId)?.description).toBe("Final queued description");
    expect(participant.runtime.stuguby.store.propertyCommandCounts(stugubyId)).toEqual({
      pending: 0,
      conflicts: 0,
    });

    const migrated = await request(participant.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/migrate`)
      .send({ sourcePropertyId, confirmation: "MIGRATE" }).expect(200);
    expect(migrated.body.moved.houseIds).toEqual([localHome.id]);
    expect(migrated.body.createdGrants).toHaveLength(1);
    expect(migrated.body.createdGrants[0]).toMatchObject({
      localHouseId: localHome.id,
      audience: { kind: "all-members", nodeIds: [] },
      housePolicy: { editPolicy: "read-only" },
    });
    expect(participant.runtime.database.getProperty(sourcePropertyId)).toBeNull();
    expect(participant.runtime.database.getHouse(localHome.id)).toMatchObject({
      propertyId: adoptedPropertyId,
      stuguby: { ownership: "local" },
    });
    await request(participant.runtime.app)
      .patch(`/api/v1/houses/${localHome.id}`).send({ name: "Client-owned Home" }).expect(200);
    expect(participant.runtime.database.getHouse(localHome.id)).toMatchObject({
      name: "Client-owned Home",
      stuguby: { ownership: "local", editPolicy: "editable" },
    });

    const propertySync = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(propertySync.status, JSON.stringify(propertySync.body)).toBe(200);
    const hostAfterClientShare = await request(coordinator.runtime.app)
      .get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const clientHomesOnHost = hostAfterClientShare.body.homeProjections
      .filter((candidate: { authorityNodeId: string }) => candidate.authorityNodeId === participant.runtime.stuguby!.identity.nodeId)
      .map((candidate: { localHouseId: string }) => coordinator.runtime.database.getHouse(candidate.localHouseId));
    expect(clientHomesOnHost).toEqual(expect.arrayContaining([
      expect.objectContaining({
        propertyId: hostPropertyId,
        name: "Client-owned Home",
        stuguby: expect.objectContaining({ ownership: "shared", editPolicy: "read-only" }),
      }),
      expect.objectContaining({
        propertyId: hostPropertyId,
        name: "Client-built Home",
        stuguby: expect.objectContaining({ ownership: "shared", editPolicy: "read-only" }),
      }),
    ]));

    await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const observerDetail = await request(observer.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const clientHomesOnObserver = observerDetail.body.homeProjections
      .filter((candidate: { authorityNodeId: string }) => candidate.authorityNodeId === participant.runtime.stuguby!.identity.nodeId)
      .map((candidate: { localHouseId: string }) => observer.runtime.database.getHouse(candidate.localHouseId));
    expect(clientHomesOnObserver).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Client-owned Home",
        stuguby: expect.objectContaining({ ownership: "shared", editPolicy: "read-only" }),
      }),
      expect.objectContaining({
        name: "Client-built Home",
        stuguby: expect.objectContaining({ ownership: "shared", editPolicy: "read-only" }),
      }),
    ]));

    await request(participant.runtime.app)
      .delete(`/api/v1/stugbys/${stugubyId}/grants/${migrated.body.createdGrants[0].id}`).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const movedHomeGrantHistory = participant.runtime.stuguby!.store.listGrants(
      stugubyId,
      participant.runtime.stuguby!.identity.nodeId,
    ).filter((candidate) => candidate.localHouseId === localHome.id);
    expect(movedHomeGrantHistory).toHaveLength(1);
    expect(movedHomeGrantHistory[0]?.revokedAt).not.toBeNull();
    expect(participant.runtime.database.getHouse(localHome.id)?.stuguby).toMatchObject({
      ownership: "local",
    });

    participant.runtime.database.createAreaEquipment({
      id: "disconnect-shared-equipment",
      propertyId: adoptedPropertyId,
      houseId: sharedHomeId,
      name: "Projected Home equipment",
      kind: "test-equipment",
    });
    participant.runtime.database.createMaintenanceTask({
      id: "disconnect-shared-task",
      propertyId: adoptedPropertyId,
      houseId: sharedHomeId,
      title: "Projected Home task",
      basis: "required",
    });
    participant.runtime.database.createPropertyNote({
      id: "disconnect-shared-note",
      propertyId: adoptedPropertyId,
      houseId: sharedHomeId,
      kind: "note",
      text: "Projected Home note",
    });

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/disconnect`)
      .send({ confirmation: "DISCONNECT" }).expect(200);
    expect(participant.runtime.database.getHouse(sharedHomeId)).toBeNull();
    expect(participant.runtime.database.db.prepare("SELECT id FROM houses WHERE id=?").get(sharedHomeId))
      .toBeUndefined();
    expect(participant.runtime.database.getAreaEquipment("disconnect-shared-equipment"))
      .toMatchObject({ houseId: null });
    expect(participant.runtime.database.getMaintenanceTask("disconnect-shared-task"))
      .toMatchObject({ houseId: null, floorId: null });
    expect(participant.runtime.database.getPropertyNote("disconnect-shared-note")).toBeNull();
    expect(participant.runtime.database.getHouse(localHome.id)).toMatchObject({
      propertyId: adoptedPropertyId,
    });
    expect(participant.runtime.database.getHouse(localHome.id)?.stuguby).toBeUndefined();
    expect(participant.runtime.database.getHouse(createdOwnedHome.body.house.id)?.stuguby).toBeUndefined();
    expect(participant.runtime.database.getProperty(adoptedPropertyId)?.stuguby).toMatchObject({
      syncState: "detached",
    });
    expect(participant.runtime.stuguby!.store.listGrants(
      stugubyId,
      participant.runtime.stuguby!.identity.nodeId,
    ).every((candidate) => candidate.revokedAt !== null)).toBe(true);

    await verifyMembershipProjectionCleanup(coordinator, participant, observer, stugubyId);
  }, 30_000);
});
