import { randomUUID } from "node:crypto";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { type AppConfig } from "../config.js";
import {
  updateIntegrationSecrets,
  type TpLinkConnectionSecret,
} from "../integration-secrets.js";
import { HttpError, bodyObject, credentialString, networkHost, requestPrincipal, requiredString } from "./support/index.js";
import { configureApiPart23 } from "./part-23.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart24(context: ReturnType<typeof configureApiPart23>) {
  const config = context.config as NormalizedApiConfig;
  context.app.put(`${context.prefix}/integrations/tp-link/config`, async (request, response) => {
      const body = bodyObject(request.body);
      const host = networkHost(credentialString(body, "host", 253, true));
      const houseId = body.houseId === undefined
        ? context.database.listHouses().find(hasLocalHouseAuthority)?.id
        : requiredString(body, "houseId");
      if (!houseId || !context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const requestedConnectionId = body.connectionId === undefined ? null : requiredString(body, "connectionId");
      const explicitConnections = config.tpLinkConnections ?? [];
      const legacyHouseId = context.status.value.tpLink.connections?.find((candidate) => candidate.id === "legacy")?.houseId
        ?? context.database.listHouses().find(hasLocalHouseAuthority)?.id;
      const legacyConnection: TpLinkConnectionSecret | null = explicitConnections.length === 0
        && !config.tpLinkLegacyDisabled && legacyHouseId
        && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword
        ? {
            id: "legacy",
            houseId: legacyHouseId,
            host: config.tpLinkHost,
            username: config.tpLinkUsername,
            password: config.tpLinkPassword,
          }
        : null;
      // Materialize an environment-backed source before adding anything else.
      // Otherwise the first different device saved through the UI would silently
      // retire the working legacy hub.
      const existing = legacyConnection ? [legacyConnection] : explicitConnections;
      const credentialSourceConnectionId = body.credentialSourceConnectionId === undefined
        ? null
        : requiredString(body, "credentialSourceConnectionId");
      if (credentialSourceConnectionId && (body.username !== undefined || body.password !== undefined)) {
        throw new HttpError(
          400,
          "AMBIGUOUS_TP_LINK_CREDENTIALS",
          "Use either saved TP-Link credentials or a new username and password, not both",
        );
      }
      const credentialSource = credentialSourceConnectionId
        ? existing.find((connection) => connection.id === credentialSourceConnectionId)
        : undefined;
      if (credentialSourceConnectionId && !credentialSource) {
        throw new HttpError(404, "TP_LINK_CREDENTIAL_SOURCE_NOT_FOUND", "Saved TP-Link credential source not found");
      }
      if (credentialSource) context.stuguby.assertHouseLocalAuthority(credentialSource.houseId);
      const username = credentialSource?.username ?? credentialString(body, "username", 320, true);
      const password = credentialSource?.password ?? credentialString(body, "password", 4_096);
      const generationKey = requestedConnectionId ?? houseId;
      const generation = (context.tpLinkConfigurationGenerations.get(generationKey) ?? 0) + 1;
      context.tpLinkConfigurationGenerations.set(generationKey, generation);
      const credentialSourceGeneration = credentialSource
        ? context.tpLinkConfigurationGenerations.get(credentialSource.id) ?? 0
        : null;
      const validation = await context.tpLinkCredentialTester(host, username, password);
      if (!validation.ok || !validation.connected) {
        throw new HttpError(422, "INTEGRATION_VALIDATION_FAILED", validation.message);
      }
      if (generation !== context.tpLinkConfigurationGenerations.get(generationKey)) {
        throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer TP-Link configuration superseded this request");
      }
      if (credentialSource && credentialSourceGeneration !== (context.tpLinkConfigurationGenerations.get(credentialSource.id) ?? 0)) {
        throw new HttpError(409, "TP_LINK_CREDENTIAL_SOURCE_CHANGED", "The saved TP-Link credential source changed during import");
      }
      const rawTestedDeviceId = typeof validation.details?.sourceDeviceId === "string"
        ? validation.details.sourceDeviceId.trim()
        : "";
      if (rawTestedDeviceId.length > 1_024) {
        throw new HttpError(422, "INVALID_TP_LINK_DEVICE_ID", "The TP-Link helper returned an invalid source identity");
      }
      const testedDeviceId = rawTestedDeviceId || null;
      const rawTestedModel = typeof validation.details?.model === "string"
        ? validation.details.model.trim()
        : "";
      const testedSourceModel = rawTestedModel && rawTestedModel.length <= 128 ? rawTestedModel : null;
      const testedSourceType = validation.details?.sourceType === "hub" || validation.details?.sourceType === "energy-device"
        ? validation.details.sourceType
        : null;
      const rawTestedAlias = typeof validation.details?.sourceAlias === "string"
        ? validation.details.sourceAlias.trim()
        : "";
      const testedSourceAlias = rawTestedAlias && rawTestedAlias.length <= 512 ? rawTestedAlias : null;
      const rawValidationWarning = typeof validation.details?.warning === "string"
        ? validation.details.warning.trim()
        : "";
      const validationWarning = rawValidationWarning ? rawValidationWarning.slice(0, 500) : null;
      const identityKey = (value: string | null | undefined): string | null => value?.trim().toUpperCase() || null;
      const testedIdentity = identityKey(testedDeviceId);
      const requestedConnection = requestedConnectionId
        ? existing.find((connection) => connection.id === requestedConnectionId)
        : undefined;
      if (requestedConnectionId && !requestedConnection) {
        throw new HttpError(404, "NOT_FOUND", "TP-Link connection not found");
      }
      if (requestedConnection && requestedConnection.houseId !== houseId) {
        throw new HttpError(409, "TP_LINK_HOUSE_SCOPE", "TP-Link connection belongs to another house");
      }
      const identityMatch = testedIdentity
        ? existing.find((connection) => identityKey(connection.deviceId) === testedIdentity)
        : undefined;
      if (identityMatch && identityMatch.houseId !== houseId) {
        throw new HttpError(409, "TP_LINK_ALREADY_ASSIGNED", "This TP-Link device is already assigned to another house");
      }
      if (requestedConnection && identityMatch && identityMatch.id !== requestedConnection.id) {
        throw new HttpError(409, "TP_LINK_ALREADY_CONFIGURED", "This TP-Link device already has a different saved connection");
      }
      const requestedIdentity = identityKey(requestedConnection?.deviceId);
      if (requestedConnection && requestedConnection.host !== host && requestedIdentity && !testedIdentity) {
        throw new HttpError(
          409,
          "TP_LINK_IDENTITY_REQUIRED",
          "The TP-Link helper did not return a stable identity, so the saved connection address was not changed",
        );
      }
      if (requestedIdentity && testedIdentity && requestedIdentity !== testedIdentity) {
        throw new HttpError(
          409,
          "TP_LINK_CONNECTION_IDENTITY_MISMATCH",
          "The selected TP-Link connection belongs to a different physical device; add this device as a new connection instead",
        );
      }
      const hostMatch = existing.find((connection) => connection.houseId === houseId && connection.host === host);
      if (requestedConnection && hostMatch && hostMatch.id !== requestedConnection.id) {
        throw new HttpError(409, "TP_LINK_HOST_ALREADY_CONFIGURED", "This TP-Link address already has a different saved connection");
      }
      const hostIdentity = identityKey(hostMatch?.deviceId);
      if (!requestedConnection && hostIdentity && testedIdentity && hostIdentity !== testedIdentity) {
        throw new HttpError(
          409,
          "TP_LINK_HOST_IDENTITY_MISMATCH",
          "The device at this address does not match the TP-Link connection previously saved for it",
        );
      }
      // Stable identity wins over a DHCP address. Omitting connectionId therefore
      // updates a known device after an address change, but creates a second
      // connection when discovery finds genuinely different hardware.
      const matching = requestedConnection ?? identityMatch ?? hostMatch;
      const created = matching === undefined;
      const resolvedDeviceId = testedDeviceId ?? matching?.deviceId;
      const resolvedSourceType = testedSourceType ?? matching?.sourceType;
      const resolvedSourceModel = testedSourceModel ?? matching?.sourceModel;
      const resolvedSourceAlias = testedSourceAlias ?? matching?.sourceAlias;
      const connection: TpLinkConnectionSecret = {
        id: matching?.id ?? randomUUID(), houseId, host, username, password,
        ...(resolvedDeviceId ? { deviceId: resolvedDeviceId } : {}),
        ...(resolvedSourceType ? { sourceType: resolvedSourceType } : {}),
        ...(resolvedSourceModel ? { sourceModel: resolvedSourceModel } : {}),
        ...(resolvedSourceAlias ? { sourceAlias: resolvedSourceAlias } : {}),
      };
      const connections = [...existing.filter((candidate) => candidate.id !== connection.id), connection];
      const sameHouseConnections = existing.filter((candidate) => candidate.houseId === houseId);
      const unscopedSensors = context.database.listSensors(houseId)
        .filter((sensor) => sensor.tpLinkDeviceId && !sensor.tpLinkConnectionId);
      const sensorAssignments: Array<{
        sensorId: string;
        fromConnectionId: string | null;
        toConnectionId: string | null;
      }> = [];
      if (!matching && sameHouseConnections.length > 0 && unscopedSensors.length > 0) {
        if (sameHouseConnections.length !== 1) {
          throw new HttpError(
            409,
            "TP_LINK_BINDING_MIGRATION_REQUIRED",
            "Unscoped TP-Link sensors must be assigned before another connection can be added",
          );
        }
        const normalizeDeviceId = (value: string): string => value.trim().toUpperCase();
        const newDeviceIds = new Set((Array.isArray(validation.details?.deviceIds)
          ? validation.details.deviceIds
          : []).flatMap((value): string[] => {
            if (typeof value !== "string") return [];
            const deviceId = value.trim();
            return deviceId && deviceId.length <= 1_024 ? [normalizeDeviceId(deviceId)] : [];
          }).slice(0, 2_048));
        const existingConnection = sameHouseConnections[0]!;
        const existingDeviceIds = new Set(context.tpLink.listDiscoveredDevices(houseId)
          .filter((device) => !device.connectionId || device.connectionId === existingConnection.id)
          .map((device) => normalizeDeviceId(device.deviceId)));
        const ambiguousSensorIds: string[] = [];
        for (const sensor of unscopedSensors) {
          const deviceId = normalizeDeviceId(sensor.tpLinkDeviceId!);
          const belongsToNewConnection = newDeviceIds.has(deviceId);
          const belongsToExistingConnection = existingDeviceIds.has(deviceId);
          if (belongsToNewConnection === belongsToExistingConnection) {
            ambiguousSensorIds.push(sensor.id);
            continue;
          }
          sensorAssignments.push({
            sensorId: sensor.id,
            fromConnectionId: null,
            toConnectionId: belongsToNewConnection ? connection.id : existingConnection.id,
          });
        }
        if (ambiguousSensorIds.length > 0) {
          throw new HttpError(
            409,
            "TP_LINK_BINDING_MIGRATION_REQUIRED",
            "The existing and new TP-Link sources could not safely identify every unscoped sensor; no configuration was changed",
            { sensorIds: ambiguousSensorIds },
          );
        }
      }
      if (sensorAssignments.length > 0) {
        context.database.reassignTpLinkSensors(houseId, sensorAssignments);
      }
      try {
        updateIntegrationSecrets(config.integrationSecretsFile, {
          tpLink: null,
          tpLinkConnections: connections,
          ...(legacyConnection ? { tpLinkLegacyDisabled: true } : {}),
        });
      } catch (error) {
        if (sensorAssignments.length > 0) {
          context.database.reassignTpLinkSensors(houseId, sensorAssignments.map((assignment) => ({
            sensorId: assignment.sensorId,
            fromConnectionId: assignment.toConnectionId,
            toConnectionId: assignment.fromConnectionId,
          })));
        }
        throw error;
      }
      if (legacyConnection && connection.id !== legacyConnection.id) {
        context.integrationMetadata.saveTpLink({
          id: legacyConnection.id,
          houseId: legacyConnection.houseId,
          host: legacyConnection.host,
          reason: "reconciled",
        });
      }
      context.integrationMetadata.saveTpLink({ id: connection.id, houseId, host });
      config.tpLinkConnections = connections;
      if (legacyConnection) config.tpLinkLegacyDisabled = true;
      context.status.value.tpLink.configured = true;
      // A successful validation warning describes a device capability, not a
      // failed connection. The live bridge will surface it with connected=true
      // after the first poll; keeping it out of the interim status avoids
      // presenting a verified H500 as failed while its worker starts.
      context.status.value.tpLink.error = null;
      const previousConnectionStatuses = new Map((context.status.value.tpLink.connections ?? [])
        .map((candidate) => [candidate.id, candidate] as const));
      context.status.value.tpLink.connections = connections.map((candidate) => {
        const previous = previousConnectionStatuses.get(candidate.id);
        if (candidate.id !== connection.id && previous) return previous;
        return {
          id: candidate.id, houseId: candidate.houseId, configured: true, connected: false, lastPollAt: null,
          mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null,
          host: candidate.host,
          sourceType: candidate.sourceType ?? null,
          sourceModel: candidate.sourceModel ?? null,
          sourceAlias: candidate.sourceAlias ?? null,
        };
      });
      const wasRealMode = context.dataMode.isRealMode;
      context.dataMode.activate();
      if (wasRealMode) context.status.changed();
      if (context.options.startBackground) context.tpLink.restart();
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: matching ? "integration.credentials.rotated" : "integration.credentials.configured",
        subjectType: "integration",
        subjectId: `tp-link:${connection.id}`,
        details: { integration: "tp-link", connectionId: connection.id, houseId },
      });
      response.json({
        ok: true,
        configured: true,
        created,
        connectionId: connection.id,
        houseId,
        deviceId: resolvedDeviceId ?? null,
        sourceType: resolvedSourceType ?? null,
        sourceModel: resolvedSourceModel ?? null,
        sourceAlias: resolvedSourceAlias ?? null,
        warning: validationWarning,
        integration: structuredClone(context.status.value),
      });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
