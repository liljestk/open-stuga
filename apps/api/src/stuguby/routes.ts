import express, { type Express, type Request, type RequestHandler } from "express";
import { STUGBY_MAX_BLOB_BYTES, STUGBY_MEDIA_TYPE, STUGBY_PROTOCOL_VERSION } from "@climate-twin/stuguby-protocol";
import { StugubyError, StugubyService, type MachineRequestProof } from "./service.js";

const PROTOCOL_PREFIX = "/api/v1/stugby-protocol" as const;
const LOCAL_PREFIX = "/api/v1/stugbys" as const;

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StugubyError(400, "INVALID_BODY", "A JSON object is required");
  return value as Record<string, unknown>;
}

function rawBody(request: Request): Buffer {
  if (!Buffer.isBuffer(request.body)) throw new StugubyError(400, "INVALID_BODY", "A raw request body is required");
  return request.body;
}

function rawJson(request: Request): unknown {
  const body = rawBody(request);
  if (!body.byteLength) throw new StugubyError(400, "INVALID_BODY", "A JSON request body is required");
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new StugubyError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new StugubyError(400, "INVALID_FIELD", `${label} is required`);
  return value.trim();
}

function integerValue(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) throw new StugubyError(400, "INVALID_FIELD", `${label} must be a non-negative integer`);
  return Number(parsed);
}

function protocolProof(request: Request): MachineRequestProof {
  if (request.header("x-stugby-protocol") !== STUGBY_PROTOCOL_VERSION) {
    throw new StugubyError(426, "PROTOCOL_VERSION_REQUIRED", `X-Stugby-Protocol must be ${STUGBY_PROTOCOL_VERSION}`);
  }
  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  return {
    method: request.method,
    path: request.originalUrl,
    body,
    nodeId: request.header("x-stugby-node-id"),
    timestamp: request.header("x-stugby-timestamp"),
    requestId: request.header("x-stugby-request-id"),
    signature: request.header("x-stugby-signature"),
  };
}

function stugubyId(request: Request): string {
  return stringValue(request.params.stugubyId, "Stuguby id");
}

function loopbackRequestOrigin(request: Request): string | null {
  const host = request.get("host");
  if (!host) return null;
  let url: URL;
  try { url = new URL(`${request.protocol}://${host}`); } catch { return null; }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return null;
  return url.origin;
}

function coordinatorOrigin(request: Request, service: StugubyService): string {
  const origin = service.publicOrigin ?? loopbackRequestOrigin(request);
  if (!origin) {
    throw new StugubyError(
      503,
      "STUGBY_PUBLIC_ORIGIN_REQUIRED",
      "Configure STUGBY_PUBLIC_ORIGIN on this node before creating a Stuguby",
    );
  }
  return origin;
}

/**
 * Register before local cookie authentication. Every route (except one-time
 * join admission) performs its own Ed25519 node authentication and replay
 * check, and raw bytes are verified before JSON parsing.
 */
