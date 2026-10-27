import { randomUUID } from "node:crypto";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { updateIntegrationSecrets, type TpLinkConnectionSecret } from "../integration-secrets.js";
import { HttpError, credentialString, requiredString } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

// The steps of PUT /integrations/tp-link/config: resolve credentials, test the
// device, match it against saved connections by stable identity before
// address, and migrate unscoped sensor bindings when a second source appears.

type TpLinkValidation = Awaited<ReturnType<ApiRouteRegistrationContext["tpLinkCredentialTester"]>>;

export interface SensorConnectionAssignment {
  sensorId: string;
  fromConnectionId: string | null;
  toConnectionId: string | null;
}

/** What the tested device reported about itself, bounded and trimmed. */
export interface TestedTpLinkSource {
  deviceId: string | null;
  sourceType: TpLinkConnectionSecret["sourceType"] | null;
  sourceModel: string | null;
  sourceAlias: string | null;
  warning: string | null;
}

export function identityKey(value: string | null | undefined): string | null {
  return value?.trim().toUpperCase() || null;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The environment-configured hub, materialized as a connection when no
 * explicit connections exist yet, so that saving another device through the
 * UI does not silently retire it.
 */
export function legacyTpLinkConnection(context: ApiRouteRegistrationContext): TpLinkConnectionSecret | null {
  const { config } = context;
  if ((config.tpLinkConnections ?? []).length > 0 || config.tpLinkLegacyDisabled) return null;
  if (!config.tpLinkHost || !config.tpLinkUsername || !config.tpLinkPassword) return null;
  const houseId = context.status.value.tpLink.connections?.find((candidate) => candidate.id === "legacy")?.houseId
    ?? context.database.listHouses().find(hasLocalHouseAuthority)?.id;
  if (!houseId) return null;
  return { id: "legacy", houseId, host: config.tpLinkHost, username: config.tpLinkUsername, password: config.tpLinkPassword };
}

/** Saved credentials of another connection, or a new username and password; never both. */
export function resolveTpLinkCredentials(
  context: ApiRouteRegistrationContext,
  body: Record<string, unknown>,
  existing: readonly TpLinkConnectionSecret[],
): { username: string; password: string; source: TpLinkConnectionSecret | undefined } {
  const sourceId = body.credentialSourceConnectionId === undefined ? null : requiredString(body, "credentialSourceConnectionId");
  if (sourceId && (body.username !== undefined || body.password !== undefined)) {
    throw new HttpError(400, "AMBIGUOUS_TP_LINK_CREDENTIALS", "Use either saved TP-Link credentials or a new username and password, not both");
  }
  const source = sourceId ? existing.find((connection) => connection.id === sourceId) : undefined;
  if (sourceId && !source) throw new HttpError(404, "TP_LINK_CREDENTIAL_SOURCE_NOT_FOUND", "Saved TP-Link credential source not found");
  if (source) context.stuguby.assertHouseLocalAuthority(source.houseId);
  return {
    username: source?.username ?? credentialString(body, "username", 320, true),
    password: source?.password ?? credentialString(body, "password", 4_096),
    source,
  };
}

export function testedTpLinkSource(validation: TpLinkValidation): TestedTpLinkSource {
  const details = validation.details;
  const deviceId = trimmedString(details?.sourceDeviceId);
  if (deviceId.length > 1_024) {
    throw new HttpError(422, "INVALID_TP_LINK_DEVICE_ID", "The TP-Link helper returned an invalid source identity");
  }
  const model = trimmedString(details?.model);
  const alias = trimmedString(details?.sourceAlias);
  const warning = trimmedString(details?.warning);
  return {
    deviceId: deviceId || null,
    sourceType: details?.sourceType === "hub" || details?.sourceType === "energy-device" ? details.sourceType : null,
    sourceModel: model && model.length <= 128 ? model : null,
    sourceAlias: alias && alias.length <= 512 ? alias : null,
    warning: warning ? warning.slice(0, 500) : null,
  };
}

interface ConnectionMatchInput {
  existing: readonly TpLinkConnectionSecret[];
  houseId: string;
  host: string;
  requestedConnectionId: string | null;
  testedIdentity: string | null;
}

/**
 * Finds the saved connection this save updates, or undefined for a new one.
 * Stable identity wins over a DHCP address: omitting connectionId updates a
 * known device after an address change but adds genuinely different hardware.
 */
export function matchingTpLinkConnection(input: ConnectionMatchInput): TpLinkConnectionSecret | undefined {
  const requested = requestedTpLinkConnection(input);
  const identityMatch = identityMatchedConnection(input, requested);
  if (requested) assertRequestedIdentityUnchanged(requested, input);
  const hostMatch = input.existing.find((connection) => connection.houseId === input.houseId && connection.host === input.host);
  if (requested && hostMatch && hostMatch.id !== requested.id) {
    throw new HttpError(409, "TP_LINK_HOST_ALREADY_CONFIGURED", "This TP-Link address already has a different saved connection");
  }
  const hostIdentity = identityKey(hostMatch?.deviceId);
  if (!requested && hostIdentity && input.testedIdentity && hostIdentity !== input.testedIdentity) {
    throw new HttpError(409, "TP_LINK_HOST_IDENTITY_MISMATCH", "The device at this address does not match the TP-Link connection previously saved for it");
  }
  return requested ?? identityMatch ?? hostMatch;
}

function requestedTpLinkConnection({ existing, houseId, requestedConnectionId }: ConnectionMatchInput) {
  if (!requestedConnectionId) return undefined;
  const requested = existing.find((connection) => connection.id === requestedConnectionId);
  if (!requested) throw new HttpError(404, "NOT_FOUND", "TP-Link connection not found");
  if (requested.houseId !== houseId) throw new HttpError(409, "TP_LINK_HOUSE_SCOPE", "TP-Link connection belongs to another house");
  return requested;
}

/** An address change needs a stable identity, and that identity must be the saved device's. */
function assertRequestedIdentityUnchanged(requested: TpLinkConnectionSecret, { host, testedIdentity }: ConnectionMatchInput): void {
  const requestedIdentity = identityKey(requested.deviceId);
  if (requested.host !== host && requestedIdentity && !testedIdentity) {
    throw new HttpError(409, "TP_LINK_IDENTITY_REQUIRED", "The TP-Link helper did not return a stable identity, so the saved connection address was not changed");
  }
  if (requestedIdentity && testedIdentity && requestedIdentity !== testedIdentity) {
    throw new HttpError(
      409,
      "TP_LINK_CONNECTION_IDENTITY_MISMATCH",
      "The selected TP-Link connection belongs to a different physical device; add this device as a new connection instead",
    );
  }
}

function identityMatchedConnection(
  { existing, houseId, testedIdentity }: ConnectionMatchInput,
  requested: TpLinkConnectionSecret | undefined,
) {
  const match = testedIdentity ? existing.find((connection) => identityKey(connection.deviceId) === testedIdentity) : undefined;
  if (match && match.houseId !== houseId) {
    throw new HttpError(409, "TP_LINK_ALREADY_ASSIGNED", "This TP-Link device is already assigned to another house");
  }
  if (requested && match && match.id !== requested.id) {
    throw new HttpError(409, "TP_LINK_ALREADY_CONFIGURED", "This TP-Link device already has a different saved connection");
  }
  return match;
}

/** The saved connection after this update; tested identity overrides what was saved. */
export function updatedTpLinkConnection(
  matching: TpLinkConnectionSecret | undefined,
  saved: { houseId: string; host: string; username: string; password: string },
  tested: TestedTpLinkSource,
): TpLinkConnectionSecret {
  const deviceId = tested.deviceId ?? matching?.deviceId;
  const sourceType = tested.sourceType ?? matching?.sourceType;
  const sourceModel = tested.sourceModel ?? matching?.sourceModel;
  const sourceAlias = tested.sourceAlias ?? matching?.sourceAlias;
  return {
    id: matching?.id ?? randomUUID(),
    ...saved,
    ...(deviceId ? { deviceId } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(sourceModel ? { sourceModel } : {}),
    ...(sourceAlias ? { sourceAlias } : {}),
  };
}

function normalizedDeviceIds(values: unknown): Set<string> {
  return new Set((Array.isArray(values) ? values : []).flatMap((value): string[] => {
    const deviceId = trimmedString(value);
    return deviceId && deviceId.length <= 1_024 ? [deviceId.toUpperCase()] : [];
  }).slice(0, 2_048));
}

/**
 * When a second TP-Link source joins a house, sensors bound only by device id
 * must be assigned to one source. Returns the assignments, or throws when any
 * sensor cannot be placed unambiguously.
 */
export function unscopedSensorAssignments(
  context: ApiRouteRegistrationContext,
  houseId: string,
  sameHouseConnections: readonly TpLinkConnectionSecret[],
  added: { connection: TpLinkConnectionSecret; validation: TpLinkValidation },
): SensorConnectionAssignment[] {
  const unscopedSensors = context.database.listSensors(houseId).filter((sensor) => sensor.tpLinkDeviceId && !sensor.tpLinkConnectionId);
  if (sameHouseConnections.length === 0 || unscopedSensors.length === 0) return [];
  if (sameHouseConnections.length !== 1) {
    throw new HttpError(409, "TP_LINK_BINDING_MIGRATION_REQUIRED", "Unscoped TP-Link sensors must be assigned before another connection can be added");
  }
  const existingConnection = sameHouseConnections[0]!;
  const newDeviceIds = normalizedDeviceIds(added.validation.details?.deviceIds);
  const existingDeviceIds = new Set(context.tpLink.listDiscoveredDevices(houseId)
    .filter((device) => !device.connectionId || device.connectionId === existingConnection.id)
    .map((device) => device.deviceId.trim().toUpperCase()));
  const assignments: SensorConnectionAssignment[] = [];
  const ambiguousSensorIds: string[] = [];
  for (const sensor of unscopedSensors) {
    const deviceId = sensor.tpLinkDeviceId!.trim().toUpperCase();
    const onNew = newDeviceIds.has(deviceId);
    if (onNew === existingDeviceIds.has(deviceId)) ambiguousSensorIds.push(sensor.id);
    else assignments.push({ sensorId: sensor.id, fromConnectionId: null, toConnectionId: onNew ? added.connection.id : existingConnection.id });
  }
  if (ambiguousSensorIds.length > 0) {
    throw new HttpError(
      409,
      "TP_LINK_BINDING_MIGRATION_REQUIRED",
      "The existing and new TP-Link sources could not safely identify every unscoped sensor; no configuration was changed",
      { sensorIds: ambiguousSensorIds },
    );
  }
  return assignments;
}

/** Interim status after a save: the saved connection restarts unpolled, the others keep theirs. */
export function refreshTpLinkStatusAfterSave(
  context: ApiRouteRegistrationContext,
  connections: readonly TpLinkConnectionSecret[],
  saved: TpLinkConnectionSecret,
): void {
  const status = context.status.value.tpLink;
  status.configured = true;
  // A successful validation warning describes a device capability, not a
  // failed connection. The live bridge will surface it with connected=true
  // after the first poll; keeping it out of the interim status avoids
  // presenting a verified H500 as failed while its worker starts.
  status.error = null;
  const previous = new Map((status.connections ?? []).map((candidate) => [candidate.id, candidate] as const));
  status.connections = connections.map((candidate) => {
    const kept = previous.get(candidate.id);
    if (candidate.id !== saved.id && kept) return kept;
    return {
      id: candidate.id, houseId: candidate.houseId, configured: true, connected: false, lastPollAt: null,
      mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null,
      host: candidate.host,
      sourceType: candidate.sourceType ?? null,
      sourceModel: candidate.sourceModel ?? null,
      sourceAlias: candidate.sourceAlias ?? null,
    };
  });
}

/**
 * Tests the credentials against the device. Saves for the same connection (or
 * house) are numbered, so a slower test cannot overwrite a newer save, and a
 * credential source edited meanwhile is rejected.
 */
export async function validatedTpLinkConfiguration(
  context: ApiRouteRegistrationContext,
  request: { generationKey: string; host: string; credentials: ReturnType<typeof resolveTpLinkCredentials> },
): Promise<TpLinkValidation> {
  const generations = context.tpLinkConfigurationGenerations;
  const { generationKey, host, credentials } = request;
  const generation = (generations.get(generationKey) ?? 0) + 1;
  generations.set(generationKey, generation);
  const sourceGeneration = credentials.source ? generations.get(credentials.source.id) ?? 0 : null;
  const validation = await context.tpLinkCredentialTester(host, credentials.username, credentials.password);
  if (!validation.ok || !validation.connected) throw new HttpError(422, "INTEGRATION_VALIDATION_FAILED", validation.message);
  if (generation !== generations.get(generationKey)) {
    throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer TP-Link configuration superseded this request");
  }
  if (credentials.source && sourceGeneration !== (generations.get(credentials.source.id) ?? 0)) {
    throw new HttpError(409, "TP_LINK_CREDENTIAL_SOURCE_CHANGED", "The saved TP-Link credential source changed during import");
  }
  return validation;
}

/**
 * Persists the connection list. Sensor reassignments are applied first and
 * reverted if the protected secrets file cannot be written.
 */
export function persistTpLinkConnections(
  context: ApiRouteRegistrationContext,
  plan: {
    houseId: string;
    connections: TpLinkConnectionSecret[];
    retiresLegacy: boolean;
    sensorAssignments: readonly SensorConnectionAssignment[];
  },
): void {
  const { houseId, sensorAssignments } = plan;
  if (sensorAssignments.length > 0) context.database.reassignTpLinkSensors(houseId, [...sensorAssignments]);
  try {
    updateIntegrationSecrets(context.config.integrationSecretsFile, {
      tpLink: null,
      tpLinkConnections: plan.connections,
      ...(plan.retiresLegacy ? { tpLinkLegacyDisabled: true } : {}),
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
}

/** Metadata, in-memory config, status, data mode and bridge restart after a successful save. */
export function applySavedTpLinkConfiguration(
  context: ApiRouteRegistrationContext,
  saved: { connection: TpLinkConnectionSecret; connections: TpLinkConnectionSecret[]; legacyConnection: TpLinkConnectionSecret | null },
): void {
  const { connection, connections, legacyConnection } = saved;
  if (legacyConnection && connection.id !== legacyConnection.id) {
    context.integrationMetadata.saveTpLink({
      id: legacyConnection.id,
      houseId: legacyConnection.houseId,
      host: legacyConnection.host,
      reason: "reconciled",
    });
  }
  context.integrationMetadata.saveTpLink({ id: connection.id, houseId: connection.houseId, host: connection.host });
  context.config.tpLinkConnections = connections;
  if (legacyConnection) context.config.tpLinkLegacyDisabled = true;
  refreshTpLinkStatusAfterSave(context, connections, connection);
  const wasRealMode = context.dataMode.isRealMode;
  context.dataMode.activate();
  if (wasRealMode) context.status.changed();
  if (context.options.startBackground) context.tpLink.restart();
}
