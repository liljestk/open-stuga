import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { type AppConfig } from "../config.js";
import {
  updateIntegrationSecrets,
} from "../integration-secrets.js";
import { HttpError, bodyObject, requestPrincipal, requiredString } from "./support/index.js";
import { configureApiPart24 } from "./part-24.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart25(context: ReturnType<typeof configureApiPart24>) {
  const config = context.config as NormalizedApiConfig;
  context.app.patch(`${context.prefix}/integrations/tp-link/config/:connectionId`, (request, response) => {
      const connectionId = request.params.connectionId as string;
      const targetHouseId = requiredString(bodyObject(request.body), "houseId");
      if (!context.database.getHouse(targetHouseId)) throw new HttpError(404, "NOT_FOUND", "Target house not found");
      context.stuguby.assertHouseLocalAuthority(targetHouseId);
      const existing = config.tpLinkConnections ?? [];
      const explicitConnection = existing.find((candidate) => candidate.id === connectionId);
      const legacyHouseId = context.status.value.tpLink.connections?.find((candidate) => candidate.id === "legacy")?.houseId
        ?? context.database.listHouses().find(hasLocalHouseAuthority)?.id;
      const legacyConnection = connectionId === "legacy" && existing.length === 0 && !config.tpLinkLegacyDisabled
        && legacyHouseId && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword
        ? {
            id: "legacy", houseId: legacyHouseId, host: config.tpLinkHost,
            username: config.tpLinkUsername, password: config.tpLinkPassword,
          }
        : null;
      const connection = explicitConnection ?? legacyConnection;
      if (!connection) throw new HttpError(404, "NOT_FOUND", "TP-Link connection not found");
      if (connection.houseId === targetHouseId) {
        response.json({ ok: true, fromHouseId: connection.houseId, houseId: targetHouseId, detachedSensorIds: [], integration: structuredClone(context.status.value) });
        return;
      }
      if (existing.some((candidate) => candidate.id !== connectionId
        && candidate.houseId === targetHouseId && candidate.host === connection.host)) {
        throw new HttpError(409, "TP_LINK_ALREADY_ASSIGNED", "This TP-Link system is already assigned to the target house");
      }
      context.tpLinkConfigurationGenerations.set(connectionId, (context.tpLinkConfigurationGenerations.get(connectionId) ?? 0) + 1);
      const fromHouseId = connection.houseId;
      const moved = { ...connection, houseId: targetHouseId };
      const migratingLegacy = explicitConnection === undefined && legacyConnection !== null;
      const connections = migratingLegacy
        ? [moved]
        : existing.map((candidate) => candidate.id === connectionId ? moved : candidate);
      updateIntegrationSecrets(config.integrationSecretsFile, {
        tpLink: null,
        tpLinkConnections: connections,
        ...(migratingLegacy ? { tpLinkLegacyDisabled: true } : {}),
      });
      context.integrationMetadata.moveTpLink(connectionId, targetHouseId, connection.host);
      config.tpLinkConnections = connections;
      if (migratingLegacy) config.tpLinkLegacyDisabled = true;
      const detachedSensorIds = context.database.detachTpLinkConnection(connectionId, migratingLegacy ? fromHouseId : undefined);
      if (context.options.startBackground) context.tpLink.restart();
      else {
        context.status.value.tpLink.connections = (context.status.value.tpLink.connections ?? []).map((candidate) => candidate.id === connectionId
          ? {
              ...candidate,
              houseId: targetHouseId,
              connected: false,
              lastPollAt: null,
              mappedDevices: 0,
              discoveredDevices: 0,
              hubModel: null,
              error: null,
            }
          : candidate);
        context.status.changed();
      }
      response.json({ ok: true, fromHouseId, houseId: targetHouseId, detachedSensorIds, integration: structuredClone(context.status.value) });
    });
  context.app.patch(`${context.prefix}/integrations/home-assistant/config/:houseId`, (request, response) => {
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
      response.json({ ok: true, fromHouseId, houseId: targetHouseId, integration: structuredClone(context.status.value) });
    });
  context.app.delete(`${context.prefix}/integrations/tp-link/config/:connectionId`, (request, response) => {
      const connectionId = request.params.connectionId as string;
      const existing = config.tpLinkConnections ?? [];
      const explicitConnection = existing.find((candidate) => candidate.id === connectionId);
      const legacyHouseId = context.status.value.tpLink.connections?.find((candidate) => candidate.id === "legacy")?.houseId
        ?? context.database.listHouses().find(hasLocalHouseAuthority)?.id;
      const legacyConnection = connectionId === "legacy" && existing.length === 0 && !config.tpLinkLegacyDisabled
        && legacyHouseId && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword
        ? {
            id: "legacy", houseId: legacyHouseId, host: config.tpLinkHost,
            username: config.tpLinkUsername, password: config.tpLinkPassword,
          }
        : null;
      const connection = explicitConnection ?? legacyConnection;
      if (!connection) throw new HttpError(404, "NOT_FOUND", "TP-Link connection not found");
      const disconnectingLegacy = explicitConnection === undefined && legacyConnection !== null;
      const connections = disconnectingLegacy ? [] : existing.filter((candidate) => candidate.id !== connectionId);
      updateIntegrationSecrets(config.integrationSecretsFile, {
        tpLink: null,
        tpLinkConnections: connections,
        ...(disconnectingLegacy ? { tpLinkLegacyDisabled: true } : {}),
      });
      context.integrationMetadata.retireTpLink(connectionId);
      config.tpLinkConnections = connections;
      if (disconnectingLegacy) config.tpLinkLegacyDisabled = true;
      const detachedSensorIds = context.database.detachTpLinkConnection(connectionId, disconnectingLegacy ? connection.houseId : undefined);
      if (context.options.startBackground) context.tpLink.restart();
      else {
        context.status.value.tpLink.configured = connections.length > 0;
        context.status.value.tpLink.connections = (context.status.value.tpLink.connections ?? []).filter((candidate) => candidate.id !== connectionId);
        context.status.changed();
      }
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.credentials.revoked",
        subjectType: "integration",
        subjectId: `tp-link:${connectionId}`,
        details: { integration: "tp-link", connectionId, houseId: connection.houseId },
      });
      response.json({ ok: true, detachedSensorIds, integration: structuredClone(context.status.value) });
    });
  context.app.delete(`${context.prefix}/integrations/home-assistant/config/:houseId`, (request, response) => {
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
  context.app.post(`${context.prefix}/integrations/home-assistant/test`, (request, response) => {
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
  const extended = Object.assign(context, {  });
  return extended;
}
