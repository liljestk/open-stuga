import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH, resolvePlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipmentInput,
  AreaEquipmentPatch,
  AreaEquipment,
  EquipmentAttachmentUploadInput,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybookInput,
  ActionRunStartInput,
  DataExportPrivacyLevel,
  AlertRule,
  AlertDeliveryPolicy,
  AppSession,
  AppleNotesMaintenanceCaptureResult,
  AppleNotesSnapshot,
  Floor,
  GeoCoordinate,
  GuestAccessGrant,
  HouseWeather,
  HouseLocation,
  HouseMapPlacement,
  HomeElectricityPricePoint,
  IntegrationStatus,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTask,
  ManualObservationInput,
  ManualObservationPatch,
  OpeningStateObservation,
  OpeningStateObservationInput,
  MeasurementDefinition,
  MeasurementSample,
  PropertyAreaInput,
  PropertyAreaPatch,
  Property,
  PropertyArea,
  PropertyCreateInput,
  PropertyInventorySnapshot,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyNote,
  PropertyPatch,
  PropertyElectricityConfigInput,
  Reading,
  Sensor,
  StaticParameter,
  TelemetryEvent,
  TenantMemberRole,
  TrackingFeatureFlags,
} from "@climate-twin/contracts";
import { configuredAlertWebhookDestinations, loadConfig, type AppConfig } from "../config.js";
import {
  ClimateDatabase,
  ClimateDataValidationError,
  outdoorLocationKey,
  type SecurityAuditEventInput,
  type SensorUpdate,
  type TapoHistoryExportJob,
  type TelemetryCascadeScope,
} from "../db.js";
import { TelemetryBus } from "../events.js";
import { HomeAssistantBridge, testHomeAssistantCredentials } from "../home-assistant.js";
import { mergeTpLinkHistoryRecovery, TpLinkBridge } from "../tp-link.js";
import { discoverHomeAssistant } from "../discovery.js";
import {
  readIntegrationSecrets,
  updateIntegrationSecrets,
  type AppleNotesGrantSecret,
  type IntegrationSecrets,
  type TpLinkConnectionSecret,
} from "../integration-secrets.js";
import { IntegrationMetadataStore } from "../integration-metadata.js";
import { openApiV1Document, openApiV2Document } from "../openapi.js";
import {
  FmiWeatherProvider,
  WeatherRequestSupersededError,
  WeatherService,
  WeatherUnavailableError,
  type WeatherProvider,
} from "../weather.js";
import {
  AlertEngine,
  DataModeCoordinator,
  forecast,
  forecastMeasurement,
  MeasurementService,
  MeasurementValidationError,
  MockEngine,
  MOCK_SCENARIOS,
  ReplayEngine,
  RuntimeStatus,
  TelemetryValidationError,
  TelemetryService,
} from "../services.js";
import { runThermalSimulation } from "../thermal-simulation.js";
import { runThermalIsolation } from "../thermal-isolation.js";
import { SYSTEM_VERSION } from "../version.js";
import { SystemUpdateError, SystemUpdateService } from "../system-updates.js";
import { LocationDiscoveryService } from "../location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider, prefersFmi } from "../open-meteo.js";
import { WeatherMonitor } from "../weather-monitor.js";
import { DailyAnalyticsFindingsWorker } from "../daily-analytics-findings.js";
import { WeatherRecoveryCoordinator } from "../weather-recovery.js";
import { SensorGapRecoveryCoordinator } from "../sensor-gap-recovery.js";
import {
  TAPO_CANARY_APPROVAL_MAX_AGE_MS,
  TapoHistoryCanaryError,
  TapoHistoryExportService,
} from "../tapo-history-export.js";
import {
  InMemoryWeatherEventBroker,
  WeatherEventSupersededError,
  type WeatherEventBroker,
} from "../weather-events.js";
import { TelegramService, TelegramServiceError } from "../telegram.js";
import { NotificationOutboxWorker } from "../outbox.js";
import { apnsConfigured } from "../apns.js";
import { normalizeAlertDeliveryPolicy } from "../notification-policy.js";
import {
  ElectricityEndpointPolicyError,
  ElectricityPriceService,
  publicElectricityConfiguration,
  validateElectricityEndpointUrl,
  type ElectricityEndpointResolver,
} from "../electricity-prices.js";
import {
  LocalAuthError,
  LocalAuthStore,
  type LocalAuthIdentity,
  type LocalAuthSession,
} from "../local-auth.js";
import { CloudflareAccessGroupSynchronizer } from "../cloudflare-access.js";
import {
  CloudflareSetupError,
  CloudflareSetupService,
  cloudflareSetupCallbackPath,
  type CloudflareSetupStartInput,
} from "../cloudflare-setup.js";
import {
  createLocalSpatialLayerRuntime,
  registerSpatialLayerRoutes,
  type LocalSpatialLayerRuntime,
} from "../spatial-layers/index.js";
import { LruTtlCache } from "../cache.js";
import { DataOperationsService } from "../data-operations.js";
import { EnergyOptimizer } from "../energy-optimizer.js";
import { EnergyCostService } from "../energy-cost.js";
import { SetupDoctor } from "../setup-doctor.js";
import { TimeseriesStore } from "../timeseries/store.js";
import {
  TelemetryArchiveWorker,
} from "../timeseries/archive-worker.js";
import {
  HybridTelemetryReader,
  bucketLegacyReadings,
  bucketMeasurementSamples,
  IncompleteTelemetryHistoryError,
} from "../timeseries/read-facade.js";
import { TelemetryRetentionWorker } from "../timeseries/retention-worker.js";
import {
  AnalyticsQueryError,
  buildAnalyticsResponse,
  parseAnalyticsCoverageRequest,
  parseAnalyticsQueryRequest,
} from "../analytics.js";
import { loadOrCreateStugubyNodeKeys } from "../stuguby/identity.js";
import { registerStugubyLocalRoutes, registerStugubyProtocolRoutes } from "../stuguby/routes.js";
import { StugubyError, StugubyService } from "../stuguby/service.js";
import { StugubyStore } from "../stuguby/store.js";
import { TrackingSecretBox, loadOrCreateTrackingKey } from "../tracking/crypto.js";
import { registerTrackingRoutes } from "../tracking/routes.js";
import { TrackingService } from "../tracking/service.js";
import {
  TrackingError,
  TrackingStore,
  type AuthenticatedTrackingObserver,
} from "../tracking/store.js";
import { AREA_EQUIPMENT_STATUSES, AuthAbuseLimiter, HttpError, LOCAL_CSRF_COOKIE, LOCAL_SESSION_COOKIE, LOCAL_SESSION_MAX_AGE_MS, LocalVisibility, MAINTENANCE_BASES, MAINTENANCE_CREATE_FIELDS, MAINTENANCE_PATCH_FIELDS, MAINTENANCE_PRIORITIES, MAINTENANCE_STATUSES, MAX_EQUIPMENT_ATTACHMENT_BYTES, MAX_EVENT_STREAMS_GLOBAL, MAX_EVENT_STREAMS_PER_USER, MAX_SSE_QUEUE_BYTES, MAX_SSE_QUEUE_MESSAGES, MEASUREMENT_ID_PATTERN, OBSERVATION_CONFIDENCES, OBSERVATION_CREATE_FIELDS, OBSERVATION_KINDS, OBSERVATION_PATCH_FIELDS, OBSERVATION_SEVERITIES, OBSERVATION_SOURCES, OBSERVATION_STATUSES, OBSERVATION_TIME_PRECISIONS, PROPERTY_AREA_KINDS, PROPERTY_NOTE_KINDS, RESERVED_MEASUREMENT_IDS, SAFE_ASSET_MIME_TYPES, SAFE_EQUIPMENT_DOCUMENT_MIME_TYPES, SAFE_EQUIPMENT_PHOTO_MIME_TYPES, SAFE_HTTP_METHODS, UUID_PATTERN, alertDurationSeconds, appleNotesCaptureInput, appleNotesCaptureMatches, appleNotesGrant, appleNotesGrantSummary, appleNotesSnapshot, assertEquipmentAttachmentMediaType, auditAccountSubject, authAttemptKeys, bodyObject, boundedQueryInteger, boundedSseWriter, browserOriginAllowed, clearLocalSessionCookies, cloudflareUiRedirectUri, collectionPage, completeVisibleCollection, cookieValue, credentialString, dateValue, enumValue, equipmentAttachmentData, equipmentAttachmentDisposition, homeAssistantUrl, houseLocationValue, houseMapPlacementValue, initializeIntegrationMetadata, isIOSNotificationRegistrationPath, isLoopbackSocket, isPrivateProxySocket, isTrackingObserverHeartbeatPath, keyMatches, localAuthorizationFingerprint, localCloudflareUiRequestAllowed, localSetupRequestAllowed, maintenanceDateValue, maintenanceObservationIds, maintenanceText, maintenanceTitle, measurementId, measurementNumberMap, measurementStringMap, measurementUnits, mirrorEnvironmentWebhook, networkHost, normalizedHostname, normalizedOrigin, notePlainLine, noteTaskBlock, nullableFinite, nullablePropertyTarget, optionalBoolean, optionalNullableNumber, optionalNullableString, optionalObservationDate, optionalQueryNumber, optionalResourceQuery, optionalString, parseActionPlaybookInput, parseActionRunStart, parseAlertDeliveryPolicy, parseAlertRule, parseAreaEquipmentInput, parseAreaEquipmentPatch, parseEquipmentAttachmentUpload, parseEquipmentLinkInput, parseEquipmentLinkPatch, parseMaintenanceTaskInput, parseMaintenanceTaskPatch, parseMeasurementDefinition, parseMeasurementSample, parseObservationInput, parseObservationPatch, parsePropertyAreaInput, parsePropertyAreaPatch, parsePropertyInput, parsePropertyNoteInput, parsePropertyNotePatch, parsePropertyPatch, parseReading, parseSensorPatch, persistWeatherObservation, propertyCoordinate, propertyPolygon, propertyText, publicTapoHistoryExportJob, queryList, refreshAppleNotesStatus, rejectUnknownFields, requestOrigin, requestPrincipal, requireJsonContentType, requireNonGuest, requireWorkspaceAdmin, requiredNumber, requiredString, safeInteger, sameHomeAssistantCredential, sameTelegramCredential, sameTpLinkCredential, secureRequest, sessionDocument, setLocalSessionCookies, stringMap, trackingObserverAttemptKeys, trustedProxyClientAddress, trustedProxyRequest, trustedSelfHostname, validateMeasurementDefinition, visibleCollectionPage, workerTapoHistoryExportJob } from "./support/index.js";
import type { ApiRuntime, AuthAttemptBucket, AuthAttemptLimit, BoundedSseWriter, CreateApiOptions, IntegrationDraftTestResult, LocalRequestPrincipal } from "./support/index.js";
import { configureApiPart07 } from "./part-07.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart08(context: ReturnType<typeof configureApiPart07>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.post(`${context.prefix}/auth/setup`, async (request, response) => {
      requireJsonContentType(request);
      const configuredSecret = config.localAuthBootstrapSecret ?? null;
      const providedSecret = request.header("x-stugu-bootstrap-secret");
      const secretAuthorized = Boolean(configuredSecret && providedSecret && keyMatches(providedSecret, configuredSecret));
      if (!localSetupRequestAllowed(request, config) && !secretAuthorized) {
        throw new HttpError(403, "BOOTSTRAP_LOCAL_ONLY", "First-owner setup is restricted to the local machine");
      }
      if (context.localAuth.isInitialized()) {
        throw new HttpError(409, "AUTH_ALREADY_INITIALIZED", "Local authentication has already been initialized");
      }
      const body = bodyObject(request.body);
      const release = context.authAbuseLimiter.enter(authAttemptKeys(request, config, "setup", body.email), response);
      try {
        const identity = await context.localAuth.createFirstOwner(body.email, body.password);
        const issued = context.localAuth.issueSession(identity);
        setLocalSessionCookies(response, request, config, issued.token, issued.session.csrfToken);
        context.recordSecurityAudit(identity, {
          eventType: "auth.owner.created",
          subjectType: "account",
          subjectId: identity.email,
          details: { role: identity.role },
        });
        const cloudflareAccessStatus = await context.synchronizeCloudflareAccess();
        response.status(201).json({
          ...sessionDocument(issued.session, issued.session.csrfToken),
          cloudflareAccess: cloudflareAccessStatus,
        });
      } finally {
        release();
      }
    });
  context.app.post(`${context.prefix}/auth/register`, async (request, response) => {
      requireJsonContentType(request);
      if (!context.localAuth.isInitialized()) {
        throw new HttpError(409, "SETUP_REQUIRED", "Create the first owner before accepting invitations");
      }
      const body = bodyObject(request.body);
      const release = context.authAbuseLimiter.enter(authAttemptKeys(request, config, "register", body.token), response);
      try {
        const identity = await context.localAuth.registerInvitation(body.token, body.password, body.email);
        const issued = context.localAuth.issueSession(identity);
        setLocalSessionCookies(response, request, config, issued.token, issued.session.csrfToken);
        context.recordSecurityAudit(identity, {
          eventType: "auth.invitation.accepted",
          subjectType: "account",
          subjectId: identity.email,
          details: { role: identity.role, grantCount: identity.grants.length },
        });
        response.status(201).json(sessionDocument(issued.session, issued.session.csrfToken));
      } finally {
        release();
      }
    });
  context.app.post(`${context.prefix}/auth/login`, async (request, response) => {
      requireJsonContentType(request);
      if (!context.localAuth.isInitialized()) {
        throw new HttpError(409, "SETUP_REQUIRED", "Create the first owner before signing in");
      }
      const body = bodyObject(request.body);
      const release = context.authAbuseLimiter.enter(authAttemptKeys(request, config, "login", body.email), response);
      try {
        let identity: LocalAuthIdentity | null;
        try {
          identity = await context.localAuth.verifyCredentials(body.email, body.password);
        } catch (error) {
          context.recordSecurityAudit(null, {
            eventType: "auth.login",
            outcome: "denied",
            subjectType: "account",
            subjectId: auditAccountSubject(body.email),
            details: { reason: error instanceof LocalAuthError ? error.code : "VERIFICATION_FAILED" },
          });
          throw error;
        }
        if (!identity) {
          context.recordSecurityAudit(null, {
            eventType: "auth.login",
            outcome: "denied",
            subjectType: "account",
            subjectId: auditAccountSubject(body.email),
            details: { reason: "INVALID_CREDENTIALS" },
          });
          throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
        }
        const previousToken = cookieValue(request, LOCAL_SESSION_COOKIE);
        if (previousToken) context.localAuth.revokeSession(previousToken);
        const issued = context.localAuth.issueSession(identity);
        setLocalSessionCookies(response, request, config, issued.token, issued.session.csrfToken);
        context.recordSecurityAudit(identity, {
          eventType: "auth.login",
          subjectType: "account",
          subjectId: identity.email,
          details: { role: identity.role },
        });
        response.json(sessionDocument(issued.session, issued.session.csrfToken));
      } finally {
        release();
      }
    });
  context.app.post(`${context.prefix}/auth/logout`, (request, response) => {
      const principal = requestPrincipal(response);
      context.localAuth.revokeSession(cookieValue(request, LOCAL_SESSION_COOKIE));
      context.recordSecurityAudit(principal, {
        eventType: "auth.logout",
        subjectType: "account",
        subjectId: principal.email || principal.userId,
      });
      clearLocalSessionCookies(response, request, config);
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/tenant/members`, requireWorkspaceAdmin, (_request, response) => {
      const directory = context.localAuth.listWorkspaceMembers();
      if (context.cloudflareAccess) void context.synchronizeCloudflareAccess();
      response.json(directory);
    });
  context.app.post(`${context.prefix}/tenant/members`, requireWorkspaceAdmin, async (request, response) => {
      requireJsonContentType(request);
      const body = bodyObject(request.body);
      const role = enumValue(body.role, ["admin", "member", "guest"] as const, "role");
      const principal = requestPrincipal(response);
      const grants = body.grants === undefined ? [] : body.grants;
      if (!Array.isArray(grants)) throw new HttpError(400, "INVALID_GRANTS", "grants must be an array");
      const created = context.localAuth.inviteMember(principal, body.email, role, grants as GuestAccessGrant[]);
      context.recordSecurityAudit(principal, {
        eventType: "membership.invitation.created",
        subjectType: "workspace-member",
        subjectId: created.invitation.email,
        details: { role: created.invitation.role, grantCount: created.invitation.grants.length },
      });
      const cloudflareAccessStatus = await context.synchronizeCloudflareAccess();
      response.status(201).json({
        invitation: created.invitation,
        registrationToken: created.registrationToken,
        // URL fragments remain client-side and avoid leaking the one-time token
        // through HTTP access logs, browser referrers, or intermediary caches.
        activationPath: `/invite-bootstrap#invite=${encodeURIComponent(created.registrationToken)}`,
        expiresAt: created.expiresAt,
        cloudflareAccess: cloudflareAccessStatus,
      });
    });
  context.app.put(`${context.prefix}/tenant/members/:email/access`, requireWorkspaceAdmin, (request, response) => {
      requireJsonContentType(request);
      const body = bodyObject(request.body);
      if (!Array.isArray(body.grants)) throw new HttpError(400, "INVALID_GRANTS", "grants must be an array");
      const member = context.localAuth.updateMemberAccess(request.params.email, body.grants as GuestAccessGrant[]);
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "membership.grants.replaced",
        subjectType: "workspace-member",
        subjectId: member.email,
        details: { grantCount: member.grants.length },
      });
      response.json({ member });
    });
  context.app.delete(`${context.prefix}/tenant/members/:email`, requireWorkspaceAdmin, async (request, response) => {
      const principal = requestPrincipal(response);
      if (!context.localAuth.removeMember(request.params.email, principal)) {
        throw new HttpError(404, "MEMBER_NOT_FOUND", "Member or invitation not found");
      }
      context.recordSecurityAudit(principal, {
        eventType: "membership.revoked",
        subjectType: "workspace-member",
        subjectId: auditAccountSubject(request.params.email),
      });
      await context.synchronizeCloudflareAccess();
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/security/audit-events`, requireWorkspaceAdmin, (request, response) => {
      const limit = boundedQueryInteger(request.query.limit, "limit", 1, 500) ?? 100;
      const offset = boundedQueryInteger(request.query.offset, "offset", 0, 1_000_000) ?? 0;
      response.json({ events: context.database.listSecurityAuditEvents(limit, offset) });
    });
  context.app.get(`${context.prefix}/system/updates`, requireWorkspaceAdmin, (_request, response) => {
      response.setHeader("cache-control", "no-store");
      response.json(context.systemUpdates.status());
    });
  const extended = Object.assign(context, {  });
  return extended;
}
