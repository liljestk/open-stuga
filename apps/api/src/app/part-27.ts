import { startArchiveMaintenance } from "../timeseries/archive-maintenance.js";
import { type NextFunction, type Request, type Response } from "express";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { type AppConfig } from "../config.js";
import {
  ClimateDataValidationError,
} from "../db.js";
import {
  MeasurementValidationError,
  MOCK_SCENARIOS,
  TelemetryValidationError,
} from "../services.js";
import { TelegramServiceError } from "../telegram.js";
import {
  LocalAuthError,
} from "../local-auth.js";
import {
  registerSpatialLayerRoutes,
} from "../spatial-layers/index.js";
import {
  IncompleteTelemetryHistoryError,
} from "../timeseries/read-facade.js";
import { RollupsMaterializingError } from "../timeseries/read-support.js";
import { StugubyError } from "../stuguby/service.js";
import { registerTrackingRoutes } from "../tracking/routes.js";
import {
  TrackingError,
  type AuthenticatedTrackingObserver,
} from "../tracking/store.js";
import { HttpError, LocalVisibility, bodyObject, dateValue, enumValue, isRequestCancellation, requestPrincipal } from "./support/index.js";
import type { LocalRequestPrincipal } from "./support/index.js";
import { configureApiPart26 } from "./part-26.js";
import { AnalyticsCapacityError } from "../analytics/work-limiter.js";
import { LocalTelemetryTimeoutError } from "../timeseries/local-telemetry-worker.js";

type DeferredContext = {
  runtimeReady: Promise<void>;
};

