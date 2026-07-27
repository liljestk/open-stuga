import type { Application, Request, Response } from "express";
import type {
  EquipmentBorrowInput,
  EquipmentReturnInput,
  GeoCoordinate,
  PropertyMemberLocationInput,
  TrackingEvent,
  TrackingObserverPatch,
  TrackingObserverRegisterInput,
  TrackingPropertySettings,
  TrackingTagCapabilities,
  TrackingTagCreateInput,
} from "@climate-twin/contracts";
import { TrackingService, type TrackingIngestionActor } from "../service.js";
import {
  TrackingError,
  type AuthenticatedTrackingObserver,
} from "../store.js";
import { TrackingRouteOptions, bodyObject, coordinate, enumValue, equipmentBorrowInput, equipmentReturnInput, memberLocationInput, metadata, nullableString, observerInput, observerPatch, rejectUnknown, requestTag, requireAdministrator, requireEquipment, requireMember, requireProperty, requiredString, settingsPatch, tagInput } from "./01-observer-types-to-request-tag.js";
import { ingestionActor, machineIdentity, numericLimit } from "./02-machine-identity-to-ingestion-actor.js";

export function registerTrackingRoutes(app: Application, options: TrackingRouteOptions): void {
  const prefix = options.prefix ?? "/api/v1";
  const service = options.service;
  const store = service.store;

  app.get(`${prefix}/tracking/capabilities`, (_request, response) => {
    response.json(service.capabilities());
  });

  app.get(`${prefix}/properties/:propertyId/tracking-settings`, (request, response) => {
    service.requireEnabled();
    requireProperty(options, response, request.params.propertyId);
    response.json({ settings: store.propertySettings(request.params.propertyId) });
  });

  app.patch(`${prefix}/properties/:propertyId/tracking-settings`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requireProperty(options, response, request.params.propertyId);
    const settings = store.updatePropertySettings(
      request.params.propertyId,
      settingsPatch(request.body),
    );
    response.json({ settings });
  });

  app.get(`${prefix}/tracking/tags`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    const propertyId = typeof request.query.propertyId === "string"
      ? request.query.propertyId
      : null;
    if (!propertyId) throw new TrackingError(400, "INVALID_FIELD", "propertyId is required");
    requireProperty(options, response, propertyId);
    response.json({ tags: store.listTags(propertyId) });
  });

  app.post(`${prefix}/tracking/tags`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    const input = tagInput(request.body);
    requireProperty(options, response, input.propertyId);
    const provisioning = store.createTag(input, service.tenantId);
    service.invalidateTagResolution();
    response.setHeader("cache-control", "no-store");
    response.status(201).json(provisioning);
  });

  app.post(`${prefix}/tracking/tags/:tagId/claim`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requestTag(options, response, request.params.tagId);
    const tag = store.claimTag(request.params.tagId);
    service.invalidateTagResolution();
    response.json({ tag });
  });

  app.post(`${prefix}/tracking/tags/:tagId/assign`, (request, response) => {
    service.requireEnabled();
    const principal = requireAdministrator(options, response);
    requestTag(options, response, request.params.tagId);
    const body = bodyObject(request.body);
    rejectUnknown(body, ["equipmentId"], "Tag assignment");
    const equipmentId = requiredString(body, "equipmentId");
    requireEquipment(options, response, equipmentId);
    const assignment = store.assignTag(request.params.tagId, equipmentId, principal.userId);
    service.recalculateTag(request.params.tagId);
    response.status(201).json({ assignment });
  });

  app.delete(`${prefix}/tracking/tags/:tagId/assignment`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requestTag(options, response, request.params.tagId);
    response.json({ assignment: store.unassignTag(request.params.tagId) });
  });

  app.post(`${prefix}/tracking/tags/:tagId/rotate-secret`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requestTag(options, response, request.params.tagId);
    const provisioning = store.rotateTagSecret(request.params.tagId);
    service.invalidateTagResolution();
    response.setHeader("cache-control", "no-store");
    response.json(provisioning);
  });

  app.get(`${prefix}/properties/:propertyId/tracking-observers`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requireProperty(options, response, request.params.propertyId);
    response.json({ observers: store.listObservers(request.params.propertyId) });
  });

  app.post(`${prefix}/tracking/observers/register`, (request, response) => {
    service.requireEnabled();
    const principal = options.principal(response);
    if (!principal || principal.role === "guest") {
      throw new TrackingError(403, "FORBIDDEN", "A Property member is required to register an observer");
    }
    const input = observerInput(request.body);
    requireProperty(options, response, input.propertyId);
    const mobile = input.type === "android-phone" || input.type === "ios-phone";
    const administrator = principal.role === "owner" || principal.role === "admin";
    if (mobile && !service.flags["tracking.mobileObserver.enabled"]) {
      throw new TrackingError(404, "MOBILE_OBSERVER_DISABLED", "Mobile observation is not enabled");
    }
    if (mobile && !administrator && (
      input.trustLevel !== undefined
      || input.fixedPosition !== undefined
      || input.fixedPositionAccuracyMeters !== undefined
      || input.zoneId !== undefined
    )) {
      throw new TrackingError(
        403,
        "FORBIDDEN",
        "Phone observers cannot assign their own trust, fixed position, or zone",
      );
    }
    if (!mobile) requireAdministrator(options, response);
    if (input.type === "android-gateway" && !service.flags["tracking.androidGatewayMode.enabled"]) {
      throw new TrackingError(404, "ANDROID_GATEWAY_MODE_DISABLED", "Android Gateway Mode is not enabled");
    }
    const registration = store.registerObserver(input, principal.userId, service.tenantId);
    response.setHeader("cache-control", "no-store");
    response.status(201).json(registration);
  });

  app.patch(`${prefix}/tracking/observers/:observerId`, (request, response) => {
    service.requireEnabled();
    const principal = options.principal(response);
    const identity = store.observerIdentity(request.params.observerId);
    if (!identity || !options.authorizeProperty(response, identity.observer.propertyId)) {
      throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    }
    const administrator = principal?.role === "owner" || principal?.role === "admin";
    if (!administrator && (
      !principal
      || identity.createdByUserId !== principal.userId
      || (identity.observer.type !== "android-phone" && identity.observer.type !== "ios-phone")
    )) {
      throw new TrackingError(403, "FORBIDDEN", "Only an administrator or the phone owner can update this observer");
    }
    const patch = observerPatch(request.body);
    if (!administrator && (
      patch.trustLevel !== undefined
      || patch.fixedPosition !== undefined
      || patch.fixedPositionAccuracyMeters !== undefined
      || patch.zoneId !== undefined
    )) {
      throw new TrackingError(403, "FORBIDDEN", "Phone owners may update only their observer name, status, and metadata");
    }
    response.json({ observer: store.updateObserver(identity.observer.id, patch) });
  });

  app.post(`${prefix}/tracking/observers/:observerId/heartbeat`, (request, response) => {
    const identity = machineIdentity(options, response, request.params.observerId);
    const body = bodyObject(request.body);
    rejectUnknown(body, ["status", "hardwareMetadata"], "Observer heartbeat");
    const status = body.status === undefined
      ? undefined
      : enumValue(body.status, ["online", "degraded", "disabled"] as const, "status");
    const hardwareMetadata = metadata(body.hardwareMetadata, "hardwareMetadata");
    response.json({
      observer: service.heartbeat(identity, {
        ...(status ? { status } : {}),
        ...(hardwareMetadata ? { hardwareMetadata } : {}),
      }),
    });
  });

  app.post(`${prefix}/tracking/observers/:observerId/position`, (request, response) => {
    service.requireEnabled();
    const principal = options.principal(response);
    const identity = store.observerIdentity(request.params.observerId);
    if (!identity) {
      throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    }
    const administrator = principal?.role === "owner" || principal?.role === "admin";
    if (!administrator) {
      throw new TrackingError(403, "FORBIDDEN", "Only an administrator can reposition a fixed gateway");
    }
    requireProperty(options, response, identity.observer.propertyId);
    const body = bodyObject(request.body);
    rejectUnknown(body, ["position", "accuracyMeters", "zoneId"], "Observer position");
    const accuracyMeters = body.accuracyMeters;
    if (typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters)) {
      throw new TrackingError(400, "INVALID_FIELD", "accuracyMeters must be a finite number");
    }
    response.json({
      observer: store.updateObserverPosition(
        identity.observer.id,
        coordinate(body.position, "position"),
        accuracyMeters,
        nullableString(body, "zoneId") ?? null,
      ),
    });
  });

  app.post(`${prefix}/tracking/observations\\:batch`, (request, response) => {
    response.json(service.ingest(request.body, ingestionActor(options, response)));
  });

  app.get(`${prefix}/properties/:propertyId/equipment-loans`, (request, response) => {
    const propertyId = request.params.propertyId;
    requireProperty(options, response, propertyId);
    const active = request.query.active;
    if (active !== undefined && active !== "true" && active !== "false") {
      throw new TrackingError(400, "INVALID_FIELD", "active must be true or false");
    }
    const equipmentId = request.query.equipmentId;
    if (equipmentId !== undefined && (typeof equipmentId !== "string" || !equipmentId.trim())) {
      throw new TrackingError(400, "INVALID_FIELD", "equipmentId must be a non-empty string");
    }
    response.json({
      loans: service.equipmentLoans(propertyId, {
        ...(typeof equipmentId === "string" ? { equipmentId: equipmentId.trim() } : {}),
        activeOnly: active === "true",
        limit: numericLimit(request.query.limit, 200, 500),
      }),
    });
  });

  app.post(`${prefix}/area-equipment/:equipmentId/borrow`, (request, response) => {
    const principal = requireMember(options, response);
    const equipmentId = request.params.equipmentId;
    requireEquipment(options, response, equipmentId);
    options.assertPropertyWriteAllowed(store.core.getAreaEquipment(equipmentId)!.propertyId);
    const loan = service.borrowEquipment(
      equipmentId,
      principal.userId,
      principal.label,
      equipmentBorrowInput(request.body),
    );
    response.status(201).json({ loan });
  });

  app.post(`${prefix}/equipment-loans/:loanId/return`, (request, response) => {
    const principal = requireMember(options, response);
    const loan = store.getEquipmentLoan(request.params.loanId);
    if (!loan || !options.authorizeProperty(response, loan.propertyId)) {
      throw new TrackingError(404, "EQUIPMENT_LOAN_NOT_FOUND", "Equipment loan not found");
    }
    options.assertPropertyWriteAllowed(loan.propertyId);
    response.json({
      loan: service.returnEquipment(
        loan.id,
        principal.userId,
        principal.label,
        equipmentReturnInput(request.body),
      ),
    });
  });

  app.get(`${prefix}/properties/:propertyId/member-locations`, (request, response) => {
    const propertyId = request.params.propertyId;
    requireProperty(options, response, propertyId);
    response.json({ locations: service.memberLocations(propertyId) });
  });

  app.put(`${prefix}/properties/:propertyId/member-location`, (request, response) => {
    const propertyId = request.params.propertyId;
    const principal = requireMember(options, response);
    requireProperty(options, response, propertyId);
    const location = service.shareMemberLocation(
      propertyId,
      principal.userId,
      principal.label,
      memberLocationInput(request.body),
    );
    response.json({ location });
  });

  app.delete(`${prefix}/properties/:propertyId/member-location`, (request, response) => {
    const propertyId = request.params.propertyId;
    const principal = requireMember(options, response);
    requireProperty(options, response, propertyId);
    service.stopMemberLocation(propertyId, principal.userId);
    response.status(204).end();
  });

  app.get(`${prefix}/properties/:propertyId/tracked-assets`, (request, response) => {
    service.requireEnabled();
    requireProperty(options, response, request.params.propertyId);
    service.refreshProperty(request.params.propertyId);
    response.json({
      assets: store.trackedEquipment(request.params.propertyId).filter((item) => item.assignment),
    });
  });

  app.get(`${prefix}/assets/:equipmentId/position`, (request, response) => {
    service.requireEnabled();
    requireEquipment(options, response, request.params.equipmentId);
    const equipment = store.core.getAreaEquipment(request.params.equipmentId)!;
    service.refreshProperty(equipment.propertyId);
    response.json({ position: store.currentPosition(request.params.equipmentId) });
  });

  app.get(`${prefix}/assets/:equipmentId/position-history`, (request, response) => {
    service.requireEnabled();
    requireEquipment(options, response, request.params.equipmentId);
    response.json({
      positions: store.positionHistory(
        request.params.equipmentId,
        numericLimit(request.query.limit, 100, 500),
      ),
    });
  });

  app.get(`${prefix}/assets/:equipmentId/observations`, (request, response) => {
    service.requireEnabled();
    requireEquipment(options, response, request.params.equipmentId);
    const principal = options.principal(response);
    const includeMobileCoordinates = principal?.role === "owner" || principal?.role === "admin";
    response.json({
      observations: service.equipmentObservations(
        request.params.equipmentId,
        numericLimit(request.query.limit, 100, 500),
        includeMobileCoordinates,
      ),
    });
  });

  app.get(`${prefix}/assets/:equipmentId/tracking-scan-token`, (request, response) => {
    service.requireEnabled();
    requireMember(options, response);
    requireEquipment(options, response, request.params.equipmentId);
    response.setHeader("cache-control", "private, no-store");
    response.json(service.scanToken(request.params.equipmentId));
  });

  app.get(`${prefix}/properties/:propertyId/tracking-map-snapshot`, (request, response) => {
    service.requireEnabled();
    requireProperty(options, response, request.params.propertyId);
    response.json(service.mapSnapshot(request.params.propertyId));
  });

  app.get(`${prefix}/properties/:propertyId/tracking-stream`, (request, response) => {
    service.requireFeature("tracking.liveMap.enabled", "The live equipment map is not enabled");
    requireProperty(options, response, request.params.propertyId);
    if (options.validateStream && !options.validateStream(request, response)) return;
    const acceptedFingerprint = options.streamAuthorizationFingerprint?.(request, response) ?? null;
    if (options.streamAuthorizationFingerprint && !acceptedFingerprint) {
      throw new TrackingError(401, "UNAUTHORIZED", "The authenticated session is no longer valid");
    }
    const acquired = options.acquireStream
      ? options.acquireStream(request, response)
      : () => undefined;
    if (!acquired) {
      response.setHeader("retry-after", "5");
      throw new TrackingError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
    }
    const release = acquired;
    const headerSequence = request.header("last-event-id");
    const querySequence = request.query.sequence;
    const requestedSequence = headerSequence ?? (typeof querySequence === "string" ? querySequence : "0");
    if (!/^\d+$/u.test(requestedSequence)) {
      release();
      throw new TrackingError(400, "INVALID_SEQUENCE", "Last-Event-ID must be a non-negative integer");
    }
    let lastSent = Number(requestedSequence);
    if (!Number.isSafeInteger(lastSent)) {
      release();
      throw new TrackingError(400, "INVALID_SEQUENCE", "Last-Event-ID is too large");
    }
    response.status(200);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    const authorizationValid = (): boolean => {
      if (options.streamAuthorizationFingerprint) {
        const current = options.streamAuthorizationFingerprint(request, response);
        if (!current || current !== acceptedFingerprint) return false;
      }
      return options.authorizeProperty(response, request.params.propertyId);
    };
    const writeEvent = (event: TrackingEvent): boolean => {
      if (closed || response.destroyed || response.writableEnded || event.sequence <= lastSent) return true;
      lastSent = event.sequence;
      return response.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    let unsubscribe = (): void => undefined;
    const close = (authorizationChanged = false): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      release();
      if (!response.writableEnded) {
        response.end(authorizationChanged
          ? `event: authorization\ndata: ${JSON.stringify({ status: "changed" })}\n\n`
          : undefined);
      }
    };
    unsubscribe = service.subscribe(request.params.propertyId, (event) => {
      if (!authorizationValid()) { close(true); return; }
      if (!writeEvent(event)) close();
    });
    const replay = store.eventsAfter(request.params.propertyId, lastSent, 501);
    if (replay.length > 500) {
      const sequence = store.latestSequence(request.params.propertyId);
      response.write(
        `event: snapshot-required\ndata: ${JSON.stringify({ propertyId: request.params.propertyId, sequence })}\n\n`,
      );
      lastSent = sequence;
    } else {
      for (const event of replay) {
        if (!writeEvent(event)) { close(); return; }
      }
    }
    response.write(`event: ready\ndata: ${JSON.stringify({
      propertyId: request.params.propertyId,
      sequence: lastSent,
    })}\n\n`);
    heartbeat = setInterval(() => {
      if (!authorizationValid()) { close(true); return; }
      if (!response.write(`event: heartbeat\ndata: ${JSON.stringify({
        timestamp: new Date().toISOString(),
        sequence: lastSent,
      })}\n\n`)) close();
    }, 15_000);
    heartbeat.unref();
    if (options.registerStream) {
      options.registerStream(
        request,
        response,
        () => {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
        },
        release,
      );
    } else {
      request.once("aborted", () => close());
      response.once("close", () => close());
    }
  });
}
