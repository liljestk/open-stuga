import type { Application } from "express";
import type { TrackingEvent } from "@climate-twin/contracts";
import {
  equipmentBorrowInput,
  equipmentReturnInput,
  memberLocationInput,
  numericLimit,
  requireEquipment,
  requireMember,
  requireProperty,
  type TrackingRouteOptions,
} from "./route-support.js";
import { TrackingError } from "./store.js";

export function registerTrackingLiveRoutes(app: Application, options: TrackingRouteOptions): void {
  const prefix = options.prefix ?? "/api/v1";
  const service = options.service;
  const store = service.store;

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
    const loan = store.people.getEquipmentLoan(request.params.loanId);
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
    requireProperty(options, response, request.params.propertyId);
    response.json({ locations: service.memberLocations(request.params.propertyId) });
  });

  app.put(`${prefix}/properties/:propertyId/member-location`, (request, response) => {
    const principal = requireMember(options, response);
    requireProperty(options, response, request.params.propertyId);
    response.json({
      location: service.shareMemberLocation(
        request.params.propertyId,
        principal.userId,
        principal.label,
        memberLocationInput(request.body),
      ),
    });
  });

  app.delete(`${prefix}/properties/:propertyId/member-location`, (request, response) => {
    const principal = requireMember(options, response);
    requireProperty(options, response, request.params.propertyId);
    service.stopMemberLocation(request.params.propertyId, principal.userId);
    response.status(204).end();
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
    const acquired = options.acquireStream ? options.acquireStream(request, response) : () => undefined;
    if (!acquired) {
      response.setHeader("retry-after", "5");
      throw new TrackingError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
    }
    const release = acquired;
    const requestedSequence = request.header("last-event-id")
      ?? (typeof request.query.sequence === "string" ? request.query.sequence : "0");
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
      if (!authorizationValid()) {
        close(true);
        return;
      }
      if (!writeEvent(event)) close();
    });
    const mode = store.dataMode();
    const replay = store.evidence.eventsAfter(request.params.propertyId, mode, lastSent, 501);
    if (replay.length > 500) {
      const sequence = store.evidence.latestSequence(request.params.propertyId, mode);
      response.write(
        `event: snapshot-required\ndata: ${JSON.stringify({ propertyId: request.params.propertyId, sequence })}\n\n`,
      );
      lastSent = sequence;
    } else {
      for (const event of replay) {
        if (!writeEvent(event)) {
          close();
          return;
        }
      }
    }
    response.write(`event: ready\ndata: ${JSON.stringify({
      propertyId: request.params.propertyId,
      dataMode: mode,
      sequence: lastSent,
    })}\n\n`);
    heartbeat = setInterval(() => {
      if (!authorizationValid()) {
        close(true);
        return;
      }
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