type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart27(context: ReturnType<typeof configureApiPart26>) {
  const deferred = context as typeof context & DeferredContext;
  const config = context.config as NormalizedApiConfig;
  context.app.get(`${context.prefix}/integrations/tp-link/setup`, (request, response) => {
      const houseStatus = context.integrationStatusForHouse(typeof request.query.houseId === "string" ? request.query.houseId : undefined).tpLink;
      response.json({
      configured: houseStatus.configured,
      connections: houseStatus.connections ?? [],
      supportedHubs: ["H100", "H200", "H500"],
      supportedClimateSensors: ["T310", "T315"],
      supportedContactSensors: ["T110"],
      supportedEnergyDevices: "Configured TP-Link/Kasa hosts that python-kasa exposes through Module.Energy",
      steps: [
        "Install python-kasa from apps/api/python/requirements.txt (already included in the Docker image).",
        "Select the owning house, discover an H100/H200/H500 hub or supported energy device, or enter a reserved LAN address, then save the house-scoped TP-Link connection.",
        "Inspect /api/v1/integrations/tp-link/devices for normalized climate, contact, and energy devices.",
        "Assign a discovered device by PATCHing its stable deviceId into a sensor's tpLinkDeviceId field.",
        "Attach a T110 contact to an operable door or window by saving a Tapo stateBinding on that floor-plan element.",
      ],
      sensorPatchSchema: { tpLinkDeviceId: "hub-child-device-id" },
      deviceMapSchema: { devices: [{ deviceId: "hub-child-device-id", sensorId: "sensor-01" }] },
      notes: [
        "The helper polls the hub over the local LAN; credentials are passed through its process environment and are never returned or stored in SQLite.",
        "Web-saved credentials live in the protected integration secrets file; TP_LINK_* environment variables remain advanced overrides.",
        "TP_LINK_DEVICE_MAP_FILE remains supported as an optional legacy fallback; database sensor bindings take precedence.",
        "Set tpLinkDeviceId to null to unassign a child device without deleting the sensor or its history.",
        "Home Assistant and direct TP-Link bridges can run at the same time, but the same physical child should be mapped through only one path.",
        "Direct smart energy devices provide power when current_consumption is available and cumulative kWh only when consumption_total is available; daily/monthly reset counters are not mapped to energy.",
        "TP-Link provides consumption only. Property electricity prices are fetched separately from the configured price API (Pörssisähkö by default).",
        "LAN Find devices discovers H100/H200/H500 hubs and uses saved or request-scoped draft TP-Link credentials to include devices that python-kasa verifies through Module.Energy; draft credentials are never persisted.",
        "H500 support is capability-based: Stugu uses only child devices exposed by the hub's local API and reports when the hub advertises additional paired devices that remain hidden.",
        "Saving a real integration permanently disables mock telemetry for this database and purges existing demo samples and mock-derived alert events.",
      ],
      });
    });
  context.app.get(`${context.prefix}/mock/scenarios`, (_request, response) => {
      context.dataMode.synchronize();
      response.json({ scenarios: MOCK_SCENARIOS, active: context.mock.scenario, enabled: context.status.value.mock.enabled });
    });
  context.app.put(`${context.prefix}/mock/scenario`, (request, response) => {
      const scenario = enumValue(bodyObject(request.body).scenario, MOCK_SCENARIOS.map((item) => item.id), "scenario");
      context.mock.setScenario(scenario);
      response.json({ active: context.mock.scenario });
    });
  context.app.post(`${context.prefix}/mock/scenario`, (request, response) => {
      const body = bodyObject(request.body);
      const scenario = enumValue(body.scenarioId ?? body.scenario, MOCK_SCENARIOS.map((item) => item.id), "scenarioId");
      context.mock.setScenario(scenario);
      response.json({ ok: true, active: context.mock.scenario });
    });
  context.app.post(`${context.prefix}/mock/tick`, (_request, response) => response.status(201).json({ readings: context.mock.generate(), scenario: context.mock.scenario }));
  context.app.get(`${context.prefix}/replay`, (_request, response) => response.json({ replay: context.replay.state }));
  context.app.post(`${context.prefix}/replay`, async (request, response) => {
      const body = bodyObject(request.body);
      const sensorIds = Array.isArray(body.sensorIds)
        ? body.sensorIds.filter((id): id is string => typeof id === "string")
        : context.database.listSensors()
            .filter((sensor) => {
              const house = context.database.getHouse(sensor.houseId);
              return Boolean(house && hasLocalHouseAuthority(house));
            })
            .map((sensor) => sensor.id);
      for (const sensorId of sensorIds) {
        const sensor = context.database.getSensor(sensorId);
        if (!sensor) throw new HttpError(404, "NOT_FOUND", `Sensor ${sensorId} not found`);
        context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      }
      const to = dateValue(body.to, new Date(), "to");
      const from = dateValue(body.from, new Date(Date.parse(to) - 3_600_000), "from");
      const speed = typeof body.speed === "number" ? body.speed : 60;
      const readings = (await context.telemetryReader.legacyReadingHistory({ sensorIds, from, to, limit: 50_000 })).records;
      response.status(202).json({ replay: context.replay.startReadings(readings, from, to, speed) });
    });
  context.app.delete(`${context.prefix}/replay`, (_request, response) => response.json({ replay: context.replay.stop() }));
  registerTrackingRoutes(context.app, {
      service: context.tracking,
      prefix: context.prefix,
      principal: (response) => {
        const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
        return principal
          ? {
              userId: principal.userId,
              label: principal.email || "Property member",
              role: principal.role,
            }
          : null;
      },
      machineObserver: (response) => (
        response.locals.trackingObserver as AuthenticatedTrackingObserver | undefined
      ) ?? null,
      authorizeProperty: (response, propertyId) => {
        const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
        return principal ? new LocalVisibility(context.database, principal).hasProperty(propertyId) : false;
      },
      authorizeEquipment: (response, equipmentId) => {
        const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
        const equipment = context.database.getAreaEquipment(equipmentId);
        return Boolean(
          principal
          && equipment
          && new LocalVisibility(context.database, principal).equipment(equipment),
        );
      },
      assertPropertyWriteAllowed: (propertyId) => context.stuguby.assertPropertyWriteAllowed(propertyId),
      streamAuthorizationFingerprint: context.streamAuthorizationFingerprint,
      validateStream: (_request, response) => !context.rejectEventStreamDuringShutdown(response),
      acquireStream: (_request, response) => context.acquireEventStream(response),
      registerStream: context.registerEventStream,
    });
  registerSpatialLayerRoutes(context.app, {
      runtime: context.spatialLayers,
      prefix: context.prefix,
      authorizeScope: (request, response, scope) => {
        const access = request.path === `${context.prefix}/layers/events`
          ? context.currentStreamVisibility(request, response)
          : context.visibility(response);
        if (!access) return false;
        // A property aggregate may contain several houses, so a guest needs the
        // property-level grant. House-specific grants remain usable through the
        // corresponding house layer endpoint.
        return scope.kind === "house" ? access.house(scope.id) : access.hasProperty(scope.id);
      },
      authorizeMutation: (_request, response, scope) => {
        if (requestPrincipal(response).role === "guest") return false;
        try {
          if (scope.kind === "house") {
            context.stuguby.assertHouseWriteAllowed(scope.id);
            context.stuguby.assertHouseLocalAuthority(scope.id);
          } else {
            context.stuguby.assertPropertyWriteAllowed(scope.id);
          }
          return true;
        } catch {
          return false;
        }
      },
      auditActor: (_request, response) => requestPrincipal(response).userId,
      streamAuthorizationFingerprint: context.streamAuthorizationFingerprint,
      validateStream: (_request, response) => !context.rejectEventStreamDuringShutdown(response),
      acquireStream: (_request, response) => context.acquireEventStream(response),
    });
  context.app.use(`${context.prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  context.app.use(`${context.v2Prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  context.app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      if (error instanceof LocalTelemetryTimeoutError) {
        response.setHeader("retry-after", "1");
        response.status(503).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof AnalyticsCapacityError) {
        response.setHeader("retry-after", String(error.retryAfterSeconds));
        response.status(503).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof IncompleteTelemetryHistoryError) {
        response.status(503).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof RollupsMaterializingError) {
        response.setHeader("retry-after", String(error.retryAfterSeconds));
        response.status(503).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof LocalAuthError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof TrackingError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof ClimateDataValidationError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof StugubyError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof TelemetryValidationError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof MeasurementValidationError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof TelegramServiceError) {
        response.status(error.status).json({ error: { code: `TELEGRAM_${error.code}`, message: error.message } });
        return;
      }
      if (error instanceof HttpError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } });
        return;
      }
      const message = error instanceof Error ? error.message : "Unexpected error";
      const httpError = error as { status?: unknown; type?: unknown };
      if (httpError.status === 413 || httpError.type === "entity.too.large") {
        const limit = typeof response.locals.accountBodyLimit === "string"
          ? response.locals.accountBodyLimit
          : "15 MiB";
        response.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds the ${limit} limit` } });
        return;
      }
      if (message.includes("FOREIGN KEY constraint failed")) {
        response.status(409).json({ error: { code: "INVALID_REFERENCE", message: "A referenced resource does not exist" } });
        return;
      }
      if (message.includes("UNIQUE constraint failed")) {
        response.status(409).json({ error: { code: "CONFLICT", message: "A resource with this identifier already exists" } });
        return;
      }
      if (message.includes("DEMO_DATA_DISABLED")) {
        response.status(409).json({ error: { code: "DEMO_DATA_DISABLED", message: "Demo telemetry is permanently disabled for this real-data database" } });
        return;
      }
      if (error instanceof SyntaxError) {
        response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
        return;
      }
      if (isRequestCancellation(error)) {
        // Nothing failed: the caller left, or the work was cancelled on its behalf.
        // Reporting these as errors buried the real ones in the system error log.
        if (!response.headersSent && !response.writableEnded && !response.destroyed) {
          response.setHeader("retry-after", "1");
          response.status(503).json({
            error: { code: "REQUEST_CANCELLED", message: "The request was cancelled before it completed" },
          });
        }
        return;
      }
      context.systemErrorLog.record({
        source: "api",
        code: error instanceof Error ? error.name : "UNEXPECTED_ERROR",
        message,
      });
      response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
    });
  const initialRuntimeReady: Promise<void> = Promise.resolve();
  Object.assign(context, { runtimeReady: initialRuntimeReady });
  if (context.options.startBackground && context.telemetryArchive) {
      const starting = startArchiveMaintenance(context.telemetryArchive, context.telemetryOrderedRollups, context.telemetryRetention);
      deferred.runtimeReady = config.timeseriesRequired
        ? starting
        : starting.catch(() => {
          // SQLite remains durable and the worker retries. Never log connection
          // configuration because it contains a database credential.
          console.error("[telemetry-archive] Optional TimescaleDB archive is unavailable; SQLite buffering continues");
        });
      void deferred.runtimeReady.catch(() => undefined);
    }
  const extended = Object.assign(context, {  });
  return extended as typeof extended & { runtimeReady: Promise<void> };
}