export function registerStugubyProtocolRoutes(app: Express, service: StugubyService): void {
  // Never transparently inflate a signed body: the bytes validated by the
  // application must be the bytes the peer sent and signed.
  const jsonRaw = express.raw({ type: () => true, limit: "2mb", inflate: false });
  const joinRaw = express.raw({ type: () => true, limit: "64kb", inflate: false });
  const blobRaw = express.raw({ type: () => true, limit: STUGBY_MAX_BLOB_BYTES, inflate: false });

  app.use(PROTOCOL_PREFIX, (_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });

  app.post(`${PROTOCOL_PREFIX}/join`, joinRaw, (request, response) => {
    coordinatorOrigin(request, service);
    response.type(STUGBY_MEDIA_TYPE).status(201).send(JSON.stringify(service.acceptJoin(rawJson(request) as never)));
  });

  app.post(`${PROTOCOL_PREFIX}/stugbys/:stugubyId/events`, jsonRaw, (request, response) => {
    const id = stugubyId(request);
    const actor = service.authenticateMachineRequest(id, protocolProof(request));
    const result = service.ingestEventBatch(actor, id, rawJson(request) as never);
    response.type(STUGBY_MEDIA_TYPE).send(JSON.stringify(result));
  });

  app.get(`${PROTOCOL_PREFIX}/stugbys/:stugubyId/events`, (request, response) => {
    const id = stugubyId(request);
    const actor = service.authenticateMachineRequest(id, protocolProof(request));
    const cursor = integerValue(request.query.cursor, "cursor", 0);
    const limit = integerValue(request.query.limit, "limit", 100);
    response.type(STUGBY_MEDIA_TYPE).send(JSON.stringify(service.eventPage(actor, id, cursor, limit)));
  });

  app.get(`${PROTOCOL_PREFIX}/stugbys/:stugubyId/events/stream`, (request, response) => {
    const id = stugubyId(request);
    const actor = service.authenticateMachineRequest(id, protocolProof(request));
    const cursor = integerValue(request.query.cursor ?? request.header("last-event-id"), "cursor", 0);
    response.status(200);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe = (): void => undefined;
    let releaseStream = (): void => undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      releaseStream();
      if (!response.writableEnded) response.end();
    };
    request.once("aborted", close);
    response.once("close", close);
    if (request.aborted || response.destroyed) {
      close();
      return;
    }
    releaseStream = service.replaceNotificationStream(id, actor.nodeId, close);
    unsubscribe = service.subscribeNotifications(id, actor.nodeId, (nextCursor) => {
      if (closed) return;
      const writable = response.write(`event: available\nid: ${nextCursor}\ndata: ${JSON.stringify({ cursor: nextCursor })}\n\n`);
      if (!writable) close();
    });
    if (!response.write(`event: ready\nid: ${cursor}\ndata: ${JSON.stringify({ cursor })}\n\n`)) {
      close();
      return;
    }
    const pending = service.eventPage(actor, id, cursor, 1);
    if (pending.events.length > 0
      && !response.write(`event: available\nid: ${pending.cursor}\ndata: ${JSON.stringify({ cursor: pending.cursor })}\n\n`)) {
      close();
      return;
    }
    heartbeat = setInterval(() => {
      if (!response.write(": keep-alive\n\n")) close();
    }, 20_000);
    heartbeat.unref();
  });

  app.put(`${PROTOCOL_PREFIX}/stugbys/:stugubyId/blobs/:digest`, blobRaw, (request, response) => {
    const id = stugubyId(request);
    const actor = service.authenticateMachineRequest(id, protocolProof(request));
    const mediaType = request.header("content-type")?.split(";", 1)[0]?.trim() ?? "";
    const stored = service.storeUploadedBlob(actor, id, rawBody(request), mediaType, stringValue(request.params.digest, "Blob digest"));
    response.type(STUGBY_MEDIA_TYPE).status(201).send(JSON.stringify(stored));
  });

  app.get(`${PROTOCOL_PREFIX}/stugbys/:stugubyId/blobs/:digest`, (request, response) => {
    const id = stugubyId(request);
    const actor = service.authenticateMachineRequest(id, protocolProof(request));
    const blob = service.readBlobFor(actor, id, stringValue(request.params.digest, "Blob digest"));
    response.setHeader("content-type", blob.mediaType);
    response.setHeader("content-length", blob.data.byteLength);
    response.setHeader("cache-control", "private, max-age=31536000, immutable");
    response.send(blob.data);
  });

  app.put(`${PROTOCOL_PREFIX}/stugbys/:stugubyId/property`, jsonRaw, (request, response) => {
    const id = stugubyId(request);
    const actor = service.authenticateMachineRequest(id, protocolProof(request));
    const body = objectBody(rawJson(request));
    const property = service.updateSharedPropertyAs(actor.nodeId, id, integerValue(body.baseRevision, "baseRevision"), objectBody(body.property) as never);
    response.type(STUGBY_MEDIA_TYPE).send(JSON.stringify(property));
  });

  app.post(`${PROTOCOL_PREFIX}/stugbys/:stugubyId/property-commands`, jsonRaw, (request, response) => {
    const id = stugubyId(request);
    const actor = service.authenticateMachineRequest(id, protocolProof(request));
    const command = objectBody(rawJson(request));
    if (command.stugubyId !== id) throw new StugubyError(400, "STUGBY_ID_MISMATCH", "Property command targets another Stuguby");
    response.type(STUGBY_MEDIA_TYPE).send(JSON.stringify(service.applyPropertyCommandAs(actor.nodeId, command)));
  });

  app.post(`${PROTOCOL_PREFIX}/stugbys/:stugubyId/home-commands`, jsonRaw, (request, response) => {
    const id = stugubyId(request);
    const actor = service.authenticateMachineRequest(id, protocolProof(request));
    const command = objectBody(rawJson(request));
    if (command.stugubyId !== id) throw new StugubyError(400, "STUGBY_ID_MISMATCH", "Home command targets another Stuguby");
    response.type(STUGBY_MEDIA_TYPE).send(JSON.stringify(service.applyHomeCommandAs(actor.nodeId, command)));
  });

  app.post(`${PROTOCOL_PREFIX}/stugbys/:stugubyId/deletion-receipts`, jsonRaw, (request, response) => {
    const id = stugubyId(request);
    const actor = service.authenticateMachineRequest(id, protocolProof(request));
    service.recordDeletionReceipt(actor, rawJson(request) as never);
    response.status(204).end();
  });
}

