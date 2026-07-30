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

import { RunningNode, editableHomeDatasets, fullRecoveryDatasets, node, stop } from "./stugubyTestSupport.js";

describe("Stuguby federation", () => {
  const nodes: RunningNode[] = [];

  afterEach(async () => {
    for (const current of nodes.splice(0).reverse()) await stop(current);
  }, 30_000);

  it("keeps shared Property entities on one local record across create, edit, and delete", async () => {
    const coordinator = await node("Equipment coordinator");
    const participant = await node("Equipment participant");
    nodes.push(coordinator, participant);
    const hostPropertyId = coordinator.runtime.database.getHouse("house-main")!.propertyId;
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Equipment Stuguby" }).expect(201);
    const stugubyId = created.body.id as string;
    await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`)
      .send({ localPropertyId: hostPropertyId }).expect(201);

    const createdArea = await request(coordinator.runtime.app).post("/api/v1/property-areas").send({
      propertyId: hostPropertyId,
      name: "Machine yard",
      kind: "yard",
      polygon: [
        { latitude: 60, longitude: 24 },
        { latitude: 60.001, longitude: 24 },
        { latitude: 60, longitude: 24.001 },
      ],
    }).expect(201);
    const hostArea = createdArea.body.area;
    expect(coordinator.runtime.database.listPropertyAreas(hostPropertyId)
      .filter((item) => item.name === "Machine yard")).toEqual([
      expect.objectContaining({ id: hostArea.id }),
    ]);
    const createdEquipment = await request(coordinator.runtime.app).post("/api/v1/area-equipment").send({
      propertyId: hostPropertyId,
      areaId: hostArea.id,
      name: "Host tractor",
      kind: "vehicle",
    }).expect(201);
    const createdHomeEquipment = await request(coordinator.runtime.app).post("/api/v1/area-equipment").send({
      propertyId: hostPropertyId,
      houseId: "house-main",
      location: { latitude: 60.171, longitude: 24.931 },
      name: "Home generator",
      kind: "generator",
    }).expect(201);
    const createdPortableEquipment = await request(coordinator.runtime.app).post("/api/v1/area-equipment").send({
      propertyId: hostPropertyId,
      name: "Portable saw",
      kind: "tool",
    }).expect(201);
    expect(coordinator.runtime.database.listAreaEquipment({ propertyId: hostPropertyId })
      .filter((item) => item.name === "Host tractor")).toEqual([
      expect.objectContaining({ id: createdEquipment.body.equipment.id, areaId: hostArea.id }),
    ]);
    const createdNote = await request(coordinator.runtime.app).post("/api/v1/property-notes").send({
      propertyId: hostPropertyId,
      equipmentId: createdEquipment.body.equipment.id,
      kind: "inspection",
      text: "Check the hydraulic lines.",
    }).expect(201);
    expect(coordinator.runtime.database.listPropertyNotes({ propertyId: hostPropertyId })
      .filter((item) => item.text === "Check the hydraulic lines.")).toEqual([
      expect.objectContaining({
        id: createdNote.body.note.id,
        equipmentId: createdEquipment.body.equipment.id,
      }),
    ]);
    const createdTask = await request(coordinator.runtime.app).post("/api/v1/maintenance-tasks").send({
      propertyId: hostPropertyId,
      areaId: hostArea.id,
      equipmentId: createdEquipment.body.equipment.id,
      title: "Service the tractor",
      basis: "scheduled",
    }).expect(201);
    expect(coordinator.runtime.database.listMaintenanceTasks({ propertyId: hostPropertyId })
      .filter((item) => item.title === "Service the tractor")).toEqual([
      expect.objectContaining({
        id: createdTask.body.id,
        areaId: hostArea.id,
        equipmentId: createdEquipment.body.equipment.id,
      }),
    ]);

    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "property-manager" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const adoption = await request(participant.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    const participantPropertyId = adoption.body.localPropertyId as string;
    const projectedEquipment = participant.runtime.database.listAreaEquipment({
      propertyId: participantPropertyId,
    }).find((item) => item.name === "Host tractor")!;
    const projectedHomeEquipment = participant.runtime.database.listAreaEquipment({
      propertyId: participantPropertyId,
    }).find((item) => item.name === "Home generator")!;
    const projectedPortableEquipment = participant.runtime.database.listAreaEquipment({
      propertyId: participantPropertyId,
    }).find((item) => item.name === "Portable saw")!;
    const projectedHome = participant.runtime.database.listHouses(participantPropertyId)
      .find((house) => house.stuguby?.publicationId);
    expect(projectedHome).toBeDefined();
    expect(projectedHomeEquipment).toMatchObject({
      id: projectedHomeEquipment.id,
      houseId: projectedHome!.id,
      location: { latitude: 60.171, longitude: 24.931 },
    });
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name === "Home generator")).toHaveLength(1);

    await request(participant.runtime.app)
      .patch(`/api/v1/area-equipment/${projectedEquipment.id}`)
      .send({ name: "Member-updated tractor" }).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    await request(participant.runtime.app)
      .patch(`/api/v1/area-equipment/${projectedPortableEquipment.id}`)
      .send({ houseId: projectedHome!.id }).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);

    expect(coordinator.runtime.database.listAreaEquipment({ propertyId: hostPropertyId })
      .filter((item) => item.name.includes("tractor"))).toEqual([
      expect.objectContaining({ name: "Member-updated tractor", areaId: hostArea.id }),
    ]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name.includes("tractor"))).toEqual([
      expect.objectContaining({
        id: projectedEquipment.id,
        name: "Member-updated tractor",
        areaId: projectedEquipment.areaId,
      }),
    ]);
    expect(coordinator.runtime.database.listAreaEquipment({ propertyId: hostPropertyId })
      .filter((item) => item.name === "Portable saw")).toEqual([
      expect.objectContaining({ id: createdPortableEquipment.body.equipment.id, areaId: null, houseId: "house-main" }),
    ]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name === "Portable saw")).toEqual([
      expect.objectContaining({
        id: projectedPortableEquipment.id,
        areaId: null,
        houseId: projectedHome!.id,
      }),
    ]);

    await request(coordinator.runtime.app)
      .delete(`/api/v1/property-notes/${createdNote.body.note.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/maintenance-tasks/${createdTask.body.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/area-equipment/${createdHomeEquipment.body.equipment.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/area-equipment/${createdPortableEquipment.body.equipment.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/area-equipment/${createdEquipment.body.equipment.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/property-areas/${hostArea.id}`).expect(204);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    expect(coordinator.runtime.database.listPropertyAreas(hostPropertyId)
      .filter((item) => item.name === "Machine yard")).toEqual([]);
    expect(coordinator.runtime.database.listAreaEquipment({ propertyId: hostPropertyId })
      .filter((item) => item.name.includes("tractor"))).toEqual([]);
    expect(participant.runtime.database.listPropertyAreas(participantPropertyId)
      .filter((item) => item.name === "Machine yard")).toEqual([]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name.includes("tractor"))).toEqual([]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name === "Home generator")).toEqual([]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name === "Portable saw")).toEqual([]);
  }, 30_000);

  it("queues editable Home changes offline and reports a Server-wins conflict without detaching", async () => {
    let coordinatorOnline = true;
    const participantFetch: typeof fetch = async (input, init) => {
      if (!coordinatorOnline) throw new Error("simulated coordinator outage");
      return fetch(input, init);
    };
    const coordinator = await node("Editable Home coordinator");
    const participant = await node("Editable Home participant", false, participantFetch);
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Editable Homes" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "members", nodeIds: [participant.runtime.stuguby.identity.nodeId] },
      datasets: editableHomeDatasets(),
      housePolicy: { editPolicy: "editable", recoveryMode: "none", designatedSuccessorNodeId: null },
    }).expect(201);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    const detail = await request(participant.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const sharedHomeId = detail.body.homeProjections[0].localHouseId as string;
    const localPropertyId = participant.runtime.database.listProperties()
      .find((property) => property.id !== participant.runtime.database.getHouse(sharedHomeId)?.propertyId)!.id;
    const blockedMove = await request(participant.runtime.app).patch(`/api/v1/houses/${sharedHomeId}`)
      .send({ propertyId: localPropertyId }).expect(409);
    expect(blockedMove.body.error.code).toBe("STUGBY_HOME_PROPERTY_MANAGED");
    const sharedSensorId = participant.runtime.database.listSensors(sharedHomeId)[0]!.id;
    const localHouseId = participant.runtime.database.listHouses()
      .find((candidate) => candidate.id !== sharedHomeId)!.id;
    const blockedSensorMove = await request(participant.runtime.app).patch(`/api/v1/sensors/${sharedSensorId}`)
      .send({ houseId: localHouseId }).expect(409);
    expect(blockedSensorMove.body.error.code).toBe("STUGBY_SENSOR_HOME_MANAGED");
    const sharedFloors = participant.runtime.database.getHouse(sharedHomeId)!.floors;
    const blockedFloorPlanAsset = await request(participant.runtime.app)
      .put(`/api/v1/houses/${sharedHomeId}/layout`)
      .send({ floors: sharedFloors.map((floor, index) => index === 0
        ? { ...floor, backgroundImage: "data:image/png;base64,iVBORw0KGgo=" }
        : floor) })
      .expect(403);
    expect(blockedFloorPlanAsset.body.error.code).toBe("HOME_FLOORPLAN_ASSET_LOCAL_AUTHORITY");

    coordinatorOnline = false;
    await request(participant.runtime.app).patch(`/api/v1/houses/${sharedHomeId}`)
      .send({ name: "Queued client name" }).expect(200);
    await request(participant.runtime.app).patch(`/api/v1/sensors/${sharedSensorId}`)
      .send({ name: "Queued client sensor", model: "Shared sensor model", tags: ["client-updated"] })
      .expect(200);
    expect(participant.runtime.database.getHouse(sharedHomeId)?.stuguby).toMatchObject({
      syncState: "pending",
      pendingChangeCount: 1,
    });
    const failedSync = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(failedSync.status).toBeGreaterThanOrEqual(500);
    expect(participant.runtime.stuguby.store.getPropertyAdoption(stugubyId)?.state).toBe("adopted");
    expect(participant.runtime.database.getHouse(sharedHomeId)?.stuguby).toMatchObject({
      ownership: "shared",
      syncState: "offline",
      pendingChangeCount: 1,
    });

    coordinatorOnline = true;
    participant.runtime.database.db.prepare(
      "UPDATE stugby_home_commands SET next_attempt_at=? WHERE stugby_id=? AND status='pending'",
    ).run("2000-01-01T00:00:00.000Z", stugubyId);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    expect(coordinator.runtime.database.getHouse("house-main")?.name).toBe("Queued client name");
    expect(coordinator.runtime.database.listSensors("house-main")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Queued client sensor",
        model: "Shared sensor model",
        tags: ["client-updated"],
      }),
    ]));
    expect(participant.runtime.database.getHouse(sharedHomeId)?.stuguby).toMatchObject({
      syncState: "current",
      pendingChangeCount: 0,
    });

    await request(participant.runtime.app).patch(`/api/v1/houses/${sharedHomeId}`)
      .send({ name: "Client overlap" }).expect(200);
    await request(coordinator.runtime.app).patch("/api/v1/houses/house-main")
      .send({ name: "Server wins" }).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const conflicted = await request(participant.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(conflicted.body.homeCommandCounts).toEqual({ pending: 0, conflicts: 1 });
    expect(coordinator.runtime.database.getHouse("house-main")?.name).toBe("Server wins");
    expect(participant.runtime.database.getHouse(sharedHomeId)).toMatchObject({
      name: "Server wins",
      stuguby: { ownership: "shared", syncState: "conflict", conflictCount: 1 },
    });
  }, 30_000);

  it("promotes a designated full-recovery Home with telemetry and assets but no integration bindings", async () => {
    const coordinator = await node("Recovery coordinator");
    const participant = await node("Recovery successor");
    nodes.push(coordinator, participant);
    const sensor = coordinator.runtime.database.listSensors("house-main")[0]!;
    coordinator.runtime.database.updateSensor(sensor.id, {
      temperatureEntityId: "sensor.private_temperature",
      tpLinkDeviceId: "private-device-id",
    });
    const sampleAt = "2026-07-24T10:00:00.000Z";
    coordinator.runtime.database.insertMeasurementSamples([{
      sensorId: sensor.id,
      metric: "temperature",
      value: 19.75,
      canonicalUnit: "°C",
      timestamp: sampleAt,
      source: "api",
      quality: "good",
    }]);
    const weatherAt = "2026-07-24T09:30:00.000Z";
    const weatherLocationKey = "60.1699,24.9384";
    coordinator.runtime.database.upsertOutdoorTemperatureSample({
      houseId: "house-main",
      locationKey: weatherLocationKey,
      timestamp: weatherAt,
      temperatureC: 11.25,
      source: "fmi-backfill",
      fetchedAt: "2026-07-24T10:05:00.000Z",
      stationId: "helsinki-test",
      stationName: "Helsinki test",
    });
    const gltfBytes = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scenes: [] }));
    coordinator.runtime.database.createAsset({
      houseId: "house-main",
      name: "cottage.gltf",
      mimeType: "model/gltf+json",
      kind: "model-3d",
      data: gltfBytes,
    });

    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Recovery Stuguby" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "members", nodeIds: [participant.runtime.stuguby.identity.nodeId] },
      datasets: fullRecoveryDatasets(),
      housePolicy: {
        editPolicy: "read-only",
        recoveryMode: "full",
        designatedSuccessorNodeId: participant.runtime.stuguby.identity.nodeId,
      },
    }).expect(201);
    const alternate = await node("Alternate recovery successor");
    nodes.push(alternate);
    const alternateInvitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(alternate.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: alternateInvitation.body.id,
      joinSecret: alternateInvitation.body.joinSecret,
    }).expect(201);
    const competingSuccessor = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/grants`).send({
        localHouseId: "house-main",
        audience: { kind: "members", nodeIds: [alternate.runtime.stuguby.identity.nodeId] },
        datasets: fullRecoveryDatasets(),
        housePolicy: {
          editPolicy: "read-only",
          recoveryMode: "full",
          designatedSuccessorNodeId: alternate.runtime.stuguby.identity.nodeId,
        },
      }).expect(409);
    expect(competingSuccessor.body.error.code).toBe("HOME_SUCCESSOR_ALREADY_DESIGNATED");

    const recoveryAssetEvent = coordinator.runtime.stuguby.store.eventPage(
      stugubyId,
      participant.runtime.stuguby.identity.nodeId,
      0,
      250,
    ).events.find((event) => event.schema === "home.recovery.v1"
      && (event.payload as { kind?: string } | null)?.kind === "assets")!;
    const recoveryAssetRecord = (recoveryAssetEvent.payload as unknown as {
      records: Array<{ digest: string }>;
    }).records[0]!;
    expect(recoveryAssetRecord).toMatchObject({
      name: "cottage.gltf",
      mimeType: "model/gltf+json",
      kind: "model-3d",
    });
    expect(coordinator.runtime.stuguby.store.getBlob(recoveryAssetRecord.digest)).toMatchObject({
      digest: recoveryAssetRecord.digest,
      mediaType: "model/gltf+json",
      byteLength: gltfBytes.byteLength,
    });
    expect(coordinator.runtime.stuguby.store.canReadBlob(
      stugubyId,
      recoveryAssetRecord.digest,
      participant.runtime.stuguby.identity.nodeId,
    )).toBe(true);

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    const detail = await request(participant.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(detail.body.homeProjections[0]).toMatchObject({
      recoveryMode: "full",
      recoveryState: "ready",
      designatedSuccessorNodeId: participant.runtime.stuguby.identity.nodeId,
    });
    participant.runtime.database.db.prepare(
      "UPDATE stugby_remote_resources SET received_at='2000-01-01T00:00:00.000Z' WHERE stugby_id=?",
    ).run(stugubyId);
    participant.runtime.database.db.prepare(
      "UPDATE stugby_remote_telemetry SET received_at='2000-01-01T00:00:00.000Z' WHERE stugby_id=?",
    ).run(stugubyId);
    participant.runtime.stuguby.store.enforceRetention(stugubyId);
    expect(participant.runtime.stuguby.store.listRemoteResources(stugubyId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ schema: "home.recovery.v1" })]));
    expect(participant.runtime.stuguby.store.remoteTelemetryCount(
      stugubyId,
      coordinator.runtime.stuguby.identity.nodeId,
      detail.body.homeProjections[0].publicationId,
    )).toBeGreaterThan(0);
    const recoveredHomeId = detail.body.homeProjections[0].localHouseId as string;
    const projectedSensor = participant.runtime.database.listSensors(recoveredHomeId)[0]!;
    expect(projectedSensor.temperatureEntityId).toBeUndefined();
    expect(projectedSensor.tpLinkDeviceId).toBeUndefined();

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/disconnect`)
      .send({ confirmation: "DISCONNECT" }).expect(200);
    expect(participant.runtime.database.getHouse(recoveredHomeId)?.stuguby).toMatchObject({
      ownership: "local",
      syncState: "detached",
      recoveryState: "ready",
    });
    expect(participant.runtime.database.measurementHistory(
      projectedSensor.id,
      "temperature",
      "2026-07-24T09:00:00.000Z",
      "2026-07-24T11:00:00.000Z",
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ timestamp: sampleAt, value: 19.75, source: "import" }),
    ]));
    expect(participant.runtime.database.outdoorTemperatureHistory(
      recoveredHomeId,
      weatherLocationKey,
      "2026-07-24T09:00:00.000Z",
      "2026-07-24T10:00:00.000Z",
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ timestamp: weatherAt, temperatureC: 11.25, source: "fmi-backfill" }),
    ]));
    const recoveredAsset = participant.runtime.database.listAssets(recoveredHomeId)[0]!;
    expect(recoveredAsset).toMatchObject({
      name: "cottage.gltf",
      mimeType: "model/gltf+json",
      kind: "model-3d",
    });
    expect(Buffer.from(participant.runtime.database.getAsset(recoveredAsset.id)!.data)).toEqual(gltfBytes);
    expect(JSON.stringify({
      house: participant.runtime.database.getHouse(recoveredHomeId),
      sensors: participant.runtime.database.listSensors(recoveredHomeId),
    })).not.toMatch(/private_temperature|private-device-id/);

    const recoveredPropertyId = participant.runtime.database.getHouse(recoveredHomeId)!.propertyId;
    const successor = await request(participant.url).post("/api/v1/stugbys")
      .send({ name: "Successor Stuguby" }).expect(201);
    await request(participant.runtime.app)
      .post(`/api/v1/stugbys/${successor.body.id}/property/adopt`)
      .send({ localPropertyId: recoveredPropertyId })
      .expect(201);
    expect(participant.runtime.database.getProperty(recoveredPropertyId)?.stuguby).toMatchObject({
      stugubyId: successor.body.id,
      isAuthority: true,
      syncState: "current",
    });
    expect(participant.runtime.database.getHouse(recoveredHomeId)?.stuguby).toMatchObject({
      stugubyId: successor.body.id,
      ownership: "local",
      syncState: "current",
    });
    expect(participant.runtime.stuguby.store.getPropertyAdoption(stugubyId)).toBeNull();
  }, 30_000);

  it("uses SSE availability hints to pull durable property events without waiting for the polling interval", async () => {
    const coordinator = await node("SSE coordinator", true);
    const participant = await node("SSE participant", true);
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({
      name: "SSE Stuguby",
    }).expect(201);
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${created.body.id}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${created.body.id}/invitations`)
      .send({ role: "property-manager" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(200);
    expect(participant.runtime.stuguby!.store.listRemoteResources(created.body.id))
      .toEqual(expect.arrayContaining([expect.objectContaining({ schema: "home.directory.v1" })]));

    const property = coordinator.runtime.stuguby!.store.getSharedProperty(created.body.id)!;
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${created.body.id}/property`).send({
      baseRevision: property.revision,
      property: { name: "SSE-delivered common grounds", description: null, location: null, areas: [], equipment: [], notes: [], maintenance: [] },
    }).expect(200);

    await vi.waitFor(() => {
      expect(participant.runtime.stuguby!.store.getSharedProperty(created.body.id)?.name).toBe("SSE-delivered common grounds");
    }, { timeout: 8_000, interval: 50 });
  }, 15_000);
});
