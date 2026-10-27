import { updateIntegrationSecrets } from "../integration-secrets.js";
import { HttpError, bodyObject, credentialString, homeAssistantUrl, requestPrincipal, requiredString, requireWorkspaceAdmin } from "./support/index.js";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Home Assistant connection configuration, tests and setup. */
export function registerHomeAssistantRoutes(context: ApiRouteRegistrationContext): void {
  const config = context.config;
  context.app.post(`${context.prefix}/integrations/home-assistant/test-draft`, requireWorkspaceAdmin, async (request, response) => {
      response.setHeader("cache-control", "no-store");
      const body = bodyObject(request.body);
      const url = homeAssistantUrl(credentialString(body, "url", 2_048, true));
      const token = credentialString(body, "token", 8_192);
      response.json(await context.homeAssistantCredentialTester(url, token));
    });
  context.app.put(`${context.prefix}/integrations/home-assistant/config`, requireWorkspaceAdmin, async (request, response) => {
      const body = bodyObject(request.body);
      const houseId = body.houseId === undefined
        ? context.database.listHouses().find(hasLocalHouseAuthority)?.id
        : requiredString(body, "houseId");
      if (!houseId || !context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const generation = (context.homeAssistantConfigurationGenerations.get(houseId) ?? 0) + 1;
      context.homeAssistantConfigurationGenerations.set(houseId, generation);
      const url = homeAssistantUrl(credentialString(body, "url", 2_048, true));
      const token = credentialString(body, "token", 8_192);
      const validation = await context.homeAssistantCredentialTester(url, token);
      if (!validation.ok || !validation.connected) {
        throw new HttpError(422, "INTEGRATION_VALIDATION_FAILED", validation.message);
      }
      if (generation !== context.homeAssistantConfigurationGenerations.get(houseId)) {
        throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer Home Assistant configuration superseded this request");
      }
      const existingConnections = config.homeAssistantConnections ?? [];
      const replacingLegacy = existingConnections.length === 0 && !config.homeAssistantLegacyDisabled
        && Boolean(config.haUrl && config.haToken);
      const rotatingCredentials = replacingLegacy || existingConnections.some((connection) => connection.houseId === houseId);
      const connections = [...existingConnections.filter((connection) => connection.houseId !== houseId), { houseId, url, token }];
      updateIntegrationSecrets(config.integrationSecretsFile, {
        homeAssistant: null,
        homeAssistantConnections: connections,
        ...(replacingLegacy ? { homeAssistantLegacyDisabled: true } : {}),
      });
      if (replacingLegacy) context.integrationMetadata.retireHomeAssistant(houseId, true);
      context.integrationMetadata.saveHomeAssistant({ houseId, url });
      config.homeAssistantConnections = connections;
      if (replacingLegacy) config.homeAssistantLegacyDisabled = true;
      context.status.value.homeAssistant.configured = true;
      context.status.value.homeAssistant.error = null;
      context.status.value.homeAssistant.connections = [
        ...(context.status.value.homeAssistant.connections ?? []).filter((connection) => connection.houseId !== houseId),
        { houseId, configured: true, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
      ];
      const wasRealMode = context.dataMode.isRealMode;
      context.dataMode.activate();
      if (wasRealMode) context.status.changed();
      if (context.options.startBackground) context.homeAssistant.restart();
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: rotatingCredentials ? "integration.credentials.rotated" : "integration.credentials.configured",
        subjectType: "integration",
        subjectId: `home-assistant:${houseId}`,
        details: { integration: "home-assistant", houseId },
      });
      response.json({ ok: true, configured: true, houseId, integration: structuredClone(context.status.value) });
    });
  context.app.patch(`${context.prefix}/integrations/home-assistant/config/:houseId`, requireWorkspaceAdmin, (request, response) => {
      const fromHouseId = request.params.houseId as string;
      const targetHouseId = requiredString(bodyObject(request.body), "houseId");
      if (!context.database.getHouse(targetHouseId)) throw new HttpError(404, "NOT_FOUND", "Target house not found");
      context.stuguby.assertHouseLocalAuthority(targetHouseId);
      const existing = config.homeAssistantConnections ?? [];
      const explicitConnection = existing.find((candidate) => candidate.houseId === fromHouseId);
      const legacyHouseId = context.status.value.homeAssistant.connections?.find((candidate) => candidate.houseId === fromHouseId)?.houseId
        ?? context.database.listHouses().find(hasLocalHouseAuthority)?.id;
      const legacyConnection = existing.length === 0 && !config.homeAssistantLegacyDisabled
        && legacyHouseId === fromHouseId && config.haUrl && config.haToken
        ? { houseId: legacyHouseId, url: config.haUrl, token: config.haToken }
        : null;
      const connection = explicitConnection ?? legacyConnection;
      if (!connection) throw new HttpError(404, "NOT_FOUND", "Home Assistant connection not found");
      if (fromHouseId === targetHouseId) {
        response.json({ ok: true, fromHouseId, houseId: targetHouseId, integration: structuredClone(context.status.value) });
        return;
      }
      if (existing.some((candidate) => candidate.houseId === targetHouseId)) {
        throw new HttpError(409, "HOME_ASSISTANT_ALREADY_ASSIGNED", "The target house already has a Home Assistant connection");
      }
      context.homeAssistantConfigurationGenerations.set(fromHouseId, (context.homeAssistantConfigurationGenerations.get(fromHouseId) ?? 0) + 1);
      context.homeAssistantConfigurationGenerations.set(targetHouseId, (context.homeAssistantConfigurationGenerations.get(targetHouseId) ?? 0) + 1);
      const migratingLegacy = explicitConnection === undefined && legacyConnection !== null;
      const connections = migratingLegacy
        ? [{ ...connection, houseId: targetHouseId }]
        : existing.map((candidate) => candidate.houseId === fromHouseId
            ? { ...candidate, houseId: targetHouseId }
            : candidate);
      updateIntegrationSecrets(config.integrationSecretsFile, {
        homeAssistant: null,
        homeAssistantConnections: connections,
        ...(migratingLegacy ? { homeAssistantLegacyDisabled: true } : {}),
      });
      if (migratingLegacy) {
        context.integrationMetadata.retireHomeAssistant(fromHouseId, true);
        context.integrationMetadata.saveHomeAssistant({ houseId: targetHouseId, url: connection.url, reason: "moved" });
      } else {
        context.integrationMetadata.moveHomeAssistant(fromHouseId, targetHouseId, connection.url);
      }
      config.homeAssistantConnections = connections;
      if (migratingLegacy) config.homeAssistantLegacyDisabled = true;
      if (context.options.startBackground) context.homeAssistant.restart();
      else {
        context.status.value.homeAssistant.connections = (context.status.value.homeAssistant.connections ?? []).map((candidate) => candidate.houseId === fromHouseId
          ? { ...candidate, houseId: targetHouseId, connected: false, lastEventAt: null, mappedEntities: 0, error: null }
          : candidate);
        context.status.changed();
      }
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.credentials.configured",
        subjectType: "integration",
        subjectId: `home-assistant:${targetHouseId}`,
        details: { integration: "home-assistant", fromHouseId, houseId: targetHouseId },
      });
      response.json({ ok: true, fromHouseId, houseId: targetHouseId, integration: structuredClone(context.status.value) });
    });
  context.app.delete(`${context.prefix}/integrations/home-assistant/config/:houseId`, requireWorkspaceAdmin, (request, response) => {
      const houseId = request.params.houseId as string;
      const existing = config.homeAssistantConnections ?? [];
      const explicitConnection = existing.find((connection) => connection.houseId === houseId);
      const legacyHouseId = context.status.value.homeAssistant.connections?.find((candidate) => candidate.houseId === houseId)?.houseId
        ?? context.database.listHouses().find(hasLocalHouseAuthority)?.id;
      const disconnectingLegacy = explicitConnection === undefined && existing.length === 0
        && !config.homeAssistantLegacyDisabled && legacyHouseId === houseId && Boolean(config.haUrl && config.haToken);
      if (!explicitConnection && !disconnectingLegacy) {
        throw new HttpError(404, "NOT_FOUND", "Home Assistant connection not found");
      }
      context.stuguby.assertHouseLocalAuthority(houseId);
      const connections = disconnectingLegacy ? [] : existing.filter((connection) => connection.houseId !== houseId);
      updateIntegrationSecrets(config.integrationSecretsFile, {
        homeAssistant: null,
        homeAssistantConnections: connections,
        ...(disconnectingLegacy ? { homeAssistantLegacyDisabled: true } : {}),
      });
      context.integrationMetadata.retireHomeAssistant(houseId, disconnectingLegacy);
      config.homeAssistantConnections = connections;
      if (disconnectingLegacy) config.homeAssistantLegacyDisabled = true;
      if (context.options.startBackground) context.homeAssistant.restart();
      else {
        context.status.value.homeAssistant.connections = (context.status.value.homeAssistant.connections ?? [])
          .filter((connection) => connection.houseId !== houseId);
        context.status.value.homeAssistant.configured = (context.status.value.homeAssistant.connections?.length ?? 0) > 0;
        context.status.changed();
      }
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.credentials.revoked",
        subjectType: "integration",
        subjectId: `home-assistant:${houseId}`,
        details: { integration: "home-assistant", houseId },
      });
      response.json({ ok: true, integration: structuredClone(context.status.value) });
    });
  context.app.post(`${context.prefix}/integrations/home-assistant/test`, requireWorkspaceAdmin, (request, response) => {
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
      const houseStatus = context.integrationStatusForHouse(houseId).homeAssistant;
      response.json({
      ok: houseStatus.connected,
      message: houseStatus.connected
        ? "Home Assistant is connected and streaming state changes."
        : houseStatus.configured
          ? houseStatus.error ?? "Home Assistant is configured but not connected yet."
          : "Use the setup page to save the Home Assistant URL and token, or configure HA_URL and HA_TOKEN.",
      });
    });
  context.app.get(`${context.prefix}/integrations/home-assistant/setup`, (request, response) => response.json({
      configured: context.integrationStatusForHouse(typeof request.query.houseId === "string" ? request.query.houseId : undefined).homeAssistant.configured,
      steps: [
        "Create a Home Assistant long-lived access token for a dedicated local user.",
        "Use the setup page to discover Home Assistant or enter its local URL, then save the token.",
        "Map each Stugu sensor to legacy climate keys and/or a measurements object keyed by registry id.",
        "Verify /api/v1/integrations/status reports connected=true.",
      ],
      entityMapSchema: {
        entities: [{
          sensorId: "sensor-01", temperature: "sensor.living_room_temperature", humidity: "sensor.living_room_humidity",
          battery: "sensor.living_room_battery", measurements: { co2: "sensor.living_room_co2" },
        }],
      },
      notes: [
        "All entity keys are optional, but each mapping needs at least one entity.",
        "Generic string bindings require the exact canonical unit; use {entityId, unit, scale, offset} for explicit conversions such as ppb to ppm.",
        "Saved credentials are write-only through the API and stored in the protected integration secrets file, outside SQLite.",
        "HA_URL and HA_TOKEN environment variables remain advanced overrides.",
        "Saving a real integration permanently disables mock telemetry for this database and purges existing demo samples and mock-derived alert events.",
      ],
    }));
}