export interface StugubyLocalRouteOptions {
  requireAdmin: RequestHandler;
}

/** Local owner/admin API. It exposes no node private key or remote account identity. */
export function registerStugubyLocalRoutes(app: Express, service: StugubyService, options: StugubyLocalRouteOptions): void {
  const admin = options.requireAdmin;

  app.get(LOCAL_PREFIX, admin, (request, response) => {
    response.json({
      identity: service.identity,
      publicOrigin: service.publicOrigin ?? loopbackRequestOrigin(request),
      suggestedPublicOrigin: service.suggestedPublicOrigin,
      publicOriginConfigurable: service.publicOriginConfigurable,
      stugubys: service.listStugubys(),
    });
  });

  app.put(`${LOCAL_PREFIX}/configuration`, admin, async (request, response) => {
    const body = objectBody(request.body);
    response.json({
      publicOrigin: await service.configurePublicOrigin(stringValue(body.publicOrigin, "Stugu address")),
    });
  });

  app.post(LOCAL_PREFIX, admin, (request, response) => {
    const body = objectBody(request.body);
    response.status(201).json(service.createStuguby({
      name: stringValue(body.name, "Name"),
      coordinatorUrl: coordinatorOrigin(request, service),
      ...(typeof body.description === "string" || body.description === null ? { description: body.description } : {}),
    }));
  });

  app.post(`${LOCAL_PREFIX}/join`, admin, async (request, response) => {
    const body = objectBody(request.body);
    response.status(201).json(await service.joinStuguby({
      coordinatorUrl: stringValue(body.coordinatorUrl, "Coordinator URL"),
      invitationId: stringValue(body.invitationId, "Invitation id"),
      joinSecret: stringValue(body.joinSecret, "Join secret"),
    }));
  });

  app.get(`${LOCAL_PREFIX}/:stugubyId`, admin, (request, response) => {
    const id = stugubyId(request);
    response.json({
      stuguby: service.getStuguby(id),
      members: service.store.listLocalMembers(id),
      invitations: service.store.listLocalInvitations(id),
      grants: service.store.listGrants(id),
      sharedProperty: service.store.getSharedProperty(id),
      propertyAdoption: service.store.getPropertyAdoption(id),
      propertyConflicts: service.store.listPropertyConflicts(id),
      propertyCommandCounts: service.store.propertyCommandCounts(id),
      homeCommandCounts: service.store.homeCommandCounts(id),
      homeProjections: service.store.listHomeProjections(id),
      authorityTransfers: service.store.listAuthorityTransfers(id),
      remoteResources: service.store.listRemoteResources(id),
      deletionReceipts: service.store.listDeletionReceipts(id),
      audit: service.store.listAudit(id),
    });
  });

  app.delete(`${LOCAL_PREFIX}/:stugubyId`, admin, (request, response) => {
    service.deleteStuguby(stugubyId(request));
    response.status(204).end();
  });

  app.post(`${LOCAL_PREFIX}/:stugubyId/invitations`, admin, (request, response) => {
    coordinatorOrigin(request, service);
    const body = objectBody(request.body);
    response.status(201).json(service.createInvitation(stugubyId(request), {
      role: stringValue(body.role, "Role") as "property-manager" | "participant" | "viewer",
      localLabel: body.localLabel,
      ...(typeof body.expiresAt === "string" ? { expiresAt: body.expiresAt } : {}),
    }));
  });

  app.delete(`${LOCAL_PREFIX}/:stugubyId/invitations/:invitationId`, admin, (request, response) => {
    service.revokeInvitation(stugubyId(request), stringValue(request.params.invitationId, "Invitation id"));
    response.status(204).end();
  });

  app.patch(`${LOCAL_PREFIX}/:stugubyId/members/:nodeId`, admin, (request, response) => {
    const body = objectBody(request.body);
    response.json(service.updateMember(stugubyId(request), stringValue(request.params.nodeId, "Node id"),
      stringValue(body.role, "Role") as never, stringValue(body.state, "State") as never));
  });

  app.patch(`${LOCAL_PREFIX}/:stugubyId/members/:nodeId/label`, admin, (request, response) => {
    const body = objectBody(request.body);
    response.json(service.updateMemberLocalLabel(
      stugubyId(request),
      stringValue(request.params.nodeId, "Node id"),
      body.localLabel,
    ));
  });

  app.get(`${LOCAL_PREFIX}/:stugubyId/property`, admin, (request, response) => {
    const property = service.store.getSharedProperty(stugubyId(request));
    if (!property) throw new StugubyError(404, "SHARED_PROPERTY_NOT_FOUND", "Shared Stuguby property was not found");
    response.json(property);
  });

  app.put(`${LOCAL_PREFIX}/:stugubyId/property`, admin, async (request, response) => {
    const body = objectBody(request.body);
    response.json(await service.updateSharedProperty(stugubyId(request), integerValue(body.baseRevision, "baseRevision"), objectBody(body.property) as never));
  });

  app.post(`${LOCAL_PREFIX}/:stugubyId/property/adopt`, admin, (request, response) => {
    const body = objectBody(request.body);
    response.status(201).json(service.adoptProperty(stugubyId(request),
      typeof body.localPropertyId === "string" ? stringValue(body.localPropertyId, "Local Property id") : undefined));
  });

  app.post(`${LOCAL_PREFIX}/:stugubyId/property/migrate`, admin, (request, response) => {
    const body = objectBody(request.body);
    if (body.confirmation !== "MIGRATE") {
      throw new StugubyError(400, "MIGRATION_CONFIRMATION_REQUIRED", "Confirm this destructive merge with MIGRATE");
    }
    response.json(service.migrateProperty(stugubyId(request), stringValue(body.sourcePropertyId, "Source Property id")));
  });

  app.post(`${LOCAL_PREFIX}/:stugubyId/property/disconnect`, admin, (request, response) => {
    const body = objectBody(request.body);
    if (body.confirmation !== "DISCONNECT") {
      throw new StugubyError(400, "DISCONNECT_CONFIRMATION_REQUIRED", "Confirm permanent disconnection with DISCONNECT");
    }
    response.json(service.detachProperty(stugubyId(request)));
  });

  app.post(`${LOCAL_PREFIX}/:stugubyId/property-conflicts/:commandId/resolve`, admin, (request, response) => {
    const resolved = service.store.resolvePropertyConflict(
      stugubyId(request),
      stringValue(request.params.commandId, "Command id"),
    );
    if (!resolved) throw new StugubyError(404, "PROPERTY_CONFLICT_NOT_FOUND", "Open Property conflict was not found");
    response.status(204).end();
  });

  app.post(`${LOCAL_PREFIX}/:stugubyId/grants`, admin, (request, response) => {
    const body = objectBody(request.body);
    response.status(201).json(service.createGrant(stugubyId(request), {
      localHouseId: stringValue(body.localHouseId, "House id"),
      audience: objectBody(body.audience) as never,
      datasets: Array.isArray(body.datasets) ? body.datasets as never : (() => { throw new StugubyError(400, "INVALID_FIELD", "datasets must be an array"); })(),
      ...(body.housePolicy !== undefined ? { housePolicy: objectBody(body.housePolicy) as never } : {}),
      ...(typeof body.expiresAt === "string" || body.expiresAt === null ? { expiresAt: body.expiresAt } : {}),
    }));
  });

  app.get(`${LOCAL_PREFIX}/:stugubyId/publications/:houseId`, admin, (request, response) => {
    response.json(service.localPublicationCatalog(stugubyId(request), stringValue(request.params.houseId, "House id")));
  });

  app.put(`${LOCAL_PREFIX}/:stugubyId/grants/:grantId`, admin, (request, response) => {
    const body = objectBody(request.body);
    const id = stugubyId(request);
    const grantId = stringValue(request.params.grantId, "Grant id");
    service.assertGrantScope(id, grantId);
    response.json(service.updateGrant(grantId, integerValue(body.baseRevision, "baseRevision"), {
      audience: objectBody(body.audience) as never,
      datasets: Array.isArray(body.datasets) ? body.datasets as never : (() => { throw new StugubyError(400, "INVALID_FIELD", "datasets must be an array"); })(),
      housePolicy: objectBody(body.housePolicy) as never,
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
    }));
  });

  app.delete(`${LOCAL_PREFIX}/:stugubyId/grants/:grantId`, admin, (request, response) => {
    const id = stugubyId(request);
    const grantId = stringValue(request.params.grantId, "Grant id");
    service.assertGrantScope(id, grantId);
    response.json(service.revokeGrant(grantId));
  });

  app.delete(`${LOCAL_PREFIX}/:stugubyId/grants/:grantId/invalid`, admin, (request, response) => {
    const id = stugubyId(request);
    const grantId = stringValue(request.params.grantId, "Grant id");
    service.assertGrantScope(id, grantId);
    response.json(service.removeInvalidGrant(grantId));
  });

  app.post(`${LOCAL_PREFIX}/:stugubyId/grants/:grantId/republish`, admin, (request, response) => {
    const id = stugubyId(request);
    const grantId = stringValue(request.params.grantId, "Grant id");
    service.assertGrantScope(id, grantId);
    service.republishGrant(grantId);
    response.status(202).json({ queued: true });
  });

  app.post(`${LOCAL_PREFIX}/:stugubyId/sync`, admin, async (request, response) => {
    response.json(await service.syncNow(stugubyId(request)));
  });

  app.get(`${LOCAL_PREFIX}/:stugubyId/telemetry`, admin, (request, response) => {
    response.json({ samples: service.store.remoteTelemetry({
      stugubyId: stugubyId(request),
      ...(typeof request.query.authorityNodeId === "string" ? { authorityNodeId: request.query.authorityNodeId } : {}),
      ...(typeof request.query.publicationId === "string" ? { publicationId: request.query.publicationId } : {}),
      ...(typeof request.query.sensorPublicationId === "string" ? { sensorPublicationId: request.query.sensorPublicationId } : {}),
      ...(typeof request.query.metricId === "string" ? { metricId: request.query.metricId } : {}),
      ...(typeof request.query.from === "string" ? { from: request.query.from } : {}),
      ...(typeof request.query.to === "string" ? { to: request.query.to } : {}),
      limit: integerValue(request.query.limit, "limit", 5_000),
    }) });
  });

  app.get(`${LOCAL_PREFIX}/:stugubyId/assets/:digest`, admin, (request, response) => {
    service.getStuguby(stugubyId(request));
    const blob = service.readBlob(stringValue(request.params.digest, "Blob digest"));
    response.setHeader("content-type", blob.mediaType);
    response.setHeader("content-length", blob.data.byteLength);
    response.setHeader("cache-control", "private, max-age=31536000, immutable");
    response.send(blob.data);
  });
}
