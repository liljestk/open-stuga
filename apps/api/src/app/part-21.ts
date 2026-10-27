import { type Request } from "express";
import type {
  StaticParameter,
} from "@climate-twin/contracts";
import { type AppConfig } from "../config.js";
import { discoverHomeAssistant } from "../discovery.js";
import {
  updateIntegrationSecrets,
} from "../integration-secrets.js";
import { IntegrationDiscoveryJobs } from "../integration-discovery-jobs.js";
import { HttpError, SAFE_ASSET_MIME_TYPES, bodyObject, boundedSseWriter, credentialString, enumValue, localAuthorizationFingerprint, optionalString, requestPrincipal, requiredString, safeInteger } from "./support/index.js";
import { configureApiPart20 } from "./part-20.js";
import { registerGreeRoutes } from "../gree-routes.js";
import { registerTuyaRoutes } from "../tuya-routes.js";
import { registerAnalyticsRoutes } from "../analytics/routes.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart21(context: ReturnType<typeof configureApiPart20>) {
  const config = context.config as NormalizedApiConfig;
  const integrationDiscoveryJobs = new IntegrationDiscoveryJobs();
  registerGreeRoutes(context);
  registerTuyaRoutes(context);
  const removeAnalyticsCacheWake = registerAnalyticsRoutes(context);
  context.app.delete(`${context.prefix}/maintenance-tasks/:id`, (request, response) => {
      const taskId = request.params.id as string;
      const previous = context.database.getMaintenanceTask(taskId);
      if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      context.database.transaction(() => {
        if (!context.database.deleteMaintenanceTask(taskId)) {
          throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
        }
        if (previous) context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "maintenance", taskId, "delete");
      });
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/parameters`, (request, response) => {
      const access = context.visibility(response);
      response.json({ parameters: context.database.listParameters(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((parameter) => access.house(parameter.houseId)) });
    });
  context.app.post(`${context.prefix}/parameters`, (request, response) => {
      const body = bodyObject(request.body);
      if (!["string", "number", "boolean"].includes(typeof body.value)) throw new HttpError(400, "INVALID_FIELD", "value must be a string, number, or boolean");
      const houseId = requiredString(body, "houseId");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const parameter = context.database.saveParameter({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        houseId,
        scopeType: enumValue(body.scopeType, ["house", "floor", "room", "sensor"] as const, "scopeType"),
        scopeId: requiredString(body, "scopeId"), key: requiredString(body, "key"),
        value: body.value as StaticParameter["value"], unit: body.unit === null ? null : optionalString(body, "unit") ?? null,
        label: requiredString(body, "label"),
      });
      response.status(200).json({ parameter });
    });
  context.app.get(`${context.prefix}/static-parameters`, (request, response) => {
      const access = context.visibility(response);
      response.json({ parameters: context.database.listParameters(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((parameter) => access.house(parameter.houseId)) });
    });
  context.app.post(`${context.prefix}/static-parameters`, (request, response) => {
      const body = bodyObject(request.body);
      if (!["string", "number", "boolean"].includes(typeof body.value)) throw new HttpError(400, "INVALID_FIELD", "value must be a string, number, or boolean");
      const houseId = requiredString(body, "houseId");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const parameter = context.database.saveParameter({
        houseId, scopeType: enumValue(body.scopeType, ["house", "floor", "room", "sensor"] as const, "scopeType"),
        scopeId: requiredString(body, "scopeId"), key: requiredString(body, "key"), value: body.value as StaticParameter["value"],
        unit: body.unit === null ? null : optionalString(body, "unit") ?? null, label: requiredString(body, "label"),
      });
      response.status(201).json(parameter);
    });
  context.app.delete(`${context.prefix}/parameters/:id`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.listParameters().find((parameter) => parameter.id === id);
      if (current) context.stuguby.assertHouseLocalAuthority(current.houseId);
      if (!context.database.deleteParameter(id)) throw new HttpError(404, "NOT_FOUND", "Static parameter not found");
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/assets`, (request, response) => {
      const access = context.visibility(response);
      response.json({ assets: context.database.listAssets(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((asset) => access.house(asset.houseId)) });
    });
  context.app.post(`${context.prefix}/assets`, (request, response) => {
      const body = bodyObject(request.body);
      const houseId = requiredString(body, "houseId");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const mimeType = requiredString(body, "mimeType").toLowerCase();
      if (!SAFE_ASSET_MIME_TYPES.has(mimeType)) {
        throw new HttpError(415, "UNSUPPORTED_ASSET_TYPE", "Assets must be PNG, JPEG, WebP, glTF, or GLB");
      }
      const encoded = requiredString(body, "data").replace(/^data:[^;]+;base64,/, "");
      const data = Buffer.from(encoded, "base64");
      if (data.length === 0) throw new HttpError(400, "INVALID_ASSET", "data must contain valid base64 bytes");
      if (data.length > 10 * 1024 * 1024) throw new HttpError(413, "ASSET_TOO_LARGE", "Decoded assets are limited to 10 MiB");
      const asset = context.database.createAsset({
        houseId, name: requiredString(body, "name"), mimeType,
        kind: enumValue(body.kind, ["floor-plan", "model-3d", "other"] as const, "kind"), data,
      });
      response.status(201).json({ asset, url: `${context.prefix}/assets/${asset.id}` });
    });
  context.app.get(`${context.prefix}/assets/:id`, (request, response) => {
      const asset = context.database.getAsset(request.params.id as string);
      if (!asset || !context.visibility(response).house(asset.houseId)) throw new HttpError(404, "NOT_FOUND", "Asset not found");
      response.setHeader("content-type", asset.mimeType);
      response.setHeader("content-length", String(asset.size));
      response.setHeader("content-security-policy", "sandbox; default-src 'none'");
      const disposition = asset.mimeType.startsWith("image/") ? "inline" : "attachment";
      response.setHeader("content-disposition", `${disposition}; filename="${asset.name.replace(/["\r\n]/g, "_")}"`);
      response.send(Buffer.from(asset.data));
    });
  context.app.delete(`${context.prefix}/assets/:id`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getAsset(id);
      if (current) context.stuguby.assertHouseLocalAuthority(current.houseId);
      if (!context.database.deleteAsset(id)) throw new HttpError(404, "NOT_FOUND", "Asset not found");
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/integrations/status`, (request, response) => {
      context.dataMode.synchronize();
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : undefined;
      if (houseId && !context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      response.json(context.integrationStatusForHouse(houseId));
    });
  context.app.get(`${context.prefix}/integrations/sensor-data-gaps`, (request, response) => {
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : undefined;
      const sensorId = typeof request.query.sensorId === "string" ? request.query.sensorId.trim() : undefined;
      const access = context.visibility(response);
      if (houseId && (!context.database.getHouse(houseId) || !access.house(houseId))) {
        throw new HttpError(404, "NOT_FOUND", "House not found");
      }
      const limit = safeInteger(request.query.limit, 100, 1, 1_000);
      const visibleHouseIds = houseId
        ? [houseId]
        : access.restricted
          ? context.database.listHouses().filter((house) => access.house(house.id)).map((house) => house.id)
          : null;
      const gaps = (visibleHouseIds === null
        ? context.database.listSensorDataGaps(sensorId, limit)
        : visibleHouseIds
          .flatMap((visibleHouseId) => context.database.listHouseSensorDataGaps(visibleHouseId, sensorId, limit))
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id - left.id)
          .slice(0, limit))
        .filter((gap) => {
          const sensor = context.database.getSensor(gap.sensorId);
          return Boolean(sensor && access.sensor(gap.sensorId));
        });
      response.json({ gaps });
    });
  const integrationDiscovery = async (
      houseId?: string,
      draftCredentials?: { username: string; password: string },
    ) => {
      if (context.options.integrationDiscoverer) {
        const result = await context.options.integrationDiscoverer(houseId, draftCredentials);
        return { ...result, tuya: [] };
      }
      const [homeAssistantResult, tpLinkResult, greeResult] = await Promise.allSettled([
        discoverHomeAssistant(),
        context.tpLink.discoverSources(houseId, draftCredentials),
        context.gree.discoverSources(houseId),
      ]);
      const warnings: string[] = [];
      if (homeAssistantResult.status === "rejected") warnings.push("Home Assistant discovery was unavailable. Enter its address manually.");
      if (tpLinkResult.status === "rejected") warnings.push("TP-Link discovery was unavailable. Enter the hub or energy-device address manually.");
      else warnings.push(...tpLinkResult.value.warnings);
      if (greeResult.status === "rejected" && (config.greeConnections?.length ?? 0) > 0) {
        warnings.push("Gree/Wilfa heat-pump discovery was unavailable.");
      }
      return {
        homeAssistant: homeAssistantResult.status === "fulfilled" ? homeAssistantResult.value : [],
        tpLink: tpLinkResult.status === "fulfilled" ? tpLinkResult.value.sources : [],
        gree: greeResult.status === "fulfilled" ? greeResult.value : [],
        tuya: [],
        warnings,
      };
    };
  const discoveryInput = (request: Request) => {
      const body = bodyObject(request.body);
      const houseId = body.houseId === undefined ? undefined : requiredString(body, "houseId");
      if (houseId && !context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      if (houseId) context.stuguby.assertHouseLocalAuthority(houseId);
      const hasDraftUsername = body.tpLinkUsername !== undefined;
      const hasDraftPassword = body.tpLinkPassword !== undefined;
      if (hasDraftUsername !== hasDraftPassword) {
        throw new HttpError(400, "INVALID_TP_LINK_CREDENTIALS", "tpLinkUsername and tpLinkPassword must be supplied together");
      }
      const draftCredentials = hasDraftUsername && hasDraftPassword
        ? {
            username: credentialString(body, "tpLinkUsername", 320, true),
            password: credentialString(body, "tpLinkPassword", 4_096),
          }
        : undefined;
      return { houseId, draftCredentials };
    };
  context.app.post(`${context.prefix}/integrations/discover`, async (request, response) => {
      const { houseId, draftCredentials } = discoveryInput(request);
      response.json(await integrationDiscovery(houseId, draftCredentials));
    });
  context.app.post(`${context.prefix}/integrations/discovery-jobs`, (request, response) => {
      const { houseId, draftCredentials } = discoveryInput(request);
      if (!houseId) throw new HttpError(400, "HOUSE_REQUIRED", "houseId is required for background discovery");
      const principal = requestPrincipal(response);
      const ownerId = principal.userId;
      const job = integrationDiscoveryJobs.start(
        ownerId,
        houseId,
        () => integrationDiscovery(houseId, draftCredentials),
      );
      response.status(202).json({ job });
    });
  context.app.get(`${context.prefix}/integrations/discovery-jobs/latest`, (request, response) => {
      const houseId = requiredString(request.query, "houseId");
      if (!context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(houseId);
      response.json({ job: integrationDiscoveryJobs.latest(requestPrincipal(response).userId, houseId) });
    });
  context.app.get(`${context.prefix}/integrations/discovery-jobs/events`, (request, response) => {
      if (context.rejectEventStreamDuringShutdown(response)) return;
      const ownerId = requestPrincipal(response).userId;
      const jobId = requiredString(request.query, "jobId");
      const initialJob = integrationDiscoveryJobs.get(ownerId, jobId);
      if (!initialJob) throw new HttpError(404, "DISCOVERY_JOB_NOT_FOUND", "Device discovery job not found");
      context.stuguby.assertHouseLocalAuthority(initialJob.houseId);
      const releaseStream = context.acquireEventStream(response);
      if (!releaseStream) {
        response.setHeader("retry-after", "5");
        throw new HttpError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
      }
      const acceptedAuthorization = localAuthorizationFingerprint(requestPrincipal(response));
      response.status(200);
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders();
      const writer = boundedSseWriter(response);
      const write = (job: ReturnType<typeof integrationDiscoveryJobs.get>) => {
        if (!job || job.id !== jobId || response.destroyed || response.writableEnded) return;
        const access = context.authorizedStreamVisibility(request, response, acceptedAuthorization);
        if (!access?.house(job.houseId)) return;
        writer.send(`event: integration-discovery\ndata: ${JSON.stringify(job)}\n\n`);
      };
      const unsubscribe = integrationDiscoveryJobs.subscribe(ownerId, write);
      write(integrationDiscoveryJobs.get(ownerId, jobId));
      const heartbeat = setInterval(() => {
        if (response.destroyed || response.writableEnded) return;
        if (!context.authorizedStreamVisibility(request, response, acceptedAuthorization)) return;
        writer.send(": keep-alive\n\n");
      }, 15_000);
      heartbeat.unref();
      context.registerEventStream(
        request,
        response,
        () => { clearInterval(heartbeat); unsubscribe(); writer.dispose(); },
        releaseStream,
      );
    });
  context.app.get(`${context.prefix}/integrations/discovery-jobs/:id`, (request, response) => {
      const job = integrationDiscoveryJobs.get(requestPrincipal(response).userId, request.params.id as string);
      if (!job) throw new HttpError(404, "DISCOVERY_JOB_NOT_FOUND", "Device discovery job not found");
      context.stuguby.assertHouseLocalAuthority(job.houseId);
      response.json({ job });
    });
  context.app.post(`${context.prefix}/integrations/telegram/discover`, async (request, response) => {
      const body = bodyObject(request.body);
      response.json(await context.telegram.discover(credentialString(body, "botToken", 256, true)));
    });
  context.app.put(`${context.prefix}/integrations/telegram/config`, async (request, response) => {
      const generation = ++context.telegramConfigurationGeneration;
      const body = bodyObject(request.body);
      const botToken = credentialString(body, "botToken", 256, true);
      const chatId = credentialString(body, "chatId", 32, true);
      const rotatingCredentials = Boolean(config.telegramBotToken && config.telegramChatId);
      const identity = await context.telegram.verify(botToken, chatId);
      if (generation !== context.telegramConfigurationGeneration) {
        throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer Telegram configuration change superseded this request");
      }
      context.notificationOutbox.fenceTelegramConfigurationChange();
      updateIntegrationSecrets(config.integrationSecretsFile, { telegram: { botToken, chatId } });
      context.integrationMetadata.saveTelegramIdentity({
        botUsername: identity.botUsername,
        chatLabel: identity.chatLabel,
      });
      config.telegramBotToken = botToken;
      config.telegramChatId = chatId;
      context.telegramDeliveryGeneration += 1;
      const telegramStatus = context.status.value.telegram!;
      telegramStatus.configured = true;
      telegramStatus.connected = false;
      telegramStatus.botUsername = identity.botUsername;
      telegramStatus.chatLabel = identity.chatLabel;
      telegramStatus.lastDeliveryAt = null;
      telegramStatus.error = null;
      context.status.changed();
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: rotatingCredentials ? "integration.credentials.rotated" : "integration.credentials.configured",
        subjectType: "integration",
        subjectId: "telegram",
        details: { integration: "telegram" },
      });
      response.json({ ok: true, configured: true, integration: structuredClone(context.status.value) });
    });
  const extended = Object.assign(context, { integrationDiscoveryJobs, removeAnalyticsCacheWake });
  return extended;
}
