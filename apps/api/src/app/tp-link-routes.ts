import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { updateIntegrationSecrets } from "../integration-secrets.js";
import { HttpError, bodyObject, credentialString, networkHost, requestPrincipal, requiredString, requireWorkspaceAdmin } from "./support/index.js";
import {
  applySavedTpLinkConfiguration,
  identityKey,
  legacyTpLinkConnection,
  matchingTpLinkConnection,
  persistTpLinkConnections,
  resolveTpLinkCredentials,
  testedTpLinkSource,
  unscopedSensorAssignments,
  updatedTpLinkConnection,
  validatedTpLinkConfiguration,
} from "./tp-link-connection-config.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** TP-Link connection configuration, tests, device listing and setup. */
export function registerTpLinkRoutes(context: ApiRouteRegistrationContext): void {
  const config = context.config;
  context.app.post(`${context.prefix}/integrations/tp-link/test-draft`, requireWorkspaceAdmin, async (request, response) => {
      response.setHeader("cache-control", "no-store");
      const body = bodyObject(request.body);
      const host = networkHost(credentialString(body, "host", 253, true));
      const username = credentialString(body, "username", 320, true);
      const password = credentialString(body, "password", 4_096);
      response.json(await context.tpLinkCredentialTester(host, username, password));
    });
  context.app.put(`${context.prefix}/integrations/tp-link/config`, requireWorkspaceAdmin, async (request, response) => {
      const body = bodyObject(request.body);
      const host = networkHost(credentialString(body, "host", 253, true));
      const houseId = body.houseId === undefined
        ? context.database.listHouses().find(hasLocalHouseAuthority)?.id
        : requiredString(body, "houseId");
      if (!houseId || !context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const requestedConnectionId = body.connectionId === undefined ? null : requiredString(body, "connectionId");
      // Materialize an environment-backed source before adding anything else.
      // Otherwise the first different device saved through the UI would silently
      // retire the working legacy hub.
      const legacyConnection = legacyTpLinkConnection(context);
      const existing = legacyConnection ? [legacyConnection] : config.tpLinkConnections ?? [];
      const credentials = resolveTpLinkCredentials(context, body, existing);
      const validation = await validatedTpLinkConfiguration(context, { generationKey: requestedConnectionId ?? houseId, host, credentials });
      const tested = testedTpLinkSource(validation);
      const matching = matchingTpLinkConnection({ existing, houseId, host, requestedConnectionId, testedIdentity: identityKey(tested.deviceId) });
      const connection = updatedTpLinkConnection(matching, { houseId, host, username: credentials.username, password: credentials.password }, tested);
      const connections = [...existing.filter((candidate) => candidate.id !== connection.id), connection];
      const sensorAssignments = matching
        ? []
        : unscopedSensorAssignments(context, houseId, existing.filter((candidate) => candidate.houseId === houseId), { connection, validation });
      persistTpLinkConnections(context, { houseId, connections, retiresLegacy: legacyConnection !== null, sensorAssignments });
      applySavedTpLinkConfiguration(context, { connection, connections, legacyConnection });
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: matching ? "integration.credentials.rotated" : "integration.credentials.configured",
        subjectType: "integration",
        subjectId: `tp-link:${connection.id}`,
        details: { integration: "tp-link", connectionId: connection.id, houseId },
      });
      response.json({
        ok: true,
        configured: true,
        created: matching === undefined,
        connectionId: connection.id,
        houseId,
        deviceId: connection.deviceId ?? null,
        sourceType: connection.sourceType ?? null,
        sourceModel: connection.sourceModel ?? null,
        sourceAlias: connection.sourceAlias ?? null,
        warning: tested.warning,
        integration: structuredClone(context.status.value),
      });
    });
  context.app.patch(`${context.prefix}/integrations/tp-link/config/:connectionId`, requireWorkspaceAdmin, (request, response) => {
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
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.credentials.configured",
        subjectType: "integration",
        subjectId: `tp-link:${connectionId}`,
        details: { integration: "tp-link", connectionId, fromHouseId, houseId: targetHouseId },
      });
      response.json({ ok: true, fromHouseId, houseId: targetHouseId, detachedSensorIds, integration: structuredClone(context.status.value) });
    });
  context.app.delete(`${context.prefix}/integrations/tp-link/config/:connectionId`, requireWorkspaceAdmin, (request, response) => {
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
      context.stuguby.assertHouseLocalAuthority(connection.houseId);
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
  context.app.get(`${context.prefix}/integrations/tp-link/devices`, (request, response) => response.json({
      devices: context.tpLink.listDiscoveredDevices(typeof request.query.houseId === "string" ? request.query.houseId : undefined),
    }));
  context.app.post(`${context.prefix}/integrations/tp-link/test`, requireWorkspaceAdmin, (request, response) => {
      const houseStatus = context.integrationStatusForHouse(typeof request.query.houseId === "string" ? request.query.houseId : undefined).tpLink;
      response.json({
      ok: houseStatus.connected,
      message: houseStatus.connected
        ? `TP-Link ${houseStatus.hubModel ?? "energy device"} is connected; ${houseStatus.discoveredDevices} devices discovered and ${houseStatus.mappedDevices} mapped.`
        : houseStatus.configured
          ? houseStatus.error ?? "TP-Link credentials are configured, but discovery has not connected yet."
          : "Use the setup page to discover or enter the hub or energy device, then save the TP-Link account credentials.",
      });
    });
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
}
