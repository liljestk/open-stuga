import { createServer, type Server } from "node:http";

import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { expect } from "vitest";

import request from "supertest";

import {
  STUGBY_DATASETS,
  type StugubyDatasetGrant,
} from "@climate-twin/stuguby-protocol";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

export interface RunningNode {
  runtime: ApiRuntime;
  server: Server;
  url: string;
  directory: string;
}

export async function node(
  name: string,
  startBackground = false,
  stugubyFetcher?: typeof fetch,
  publicOrigin?: string,
  cloudflarePublicOrigin?: string,
): Promise<RunningNode> {
  const directory = mkdtempSync(join(tmpdir(), "stuguby-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: ":memory:",
    ASSET_DIRECTORY: directory,
    STUGBY_NODE_NAME: name,
    STUGBY_SYNC_INTERVAL_MS: "300000",
    SPATIAL_LAYERS_ENABLED: "false",
    ...(publicOrigin ? { STUGBY_PUBLIC_ORIGIN: publicOrigin } : {}),
    ...(cloudflarePublicOrigin ? { CLOUDFLARE_ACCESS_PUBLIC_ORIGIN: cloudflarePublicOrigin } : {}),
  });
  const runtime = createApi({ config, startBackground, ...(stugubyFetcher ? { stugubyFetcher } : {}) });
  const server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { runtime, server, url: `http://127.0.0.1:${address.port}`, directory };
}

export async function stop(value: RunningNode): Promise<void> {
  await value.runtime.close();
  await new Promise<void>((resolve, reject) => value.server.close((error) => error ? reject(error) : resolve()));
  rmSync(value.directory, { recursive: true, force: true });
}

export function editableHomeDatasets(): StugubyDatasetGrant[] {
  return [
    "home.directory.v1",
    "home.location.v1",
    "home.structure.v1",
    "home.sensor-catalog.v1",
    "home.notes.v1",
    "home.observations.v1",
  ].map((dataset) => ({
    dataset: dataset as StugubyDatasetGrant["dataset"],
    enabled: true,
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: 30,
  }));
}

export function fullRecoveryDatasets(): StugubyDatasetGrant[] {
  return STUGBY_DATASETS.map((dataset) => ({
    dataset,
    enabled: true,
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: 3_650,
    ...(dataset === "home.telemetry.v1" ? {
      telemetry: {
        sensorPublicationIds: [],
        metricIds: [],
        historyFrom: "2000-01-01T00:00:00.000Z",
        live: true,
        maxSamplesPerHour: 1_000_000,
      },
    } : {}),
  }));
}

