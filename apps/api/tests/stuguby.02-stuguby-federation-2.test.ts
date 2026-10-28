import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import type { MeasurementSample } from "@climate-twin/contracts";

import {
  type StugubyDatasetGrant,
} from "@climate-twin/stuguby-protocol";

import { StugubyService } from "../src/stuguby/service.js";

import { StugubyStore } from "../src/stuguby/store.js";

import { RunningNode, node, stop } from "./stugubyTestSupport.js";

describe("Stuguby federation", () => {
  const nodes: RunningNode[] = [];

  afterEach(async () => {
    for (const current of nodes.splice(0).reverse()) await stop(current);
  });

  it("rolls back grant state, epochs, events, deletion expectations, and audit when publication fails", async () => {
    const coordinator = await node("Atomic grant coordinator");
    const participant = await node("Atomic grant publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Atomic grants" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    const store = participant.runtime.stuguby.store;
    const datasets: StugubyDatasetGrant[] = [
      { dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
    ];
    const originalEnqueue = store.enqueueOutbox.bind(store);
    let enqueueCalls = 0;
    const createFault = vi.spyOn(store, "enqueueOutbox").mockImplementation((...args) => {
      originalEnqueue(...args);
      enqueueCalls += 1;
      if (enqueueCalls === 2) throw new Error("simulated snapshot enqueue failure");
    });
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets,
    }).expect(500);
    createFault.mockRestore();
    expect(store.listGrants(stugubyId)).toEqual([]);
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "grant.created")).toBe(false);

    const grantResponse = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets,
    }).expect(201);
    const grantId = grantResponse.body.id as string;
    const firstControl = store.dueOutbox(250).find((item) => item.event.streamId === `grant:${grantId}`);
    expect(firstControl?.event.sequence).toBe(1);
    store.acknowledgeOutbox(store.dueOutbox(250).map((item) => item.id));

    enqueueCalls = 0;
    const updateFault = vi.spyOn(store, "enqueueOutbox").mockImplementation((...args) => {
      originalEnqueue(...args);
      enqueueCalls += 1;
      if (enqueueCalls === 3) throw new Error("simulated updated snapshot enqueue failure");
    });
    await request(participant.runtime.app).put(`/api/v1/stugbys/${stugubyId}/grants/${grantId}`).send({
      baseRevision: 1,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: datasets.map((dataset) => ({ ...dataset, includeLocalIds: true })),
      housePolicy: { editPolicy: "read-only", recoveryMode: "none", designatedSuccessorNodeId: null },
      expiresAt: null,
    }).expect(500);
    updateFault.mockRestore();
    expect(store.getGrant(grantId)).toMatchObject({ epoch: 1, revision: 1, revokedAt: null });
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "grant.updated")).toBe(false);

    const updated = await request(participant.runtime.app).put(`/api/v1/stugbys/${stugubyId}/grants/${grantId}`).send({
      baseRevision: 1,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: datasets.map((dataset) => ({ ...dataset, includeLocalIds: true })),
      housePolicy: { editPolicy: "read-only", recoveryMode: "none", designatedSuccessorNodeId: null },
      expiresAt: null,
    }).expect(200);
    expect(updated.body).toMatchObject({ epoch: 3, revision: 3 });
    expect(store.dueOutbox(250)
      .filter((item) => item.event.streamId === `grant:${grantId}`)
      .map((item) => item.event.sequence)).toEqual([2, 3]);
    store.acknowledgeOutbox(store.dueOutbox(250).map((item) => item.id));

    const revokeFault = vi.spyOn(store, "enqueueOutbox").mockImplementation((...args) => {
      originalEnqueue(...args);
      throw new Error("simulated revocation enqueue failure");
    });
    await request(participant.runtime.app).delete(`/api/v1/stugbys/${stugubyId}/grants/${grantId}`).expect(500);
    revokeFault.mockRestore();
    expect(store.getGrant(grantId)).toMatchObject({ epoch: 3, revision: 3, revokedAt: null });
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "grant.revoked")).toBe(false);

    const mainHouse = participant.runtime.database.getHouse("house-main")!;
    participant.runtime.database.createHouse({
      id: "house-expiring-grant",
      propertyId: mainHouse.propertyId,
      name: "Expiring grant Home",
      timezone: mainHouse.timezone,
      floors: [{
        id: "floor-expiring-grant",
        name: "Ground",
        width: 8,
        height: 6,
        elevation: 0,
        walls: [],
        rooms: [],
      }],
    });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const expiring = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-expiring-grant",
      audience: { kind: "all-members", nodeIds: [] },
      datasets,
      expiresAt,
    }).expect(201);
    store.acknowledgeOutbox(store.dueOutbox(250).map((item) => item.id));
    // Move the grant's expiry into the past instead of waiting for it on the real clock.
    const expired = new Date(Date.now() - 60_000).toISOString();
    participant.runtime.database.db.prepare(
      "UPDATE stugby_share_grants SET expires_at=?, grant_json=json_set(grant_json, '$.expiresAt', ?) WHERE id=?",
    ).run(expired, expired, expiring.body.id);
    const expiryFault = vi.spyOn(store, "enqueueOutbox").mockImplementation((...args) => {
      originalEnqueue(...args);
      throw new Error("simulated expiry enqueue failure");
    });
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(500);
    expiryFault.mockRestore();
    expect(store.getGrant(expiring.body.id)).toMatchObject({ epoch: 1, revision: 1, revokedAt: null });
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugubyId)
      .some((event) => event.eventType === "grant.expired" && event.subjectId === expiring.body.id)).toBe(false);
  });

  it("rolls back property revisions and member state until every required event and activation snapshot is durable", async () => {
    const coordinator = await node("Atomic membership coordinator");
    const participant = await node("Atomic membership participant");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Atomic membership" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    const store = coordinator.runtime.stuguby.store;
    const nodeId = participant.runtime.stuguby.identity.nodeId;
    const originalAppend = store.appendEventForMember.bind(store);
    const propertyBefore = store.getSharedProperty(stugubyId)!;
    const eventIdsBeforeProperty = store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const propertyFault = vi.spyOn(store, "appendEventForMember").mockImplementation((...args) => {
      originalAppend(...args);
      throw new Error("simulated property event failure");
    });
    const propertyInput = {
      baseRevision: propertyBefore.revision,
      property: {
        name: "Atomic shared grounds",
        description: null,
        location: null,
        areas: [],
        equipment: [],
        notes: [],
        maintenance: [],
      },
    };
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${stugubyId}/property`).send(propertyInput).expect(500);
    propertyFault.mockRestore();
    expect(store.getSharedProperty(stugubyId)).toEqual(propertyBefore);
    expect(store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventIdsBeforeProperty);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "shared-property.updated")).toBe(false);
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${stugubyId}/property`).send(propertyInput).expect(200);
    expect(store.getSharedProperty(stugubyId)).toMatchObject({ name: "Atomic shared grounds", revision: 2 });

    const eventsBeforeSuspension = store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const memberFault = vi.spyOn(store, "appendEventForMember").mockImplementation((...args) => {
      originalAppend(...args);
      throw new Error("simulated final member event failure");
    });
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugubyId}/members/${nodeId}`)
      .send({ role: "participant", state: "suspended" }).expect(500);
    memberFault.mockRestore();
    expect(store.getMember(stugubyId, nodeId)?.state).toBe("active");
    expect(store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventsBeforeSuspension);
    expect(store.listAudit(stugubyId).filter((event) => event.eventType === "member.updated")).toHaveLength(0);
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugubyId}/members/${nodeId}`)
      .send({ role: "participant", state: "suspended" }).expect(200);

    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);
    const eventsBeforeActivation = store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const memberAuditBeforeActivation = store.listAudit(stugubyId)
      .filter((event) => event.eventType === "member.updated").length;
    let activationAppends = 0;
    const activationFault = vi.spyOn(store, "appendEventForMember").mockImplementation((...args) => {
      originalAppend(...args);
      activationAppends += 1;
      if (activationAppends === 4) throw new Error("simulated activation snapshot failure");
    });
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugubyId}/members/${nodeId}`)
      .send({ role: "participant", state: "active" }).expect(500);
    activationFault.mockRestore();
    expect(store.getMember(stugubyId, nodeId)?.state).toBe("suspended");
    expect(store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventsBeforeActivation);
    expect(store.listAudit(stugubyId).filter((event) => event.eventType === "member.updated"))
      .toHaveLength(memberAuditBeforeActivation);
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugubyId}/members/${nodeId}`)
      .send({ role: "participant", state: "active" }).expect(200);
    expect(store.getMember(stugubyId, nodeId)?.state).toBe("active");
  });

  it("replaces an existing signed notification stream for the same member", async () => {
    const coordinator = await node("Stream coordinator");
    nodes.push(coordinator);
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const releaseFirst = coordinator.runtime.stuguby.replaceNotificationStream("stuguby-1", "node-1", firstClose);
    const releaseSecond = coordinator.runtime.stuguby.replaceNotificationStream("stuguby-1", "node-1", secondClose);

    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).not.toHaveBeenCalled();
    releaseFirst();
    const thirdClose = vi.fn();
    const releaseThird = coordinator.runtime.stuguby.replaceNotificationStream("stuguby-1", "node-1", thirdClose);
    expect(secondClose).toHaveBeenCalledOnce();
    releaseSecond();
    await coordinator.runtime.stuguby.stop();
    expect(thirdClose).toHaveBeenCalledOnce();
    releaseThird();
  });

  it("caps historical telemetry independently in each UTC hour across all selected metrics", async () => {
    const coordinator = await node("History cap coordinator");
    const participant = await node("History cap publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "History caps" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    participant.runtime.database.db.prepare("DELETE FROM measurement_samples").run();
    const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const denseHour = currentHour - 2 * 3_600_000;
    const sparseHour = currentHour - 3_600_000;
    const samples: MeasurementSample[] = [];
    for (let index = 0; index < 6; index += 1) {
      for (const [metric, canonicalUnit] of [["temperature", "°C"], ["humidity", "%"]] as const) {
        samples.push({
          sensorId: "sensor-01",
          metric,
          value: index,
          canonicalUnit,
          timestamp: new Date(denseHour + index * 60_000).toISOString(),
          source: "api",
          quality: "good",
        });
      }
    }
    for (const [index, [metric, canonicalUnit]] of ([["temperature", "°C"], ["humidity", "%"]] as const).entries()) {
      samples.push({
        sensorId: "sensor-01",
        metric,
        value: 100 + index,
        canonicalUnit,
        timestamp: new Date(sparseHour + index * 60_000).toISOString(),
        source: "api",
        quality: "good",
      });
    }
    for (let index = 0; index < 5; index += 1) {
      samples.push({
        sensorId: "sensor-01",
        metric: "temperature",
        value: 200 + index,
        canonicalUnit: "°C",
        timestamp: new Date(currentHour + index * 60_000).toISOString(),
        source: "api",
        quality: "good",
      });
    }
    participant.runtime.database.insertMeasurementSamples(samples);

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{
        dataset: "home.telemetry.v1",
        enabled: true,
        includeLocalIds: false,
        allowReplicaCache: true,
        retentionDays: 7,
        telemetry: {
          sensorPublicationIds: [],
          metricIds: ["temperature", "humidity"],
          historyFrom: new Date(denseHour).toISOString(),
          live: true,
          maxSamplesPerHour: 3,
        },
      }],
    }).expect(201);
    const telemetryPayloads = participant.runtime.stuguby.store.dueOutbox(250)
      .filter((item) => item.event.schema === "home.telemetry.v1")
      .map((item) => item.event.payload as unknown as {
        complete: boolean;
        samples: Array<{ timestamp: string }>;
      });
    const published = telemetryPayloads.flatMap((payload) => payload.samples);
    const counts = new Map<string, number>();
    for (const sample of published) {
      const hour = new Date(sample.timestamp).toISOString().slice(0, 13);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    expect(counts.get(new Date(denseHour).toISOString().slice(0, 13))).toBe(3);
    expect(counts.get(new Date(sparseHour).toISOString().slice(0, 13))).toBe(2);
    expect(counts.has(new Date(currentHour).toISOString().slice(0, 13))).toBe(false);
    expect([...counts.values()].every((count) => count <= 3)).toBe(true);
    expect(telemetryPayloads.filter((payload) => payload.complete)).toEqual([expect.objectContaining({ samples: [] })]);
    expect(telemetryPayloads.filter((payload) => payload.samples.length > 0)
      .every((payload) => !payload.complete)).toBe(true);
  });

  it("pages historical telemetry beyond 100000 samples and completes an empty replacement", async () => {
    const coordinator = await node("Large history coordinator");
    const participant = await node("Large history publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Large history" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    participant.runtime.database.db.prepare("DELETE FROM measurement_samples").run();
    const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const historyStart = currentHour - 30 * 3_600_000;
    const insert = participant.runtime.database.db.prepare(`INSERT INTO measurement_samples
      (sensor_id,metric,value,canonical_unit,timestamp,source,quality)
      VALUES ('sensor-01','temperature',20,'Â°C',?,'api','good')`);
    participant.runtime.database.transaction(() => {
      for (let index = 0; index < 100_001; index += 1) {
        insert.run(new Date(historyStart + index * 1_000).toISOString());
      }
    });
    const telemetryDataset = (metricIds: string[]): StugubyDatasetGrant => ({
      dataset: "home.telemetry.v1",
      enabled: true,
      includeLocalIds: false,
      allowReplicaCache: true,
      retentionDays: 30,
      telemetry: {
        sensorPublicationIds: [],
        metricIds,
        historyFrom: new Date(historyStart).toISOString(),
        live: true,
        maxSamplesPerHour: 1_000_000,
      },
    });
    const grant = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [telemetryDataset(["temperature"])],
    }).expect(201);
    const payloads = participant.runtime.stuguby.store.dueOutbox(250)
      .filter((item) => item.event.schema === "home.telemetry.v1" && item.event.grantId === grant.body.id)
      .map((item) => item.event.payload as unknown as {
        complete: boolean;
        samples: Array<{ timestamp: string }>;
      });
    expect(payloads.flatMap((payload) => payload.samples)).toHaveLength(100_001);
    expect(payloads.filter((payload) => payload.complete)).toEqual([expect.objectContaining({ samples: [] })]);

    const updated = await request(participant.runtime.app)
      .put(`/api/v1/stugbys/${stugubyId}/grants/${grant.body.id as string}`)
      .send({
        baseRevision: grant.body.revision,
        audience: grant.body.audience,
        datasets: [telemetryDataset(["co2"])],
        housePolicy: grant.body.housePolicy,
        expiresAt: null,
      }).expect(200);
    const emptyPayloads = participant.runtime.stuguby.store.dueOutbox(250)
      .filter((item) => item.event.schema === "home.telemetry.v1"
        && item.event.grantId === grant.body.id
        && item.event.grantEpoch === updated.body.epoch)
      .map((item) => item.event.payload as unknown as { complete: boolean; samples: unknown[] });
    expect(emptyPayloads).toEqual([expect.objectContaining({ complete: true, samples: [] })]);
  }, 15_000);

  it("keeps the live per-grant UTC-hour cap after recreating the service", async () => {
    const coordinator = await node("Live cap coordinator");
    const participant = await node("Live cap publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Live caps" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const grant = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{
        dataset: "home.telemetry.v1",
        enabled: true,
        includeLocalIds: false,
        allowReplicaCache: true,
        retentionDays: 7,
        telemetry: {
          sensorPublicationIds: [],
          metricIds: ["temperature"],
          historyFrom: null,
          live: true,
          maxSamplesPerHour: 2,
        },
      }],
    }).expect(201);
    const originalStore = participant.runtime.stuguby.store;
    const initialTelemetry = originalStore.dueOutbox(250)
      .filter((item) => item.event.schema === "home.telemetry.v1" && item.event.grantId === grant.body.id)
      .map((item) => item.event.payload as unknown as { complete: boolean; samples: unknown[] });
    expect(initialTelemetry).toEqual([expect.objectContaining({ complete: true, samples: [] })]);
    originalStore.acknowledgeOutbox(originalStore.dueOutbox(250).map((item) => item.id));
    const previousHour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
    const liveSample = (offset: number): MeasurementSample => ({
      sensorId: "sensor-01",
      metric: "temperature",
      value: offset,
      canonicalUnit: "°C",
      timestamp: new Date(previousHour + offset * 60_000).toISOString(),
      source: "api",
      quality: "good",
    });
    const publishLive = (service: StugubyService, sample: MeasurementSample): void => {
      (service as unknown as { publishLiveTelemetry(value: MeasurementSample): void }).publishLiveTelemetry(sample);
    };
    publishLive(participant.runtime.stuguby, liveSample(1));
    publishLive(participant.runtime.stuguby, liveSample(2));

    const restartedStore = new StugubyStore(participant.runtime.database.db, participant.runtime.stuguby.identity.nodeId);
    const restarted = new StugubyService({
      database: participant.runtime.database,
      store: restartedStore,
      keys: participant.runtime.stuguby.keys,
      bus: participant.runtime.bus,
      assetDirectory: participant.directory,
      syncIntervalMs: 300_000,
    });
    publishLive(restarted, liveSample(3));
    publishLive(restarted, {
      ...liveSample(4),
      timestamp: new Date(previousHour + 3_600_000 + 60_000).toISOString(),
    });

    const events = restartedStore.dueOutbox(250)
      .filter((item) => item.event.schema === "home.telemetry.v1" && item.event.grantId === grant.body.id);
    expect(events).toHaveLength(3);
    const counts = new Map<string, number>();
    for (const item of events) {
      const payload = item.event.payload as unknown as { samples: Array<{ timestamp: string }> };
      const hour = new Date(payload.samples[0]!.timestamp).toISOString().slice(0, 13);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    expect(counts.get(new Date(previousHour).toISOString().slice(0, 13))).toBe(2);
    expect(counts.get(new Date(previousHour + 3_600_000).toISOString().slice(0, 13))).toBe(1);
  });
});
