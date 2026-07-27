import type { Application } from "express";
import { assessTrackingCompatibility } from "./profiles.js";
import { trackingEvidenceBatch } from "./route-evidence.js";
import {
  bodyObject,
  compatibilityInput,
  coordinate,
  endpointEnrollmentInput,
  enumValue,
  ingestionActor,
  machineIdentity,
  manualLocationInput,
  metadata,
  nullableString,
  numericLimit,
  observerInput,
  observerPatch,
  rejectUnknown,
  requireAdministrator,
  requireEndpoint,
  requireEquipment,
  requireMember,
  requireProperty,
  requiredString,
  settingsPatch,
  type TrackingRouteOptions,
} from "./route-support.js";
import { TrackingError } from "./store.js";

export function registerTrackingCoreRoutes(app: Application, options: TrackingRouteOptions): void {
  const prefix = options.prefix ?? "/api/v1";
  const service = options.service;
  const store = service.store;

  app.get(`${prefix}/tracking/capabilities`, (_request, response) => {
    response.json(service.capabilities());
  });

  app.get(`${prefix}/tracking/profiles`, (_request, response) => {
    response.json(service.profileManifest());
  });

  app.post(`${prefix}/tracking/compatibility-assessments`, (request, response) => {
    service.requireEnabled();
    requireMember(options, response);
    const assessment = assessTrackingCompatibility(compatibilityInput(request.body));
    if (!assessment) throw new TrackingError(404, "PROFILE_NOT_SUPPORTED", "Tracking profile version is not supported");
    response.json({ assessment });
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
    options.assertPropertyWriteAllowed(request.params.propertyId);
    response.json({
      settings: store.updatePropertySettings(request.params.propertyId, settingsPatch(request.body)),
    });
  });

  app.get(`${prefix}/tracking/endpoints`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    const propertyId = typeof request.query.propertyId === "string" ? request.query.propertyId : "";
    if (!propertyId) throw new TrackingError(400, "INVALID_FIELD", "propertyId is required");
    requireProperty(options, response, propertyId);
    response.json({ endpoints: store.listEndpoints(propertyId) });
  });

  app.get(`${prefix}/tracking/endpoints/:endpointId`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    response.json({ endpoint: requireEndpoint(options, response, request.params.endpointId) });
  });

  app.post(`${prefix}/tracking/endpoints`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    const input = endpointEnrollmentInput(request.body);
    requireProperty(options, response, input.propertyId);
    options.assertPropertyWriteAllowed(input.propertyId);
    const endpoint = store.enrollEndpoint(input, service.tenantId);
    response.setHeader("cache-control", "no-store");
    response.status(201).json({ endpoint });
  });

  app.patch(`${prefix}/tracking/endpoints/:endpointId/status`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    const endpoint = requireEndpoint(options, response, request.params.endpointId);
    options.assertPropertyWriteAllowed(endpoint.propertyId);
    const body = bodyObject(request.body);
    rejectUnknown(body, ["status"], "Endpoint status");
    const status = enumValue(
      body.status,
      ["CLAIMED", "DEGRADED", "REVOKED", "RETIRED"] as const,
      "status",
    );
    response.json({ endpoint: store.setEndpointStatus(endpoint.id, status) });
  });

  app.get(`${prefix}/properties/:propertyId/tracking-bindings`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requireProperty(options, response, request.params.propertyId);
    response.json({ bindings: store.listBindings(request.params.propertyId, request.query.history !== "true") });
  });

  app.post(`${prefix}/area-equipment/:equipmentId/tracking-binding`, (request, response) => {
    service.requireEnabled();
    const principal = requireAdministrator(options, response);
    requireEquipment(options, response, request.params.equipmentId);
    const equipment = store.core.getAreaEquipment(request.params.equipmentId)!;
    options.assertPropertyWriteAllowed(equipment.propertyId);
    const body = bodyObject(request.body);
    rejectUnknown(body, ["endpointId", "observerId"], "Tracking binding");
    const binding = store.bindEndpoint(
      equipment.id,
      {
        endpointId: requiredString(body, "endpointId"),
        ...(body.observerId === undefined ? {} : { observerId: requiredString(body, "observerId") }),
      },
      principal.userId,
    );
    service.recalculateEquipment(equipment.id);
    response.status(201).json({ binding });
  });

  app.delete(`${prefix}/area-equipment/:equipmentId/tracking-binding`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requireEquipment(options, response, request.params.equipmentId);
    const equipment = store.core.getAreaEquipment(request.params.equipmentId)!;
    options.assertPropertyWriteAllowed(equipment.propertyId);
    response.json({ binding: store.unbindEquipment(equipment.id) });
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
      input.trustLevel !== undefined || input.fixedPosition !== undefined
      || input.fixedPositionAccuracyMeters !== undefined || input.zoneId !== undefined
    )) {
      throw new TrackingError(403, "FORBIDDEN", "Phone observers cannot set trust or fixed placement");
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
      !principal || identity.createdByUserId !== principal.userId
      || (identity.observer.type !== "android-phone" && identity.observer.type !== "ios-phone")
    )) {
      throw new TrackingError(403, "FORBIDDEN", "Only an administrator or the phone owner can update this observer");
    }
    const patch = observerPatch(request.body);
    if (!administrator && (
      patch.trustLevel !== undefined || patch.fixedPosition !== undefined
      || patch.fixedPositionAccuracyMeters !== undefined || patch.zoneId !== undefined
    )) {
      throw new TrackingError(403, "FORBIDDEN", "Phone owners may update only name, status, and metadata");
    }
    response.json({ observer: store.updateObserver(identity.observer.id, patch) });
  });

  app.get(`${prefix}/tracking/observers/:observerId/resolution-manifest`, (request, response) => {
    service.requireEnabled();
    const identity = machineIdentity(options, response, request.params.observerId);
    response.setHeader("cache-control", "private, no-store");
    response.json(service.resolutionManifest(identity));
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
    requireAdministrator(options, response);
    const identity = store.observerIdentity(request.params.observerId);
    if (!identity || !options.authorizeProperty(response, identity.observer.propertyId)) {
      throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    }
    const body = bodyObject(request.body);
    rejectUnknown(body, ["position", "accuracyMeters", "zoneId"], "Observer position");
    const accuracy = body.accuracyMeters;
    if (typeof accuracy !== "number" || !Number.isFinite(accuracy)) {
      throw new TrackingError(400, "INVALID_FIELD", "accuracyMeters must be a finite number");
    }
    response.json({
      observer: store.updateObserverPosition(
        identity.observer.id,
        coordinate(body.position, "position"),
        accuracy,
        nullableString(body, "zoneId") ?? null,
      ),
    });
  });

  app.post(`${prefix}/tracking/evidence\\:batch`, (request, response) => {
    response.json(service.ingest(trackingEvidenceBatch(request.body), ingestionActor(options, response)));
  });

  app.get(`${prefix}/properties/:propertyId/tracked-equipment`, (request, response) => {
    service.requireEnabled();
    requireProperty(options, response, request.params.propertyId);
    service.refreshProperty(request.params.propertyId);
    response.json({ equipment: store.trackedEquipment(request.params.propertyId) });
  });

  app.get(`${prefix}/area-equipment/:equipmentId/tracking-position`, (request, response) => {
    service.requireEnabled();
    requireEquipment(options, response, request.params.equipmentId);
    response.json({
      position: store.evidence.currentPosition(request.params.equipmentId, store.dataMode()),
    });
  });

  app.get(`${prefix}/area-equipment/:equipmentId/tracking-position-history`, (request, response) => {
    service.requireEnabled();
    requireEquipment(options, response, request.params.equipmentId);
    response.json({
      positions: store.evidence.positionHistory(
        request.params.equipmentId,
        store.dataMode(),
        numericLimit(request.query.limit, 100, 500),
      ),
    });
  });

  app.put(`${prefix}/area-equipment/:equipmentId/manual-tracking-position`, (request, response) => {
    requireMember(options, response);
    requireEquipment(options, response, request.params.equipmentId);
    const equipment = store.core.getAreaEquipment(request.params.equipmentId)!;
    options.assertPropertyWriteAllowed(equipment.propertyId);
    response.json({ position: service.setManualLocation(equipment.id, manualLocationInput(request.body)) });
  });

  app.get(`${prefix}/area-equipment/:equipmentId/tracking-observations`, (request, response) => {
    service.requireEnabled();
    requireEquipment(options, response, request.params.equipmentId);
    const principal = options.principal(response);
    response.json({
      observations: service.equipmentObservations(
        request.params.equipmentId,
        numericLimit(request.query.limit, 100, 500),
        principal?.role === "owner" || principal?.role === "admin",
      ),
    });
  });

  app.get(`${prefix}/area-equipment/:equipmentId/tracking-find-descriptor`, (request, response) => {
    service.requireEnabled();
    requireMember(options, response);
    requireEquipment(options, response, request.params.equipmentId);
    response.setHeader("cache-control", "private, no-store");
    response.json(service.findDescriptor(request.params.equipmentId));
  });
}