export async function verifyMembershipProjectionCleanup(
  coordinator: RunningNode,
  participant: RunningNode,
  observer: RunningNode,
  stugubyId: string,
): Promise<void> {
  const observerAdoption = observer.runtime.stuguby!.store.getPropertyAdoption(stugubyId)!;
  await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/disconnect`)
    .send({ confirmation: "DISCONNECT" }).expect(200);
  await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
  for (const source of [coordinator, participant]) {
    const activeGrants = source.runtime.stuguby!.store.listGrants(
      stugubyId,
      source.runtime.stuguby!.identity.nodeId,
    ).filter((grant) => !grant.revokedAt);
    for (const grant of activeGrants) {
      await request(source.runtime.app)
        .delete(`/api/v1/stugbys/${stugubyId}/grants/${grant.id}`).expect(200);
    }
    if (source !== coordinator) {
      await request(source.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    }
  }
  await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
  observer.runtime.stuguby!.store.adoptProperty(
    stugubyId,
    observerAdoption.localPropertyId,
    observerAdoption.lastMaterializedRevision,
  );

  const coordinatorNodeId = coordinator.runtime.stuguby!.identity.nodeId;
  const stalePublicationId = "stale-departed-home";
  const seedStaleDepartureProjection = () => {
    const houseId = observer.runtime.stuguby!.store.projectionId(
      stugubyId,
      coordinatorNodeId,
      "home",
      stalePublicationId,
    );
    observer.runtime.database.createHouse({
      id: houseId,
      propertyId: observerAdoption.localPropertyId,
      name: "Stale shared Home",
      timezone: "Europe/Helsinki",
      floors: [],
    });
    observer.runtime.database.setHouseStugubyLink(houseId, {
      stugubyId,
      authorityNodeId: coordinatorNodeId,
      publicationId: stalePublicationId,
      ownership: "shared",
      editPolicy: "read-only",
      syncState: "current",
      authorityEpoch: 1,
      pendingChangeCount: 0,
      conflictCount: 0,
      recoveryState: "not-enabled",
    });
    observer.runtime.stuguby!.store.upsertHomeProjection({
      stugubyId,
      authorityNodeId: coordinatorNodeId,
      publicationId: stalePublicationId,
      localHouseId: houseId,
      editPolicy: "read-only",
      recoveryMode: "none",
      recoveryState: "not-enabled",
      designatedSuccessorNodeId: null,
      recoverySyncedThrough: null,
      authorityEpoch: 1,
      detachedAt: null,
      updatedAt: new Date().toISOString(),
    });
    const noteId = observer.runtime.stuguby!.store.projectionId(
      stugubyId,
      coordinatorNodeId,
      "note",
      "departure-note",
    );
    observer.runtime.database.createPropertyNote({
      id: noteId,
      propertyId: observerAdoption.localPropertyId,
      kind: "inspection",
      text: "Projected common note",
    });
    return { houseId, noteId };
  };
  let { houseId: staleHouseId, noteId: departedNoteId } = seedStaleDepartureProjection();

  await request(coordinator.runtime.app)
    .patch(`/api/v1/stugbys/${stugubyId}/members/${observer.runtime.stuguby!.identity.nodeId}`)
    .send({ role: "participant", state: "suspended" }).expect(200);
  await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
  expect(observer.runtime.database.getPropertyNote(departedNoteId)).toBeNull();
  expect(observer.runtime.database.getHouse(staleHouseId)).toBeNull();
  expect(observer.runtime.stuguby!.store.getPropertyAdoption(stugubyId)).toMatchObject({ state: "adopted" });
  expect(observer.runtime.database.getProperty(observerAdoption.localPropertyId)?.stuguby).toMatchObject({
    syncState: "offline",
  });
  const suspendedEdit = await request(observer.runtime.app)
    .patch(`/api/v1/properties/${observerAdoption.localPropertyId}`)
    .send({ description: "Must not be accepted while suspended" });
  expect(suspendedEdit.status).toBe(403);
  expect(suspendedEdit.body.error.code).toBe("MEMBERSHIP_INACTIVE");

  await request(coordinator.runtime.app)
    .patch(`/api/v1/stugbys/${stugubyId}/members/${observer.runtime.stuguby!.identity.nodeId}`)
    .send({ role: "participant", state: "active" }).expect(200);
  await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
  expect(observer.runtime.stuguby!.store.getPropertyAdoption(stugubyId)).toMatchObject({ state: "adopted" });
  expect(observer.runtime.database.getProperty(observerAdoption.localPropertyId)?.stuguby).toMatchObject({
    syncState: "current",
  });
  ({ houseId: staleHouseId, noteId: departedNoteId } = seedStaleDepartureProjection());

  await request(coordinator.runtime.app)
    .patch(`/api/v1/stugbys/${stugubyId}/members/${observer.runtime.stuguby!.identity.nodeId}`)
    .send({ role: "participant", state: "revoked" }).expect(200);
  await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
  expect(observer.runtime.database.getPropertyNote(departedNoteId)).toBeNull();
  expect(observer.runtime.database.getHouse(staleHouseId)).toBeNull();
  expect(observer.runtime.stuguby!.store.getPropertyAdoption(stugubyId)).toMatchObject({ state: "detached" });
  expect(observer.runtime.database.getProperty(observerAdoption.localPropertyId)?.stuguby).toMatchObject({
    syncState: "detached",
  });
}
