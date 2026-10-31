import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { normalizeBugReportRelayInput, type BugReportRelayInput } from "@climate-twin/contracts";
import { pendingIntegrationSecretsPath, withIntegrationSecretsLock } from "./integration-secrets-lock.js";
import { normalizedExportDestinationSecrets, type ExportDestinationSecrets } from "./export-destinations/secrets.js";

export interface IntegrationSecrets {
  version: 1;
  /** Coordinates crash-safe publication with the SQLite metadata revision. */
  databaseRevision?: string;
  /** Set only when a new file was synthesized from one environment credential. */
  metadataSnapshotIncomplete?: true;
  homeAssistant?: { url: string; token: string };
  homeAssistantLegacyDisabled?: true;
  homeAssistantConnections?: HomeAssistantConnectionSecret[];
  tpLink?: { host: string; username: string; password: string };
  tpLinkLegacyDisabled?: true;
  tpLinkConnections?: TpLinkConnectionSecret[];
  greeConnections?: GreeConnectionSecret[];
  tuyaConnections?: TuyaConnectionSecret[];
  webhook?: { url: string; bearerToken?: string; signingSecret?: string };
  webhookDestinations?: WebhookDestinationSecret[];
  telegram?: { botToken: string; chatId: string };
  /** Bug-report relay configured by a workspace administrator instead of deployment environment variables. */
  bugReportRelay?: { url: string; token: string; updatedAt: string };
  /** The chosen scheduled-export destination and any connected cloud drives. */
  exportDestinations?: ExportDestinationSecrets;
  appleNotesGrants?: AppleNotesGrantSecret[];
  hiddenHouseData?: HiddenHouseIntegrationData[];
}

export interface HiddenHouseIntegrationData {
  houseId: string;
  hiddenAt: string;
  homeAssistant?: IntegrationSecrets["homeAssistant"];
  tpLink?: IntegrationSecrets["tpLink"];
  homeAssistantConnections: HomeAssistantConnectionSecret[];
  tpLinkConnections: TpLinkConnectionSecret[];
  greeConnections: GreeConnectionSecret[];
  tuyaConnections: TuyaConnectionSecret[];
  appleNotesGrants: AppleNotesGrantSecret[];
}

export interface WebhookDestinationSecret {
  /** Stable, non-secret identifier used in delivery status and idempotency keys. */
  id: string;
  url: string;
  bearerToken?: string;
  signingSecret?: string;
}

export interface HomeAssistantConnectionSecret {
  houseId: string;
  url: string;
  token: string;
}

export interface TpLinkConnectionSecret {
  id: string;
  houseId: string;
  host: string;
  username: string;
  password: string;
  /** Stable local device identity learned after the first authenticated poll. */
  deviceId?: string;
  /** Non-secret source details retained so an offline connection stays identifiable. */
  sourceType?: "hub" | "energy-device";
  sourceModel?: string;
  sourceAlias?: string;
}

export interface GreeConnectionSecret {
  id: string;
  houseId: string;
  equipmentId?: string;
  /** Omitted on legacy bindings and normalized as local. */
  transport?: "local" | "ewpe-cloud";
  host: string;
  port: number;
  /** Normalized uppercase hexadecimal MAC without separators. */
  mac: string;
  /** Device-local binding key. Never expose through API responses or logs. */
  key: string;
  cipherVersion: 1 | 2;
  name?: string;
  brand?: string;
  model?: string;
  version?: string;
  /** EWPE credentials are protected at rest with the other integration secrets. */
  cloudUsername?: string;
  cloudPassword?: string;
}

export interface TuyaConnectionSecret {
  id: string;
  houseId: string;
  equipmentId?: string;
  /** Canonical measurement endpoint created only for metering-capable devices. */
  sensorId?: string;
  host: string;
  /** Stable local device identity. Never expose it through normal state APIs. */
  deviceId: string;
  /** Device-local LAN key. Never expose through API responses or logs. */
  localKey: string;
  protocolVersion: "3.1" | "3.2" | "3.3" | "3.4" | "3.5";
  profileId: string;
  name: string;
  model?: string;
  productKey?: string;
  mac?: string;
}

export interface AppleNotesGrantSecret {
  id: string;
  tokenHash: string;
  deviceLabel: string;
  houseId: string;
  createdAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function protectedHttpEndpoint(value: unknown, label: string): string {
  if (!isNonEmptyString(value) || value.length > 2_048) throw new Error(`${label} is invalid`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} is invalid`);
  }
  return url.toString().replace(/\/$/, "");
}

export function normalizedWebhookDestinations(value: unknown, label: string): WebhookDestinationSecret[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error(`${label} must contain between 1 and 16 webhook destinations`);
  }
  const ids = new Set<string>();
  return value.map((candidate) => {
    const item = candidate as Record<string, unknown>;
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,63})$/u.test(item.id)
      || ids.has(item.id)) {
      throw new Error(`${label} contains an invalid or duplicate destination id`);
    }
    if (item.bearerToken !== undefined
      && (typeof item.bearerToken !== "string" || !item.bearerToken || item.bearerToken.length > 8_192)) {
      throw new Error(`${label} contains invalid webhook bearer credentials`);
    }
    if (item.signingSecret !== undefined && (typeof item.signingSecret !== "string"
      || Buffer.byteLength(item.signingSecret, "utf8") < 32 || item.signingSecret.length > 8_192)) {
      throw new Error(`${label} contains an invalid webhook signing secret`);
    }
    ids.add(item.id);
    return {
      id: item.id,
      url: protectedHttpEndpoint(item.url, `${label} destination URL`),
      ...(typeof item.bearerToken === "string" ? { bearerToken: item.bearerToken } : {}),
      ...(typeof item.signingSecret === "string" ? { signingSecret: item.signingSecret } : {}),
    };
  });
}

export function normalizedBugReportRelay(value: unknown, label: string): NonNullable<IntegrationSecrets["bugReportRelay"]> {
  const item = value as Record<string, unknown>;
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} is invalid`);
  let relay: BugReportRelayInput;
  try {
    relay = normalizeBugReportRelayInput({ url: item.url, token: item.token });
  } catch (error) {
    throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : "unknown reason"}`);
  }
  if (typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) {
    throw new Error(`${label} is missing a valid updatedAt timestamp`);
  }
  return { ...relay, updatedAt: new Date(item.updatedAt).toISOString() };
}

function normalizedTpLinkConnections(value: unknown): TpLinkConnectionSecret[] {
  if (!Array.isArray(value)) throw new Error("The TP-Link connections in the integration secrets file are invalid");
  const connections: TpLinkConnectionSecret[] = [];
  const ids = new Set<string>();
  const houseHosts = new Set<string>();
  const deviceIds = new Set<string>();
  for (const candidate of value) {
    const item = candidate as Record<string, unknown>;
    if (!item || !isNonEmptyString(item.id) || !isNonEmptyString(item.houseId)
      || !isNonEmptyString(item.host) || !isNonEmptyString(item.username) || !isNonEmptyString(item.password)
      || (item.deviceId !== undefined && (!isNonEmptyString(item.deviceId) || item.deviceId.length > 1_024))
      || (item.sourceType !== undefined && item.sourceType !== "hub" && item.sourceType !== "energy-device")
      || (item.sourceModel !== undefined && (!isNonEmptyString(item.sourceModel) || item.sourceModel.length > 128))
      || (item.sourceAlias !== undefined && (!isNonEmptyString(item.sourceAlias) || item.sourceAlias.length > 512))) {
      throw new Error("The TP-Link connections in the integration secrets file are invalid");
    }
    const id = item.id.trim();
    const houseId = item.houseId.trim();
    const host = item.host.trim();
    const houseHost = `${houseId}\u0000${host.toLowerCase()}`;
    const deviceId = isNonEmptyString(item.deviceId) ? item.deviceId.trim() : undefined;
    const normalizedDeviceId = deviceId?.toUpperCase();
    if (ids.has(id) || houseHosts.has(houseHost) || (normalizedDeviceId && deviceIds.has(normalizedDeviceId))) {
      throw new Error("The TP-Link connections in the integration secrets file contain conflicting identities or addresses");
    }
    ids.add(id);
    houseHosts.add(houseHost);
    if (normalizedDeviceId) deviceIds.add(normalizedDeviceId);
    connections.push({
      id,
      houseId,
      host,
      username: item.username.trim(),
      password: item.password,
      ...(deviceId ? { deviceId } : {}),
      ...(item.sourceType === "hub" || item.sourceType === "energy-device" ? { sourceType: item.sourceType } : {}),
      ...(isNonEmptyString(item.sourceModel) ? { sourceModel: item.sourceModel.trim() } : {}),
      ...(isNonEmptyString(item.sourceAlias) ? { sourceAlias: item.sourceAlias.trim() } : {}),
    });
  }
  return connections;
}

function normalizedGreeMac(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null;
  const normalized = value.replace(/[:-]/g, "").trim().toUpperCase();
  return /^[0-9A-F]{12}$/u.test(normalized) ? normalized : null;
}

function normalizedOptionalGreeString(
  value: unknown,
  maximumLength: number,
): string | undefined | null {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value) || value.length > maximumLength) return null;
  return value.trim();
}

function normalizedGreeConnections(value: unknown): GreeConnectionSecret[] {
  if (!Array.isArray(value)) throw new Error("The Gree connections in the integration secrets file are invalid");
  const ids = new Set<string>();
  const macs = new Set<string>();
  return value.map((candidate) => {
    const item = candidate as Record<string, unknown>;
    const mac = normalizedGreeMac(item?.mac);
    const equipmentId = normalizedOptionalGreeString(item?.equipmentId, 200);
    const name = normalizedOptionalGreeString(item?.name, 200);
    const brand = normalizedOptionalGreeString(item?.brand, 200);
    const model = normalizedOptionalGreeString(item?.model, 200);
    const version = normalizedOptionalGreeString(item?.version, 200);
    const transport = item?.transport === undefined ? "local" : item.transport;
    const cloudUsername = normalizedOptionalGreeString(item?.cloudUsername, 320);
    const cloudPassword = item?.cloudPassword === undefined
      ? undefined
      : typeof item.cloudPassword === "string" && item.cloudPassword.length > 0 && item.cloudPassword.length <= 8_192
        ? item.cloudPassword
        : null;
    if (!item || !isNonEmptyString(item.id) || item.id.length > 200
      || !isNonEmptyString(item.houseId) || item.houseId.length > 200
      || !isNonEmptyString(item.host) || item.host.length > 253
      || typeof item.port !== "number" || !Number.isInteger(item.port) || item.port < 1 || item.port > 65_535
      || !mac || !isNonEmptyString(item.key) || item.key.length > 256
      || (item.cipherVersion !== 1 && item.cipherVersion !== 2)
      || (transport !== "local" && transport !== "ewpe-cloud")
      || equipmentId === null || name === null || brand === null || model === null || version === null
      || cloudUsername === null || cloudPassword === null
      || (transport === "ewpe-cloud" && (!cloudUsername || !cloudPassword))) {
      throw new Error("The Gree connections in the integration secrets file are invalid");
    }
    const id = item.id.trim();
    if (ids.has(id) || macs.has(mac)) {
      throw new Error("The Gree connections in the integration secrets file contain conflicting identities");
    }
    ids.add(id);
    macs.add(mac);
    return {
      id,
      houseId: item.houseId.trim(),
      ...(equipmentId ? { equipmentId } : {}),
      ...(transport === "ewpe-cloud" ? { transport } : {}),
      host: item.host.trim(),
      port: Number(item.port),
      mac,
      key: item.key,
      cipherVersion: item.cipherVersion,
      ...(name ? { name } : {}),
      ...(brand ? { brand } : {}),
      ...(model ? { model } : {}),
      ...(version ? { version } : {}),
      ...(cloudUsername ? { cloudUsername } : {}),
      ...(cloudPassword ? { cloudPassword } : {}),
    };
  });
}

function normalizedTuyaConnections(value: unknown): TuyaConnectionSecret[] {
  if (!Array.isArray(value)) throw new Error("The Tuya connections in the integration secrets file are invalid");
  const ids = new Set<string>();
  const deviceIds = new Set<string>();
  return value.map((candidate) => {
    const item = candidate as Record<string, unknown>;
    const optional = (field: string, maximumLength: number): string | undefined | null => {
      const fieldValue = item?.[field];
      if (fieldValue === undefined) return undefined;
      if (!isNonEmptyString(fieldValue) || fieldValue.length > maximumLength) return null;
      return fieldValue.trim();
    };
    const equipmentId = optional("equipmentId", 200);
    const sensorId = optional("sensorId", 200);
    const model = optional("model", 200);
    const productKey = optional("productKey", 200);
    const rawMac = optional("mac", 32);
    const mac = rawMac === undefined ? undefined : normalizedGreeMac(rawMac);
    if (!item || !isNonEmptyString(item.id) || item.id.length > 200
      || !isNonEmptyString(item.houseId) || item.houseId.length > 200
      || !isNonEmptyString(item.host) || item.host.length > 253
      || !isNonEmptyString(item.deviceId) || item.deviceId.length > 200
      || !isNonEmptyString(item.localKey) || item.localKey.length > 256
      || !["3.1", "3.2", "3.3", "3.4", "3.5"].includes(String(item.protocolVersion))
      || !["tuya-light-dp20-v1", "tuya-outlet-dp1-meter-v1", "tuya-switch-dp1-v1"]
        .includes(String(item.profileId))
      || !isNonEmptyString(item.name) || item.name.length > 200
      || equipmentId === null || sensorId === null || model === null || productKey === null
      || rawMac === null || (rawMac !== undefined && !mac)) {
      throw new Error("The Tuya connections in the integration secrets file are invalid");
    }
    const id = item.id.trim();
    const deviceId = item.deviceId.trim();
    if (ids.has(id) || deviceIds.has(deviceId)) {
      throw new Error("The Tuya connections in the integration secrets file contain conflicting identities");
    }
    ids.add(id);
    deviceIds.add(deviceId);
    return {
      id,
      houseId: item.houseId.trim(),
      ...(equipmentId ? { equipmentId } : {}),
      ...(sensorId ? { sensorId } : {}),
      host: item.host.trim(),
      deviceId,
      localKey: item.localKey as string,
      protocolVersion: item.protocolVersion as TuyaConnectionSecret["protocolVersion"],
      profileId: (item.profileId as string).trim(),
      name: item.name.trim(),
      ...(model ? { model } : {}),
      ...(productKey ? { productKey } : {}),
      ...(mac ? { mac } : {}),
    };
  });
}

function normalizedHomeAssistantConnections(value: unknown): HomeAssistantConnectionSecret[] {
  if (!Array.isArray(value)) {
    throw new Error("The house Home Assistant connections in the integration secrets file are invalid");
  }
  const houseIds = new Set<string>();
  return value.map((candidate) => {
    const item = candidate as Record<string, unknown>;
    if (!item || !isNonEmptyString(item.houseId) || !isNonEmptyString(item.url) || !isNonEmptyString(item.token)
      || houseIds.has(item.houseId.trim())) {
      throw new Error("The house Home Assistant connections in the integration secrets file are invalid");
    }
    const houseId = item.houseId.trim();
    houseIds.add(houseId);
    return { houseId, url: item.url.trim(), token: item.token };
  });
}

function normalizedAppleNotesGrants(value: unknown): AppleNotesGrantSecret[] {
  if (!Array.isArray(value)) throw new Error("The Apple Notes grants in the integration secrets file are invalid");
  const grants: AppleNotesGrantSecret[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const item = candidate as Record<string, unknown>;
    if (!item || !isNonEmptyString(item.id) || typeof item.tokenHash !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(item.tokenHash)
      || !isNonEmptyString(item.deviceLabel) || !isNonEmptyString(item.houseId)
      || !isNonEmptyString(item.createdAt) || !Number.isFinite(Date.parse(item.createdAt))) {
      throw new Error("The Apple Notes grants in the integration secrets file are invalid");
    }
    if (ids.has(item.id)) throw new Error("The Apple Notes grants in the integration secrets file contain duplicate ids");
    ids.add(item.id);
    grants.push({
      id: item.id.trim(),
      tokenHash: item.tokenHash,
      deviceLabel: item.deviceLabel.trim(),
      houseId: item.houseId.trim(),
      createdAt: new Date(item.createdAt).toISOString(),
    });
  }
  return grants;
}

function normalizedHiddenHouseData(value: unknown): HiddenHouseIntegrationData[] {
  if (!Array.isArray(value)) throw new Error("The hidden Home integration data are invalid");
  const houseIds = new Set<string>();
  return value.map((candidate) => {
    const item = candidate as Record<string, unknown>;
    if (!item || !isNonEmptyString(item.houseId) || houseIds.has(item.houseId.trim())
      || !isNonEmptyString(item.hiddenAt) || !Number.isFinite(Date.parse(item.hiddenAt))) {
      throw new Error("The hidden Home integration data are invalid");
    }
    const houseId = item.houseId.trim();
    const homeAssistantConnections = normalizedHomeAssistantConnections(item.homeAssistantConnections ?? []);
    const tpLinkConnections = normalizedTpLinkConnections(item.tpLinkConnections ?? []);
    const greeConnections = normalizedGreeConnections(item.greeConnections ?? []);
    const tuyaConnections = normalizedTuyaConnections(item.tuyaConnections ?? []);
    const appleNotesGrants = normalizedAppleNotesGrants(item.appleNotesGrants ?? []);
    if ([...homeAssistantConnections, ...tpLinkConnections, ...greeConnections, ...tuyaConnections, ...appleNotesGrants]
      .some((entry) => entry.houseId !== houseId)) {
      throw new Error("The hidden Home integration data cross a Home boundary");
    }
    houseIds.add(houseId);
    const homeAssistant = item.homeAssistant === undefined
      ? undefined
      : (() => {
          const value = item.homeAssistant as Record<string, unknown>;
          if (!value || !isNonEmptyString(value.url) || !isNonEmptyString(value.token)) {
            throw new Error("The hidden Home Assistant credentials are invalid");
          }
          return { url: value.url.trim(), token: value.token };
        })();
    const tpLink = item.tpLink === undefined
      ? undefined
      : (() => {
          const value = item.tpLink as Record<string, unknown>;
          if (!value || !isNonEmptyString(value.host) || !isNonEmptyString(value.username) || !isNonEmptyString(value.password)) {
            throw new Error("The hidden TP-Link credentials are invalid");
          }
          return { host: value.host.trim(), username: value.username.trim(), password: value.password };
        })();
    return {
      houseId,
      hiddenAt: new Date(item.hiddenAt).toISOString(),
      ...(homeAssistant ? { homeAssistant } : {}),
      ...(tpLink ? { tpLink } : {}),
      homeAssistantConnections,
      tpLinkConnections,
      greeConnections,
      tuyaConnections,
      appleNotesGrants,
    };
  });
}

function storedExportDestinations(value: unknown): Pick<IntegrationSecrets, "exportDestinations"> {
  return value === undefined
    ? {}
    : { exportDestinations: normalizedExportDestinationSecrets(value, "The export destinations in the integration secrets file") };
}

function patchExportDestinations(next: IntegrationSecrets, value: ExportDestinationSecrets | null | undefined): void {
  if (value === null) delete next.exportDestinations;
  else if (value !== undefined) next.exportDestinations = normalizedExportDestinationSecrets(value, "The export destinations");
}

export function readIntegrationSecrets(path: string): IntegrationSecrets {
  if (!existsSync(path)) return { version: 1 };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (parsed.version !== 1) throw new Error("The integration secrets file has an unsupported version");

  const result: IntegrationSecrets = { version: 1 };
  if (parsed.databaseRevision !== undefined) {
    if (typeof parsed.databaseRevision !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(parsed.databaseRevision)) {
      throw new Error("The integration secrets database revision is invalid");
    }
    result.databaseRevision = parsed.databaseRevision;
  }
  if (parsed.metadataSnapshotIncomplete !== undefined) {
    if (parsed.metadataSnapshotIncomplete !== true) throw new Error("The integration metadata completeness marker is invalid");
    result.metadataSnapshotIncomplete = true;
  }
  if (parsed.homeAssistant !== undefined) {
    const value = parsed.homeAssistant as Record<string, unknown>;
    if (!value || !isNonEmptyString(value.url) || !isNonEmptyString(value.token)) {
      throw new Error("The Home Assistant credentials in the integration secrets file are invalid");
    }
    result.homeAssistant = { url: value.url.trim(), token: value.token };
  }
  if (parsed.homeAssistantLegacyDisabled !== undefined) {
    if (parsed.homeAssistantLegacyDisabled !== true) throw new Error("The Home Assistant legacy-disable marker is invalid");
    result.homeAssistantLegacyDisabled = true;
  }
  if (parsed.homeAssistantConnections !== undefined) {
    result.homeAssistantConnections = normalizedHomeAssistantConnections(parsed.homeAssistantConnections);
  }
  if (parsed.tpLink !== undefined) {
    const value = parsed.tpLink as Record<string, unknown>;
    if (!value || !isNonEmptyString(value.host) || !isNonEmptyString(value.username) || !isNonEmptyString(value.password)) {
      throw new Error("The TP-Link credentials in the integration secrets file are invalid");
    }
    result.tpLink = { host: value.host.trim(), username: value.username.trim(), password: value.password };
  }
  if (parsed.tpLinkLegacyDisabled !== undefined) {
    if (parsed.tpLinkLegacyDisabled !== true) throw new Error("The TP-Link legacy-disable marker is invalid");
    result.tpLinkLegacyDisabled = true;
  }
  if (parsed.tpLinkConnections !== undefined) {
    result.tpLinkConnections = normalizedTpLinkConnections(parsed.tpLinkConnections);
  }
  if (parsed.greeConnections !== undefined) {
    result.greeConnections = normalizedGreeConnections(parsed.greeConnections);
  }
  if (parsed.tuyaConnections !== undefined) {
    result.tuyaConnections = normalizedTuyaConnections(parsed.tuyaConnections);
  }
  if (parsed.webhook !== undefined) {
    const value = parsed.webhook as Record<string, unknown>;
    if (!value || (value.bearerToken !== undefined
      && (typeof value.bearerToken !== "string" || !value.bearerToken || value.bearerToken.length > 8_192))) {
      throw new Error("The webhook credentials in the integration secrets file are invalid");
    }
    if (value.signingSecret !== undefined && (typeof value.signingSecret !== "string"
      || Buffer.byteLength(value.signingSecret, "utf8") < 32 || value.signingSecret.length > 8_192)) {
      throw new Error("The webhook signing secret in the integration secrets file is invalid");
    }
    result.webhook = {
      url: protectedHttpEndpoint(value.url, "The webhook URL in the integration secrets file"),
      ...(typeof value.bearerToken === "string" ? { bearerToken: value.bearerToken } : {}),
      ...(typeof value.signingSecret === "string" ? { signingSecret: value.signingSecret } : {}),
    };
  }
  if (parsed.webhookDestinations !== undefined) {
    if (result.webhook) throw new Error("The integration secrets file cannot configure both legacy and multi-destination webhooks");
    result.webhookDestinations = normalizedWebhookDestinations(
      parsed.webhookDestinations,
      "The webhook destinations in the integration secrets file",
    );
  }
  if (parsed.telegram !== undefined) {
    const value = parsed.telegram as Record<string, unknown>;
    if (!value || typeof value.botToken !== "string" || !/^[A-Za-z0-9:_-]{1,256}$/.test(value.botToken.trim())
      || typeof value.chatId !== "string" || !/^-?\d{1,20}$/.test(value.chatId.trim())) {
      throw new Error("The Telegram credentials in the integration secrets file are invalid");
    }
    result.telegram = { botToken: value.botToken.trim(), chatId: value.chatId.trim() };
  }
  if (parsed.bugReportRelay !== undefined) {
    result.bugReportRelay = normalizedBugReportRelay(
      parsed.bugReportRelay,
      "The bug report relay in the integration secrets file",
    );
  }
  Object.assign(result, storedExportDestinations(parsed.exportDestinations));
  if (parsed.appleNotesGrants !== undefined) {
    result.appleNotesGrants = normalizedAppleNotesGrants(parsed.appleNotesGrants);
  }
  if (parsed.hiddenHouseData !== undefined) result.hiddenHouseData = normalizedHiddenHouseData(parsed.hiddenHouseData);
  return result;
}

export function writeIntegrationSecrets(path: string, secrets: IntegrationSecrets): void {
  if (secrets.webhook && secrets.webhookDestinations) {
    throw new Error("Integration secrets cannot configure both legacy and multi-destination webhooks");
  }
  if (secrets.databaseRevision !== undefined
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(secrets.databaseRevision)) {
    throw new Error("The integration secrets database revision is invalid");
  }
  const validatedSecrets: IntegrationSecrets = {
    ...secrets,
    ...(secrets.tpLinkConnections === undefined
      ? {}
      : { tpLinkConnections: normalizedTpLinkConnections(secrets.tpLinkConnections) }),
    ...(secrets.greeConnections === undefined
      ? {}
      : { greeConnections: normalizedGreeConnections(secrets.greeConnections) }),
    ...(secrets.tuyaConnections === undefined
      ? {}
      : { tuyaConnections: normalizedTuyaConnections(secrets.tuyaConnections) }),
    ...(secrets.hiddenHouseData === undefined
      ? {}
      : { hiddenHouseData: normalizedHiddenHouseData(secrets.hiddenHouseData) }),
    ...(secrets.webhookDestinations === undefined
      ? {}
      : { webhookDestinations: normalizedWebhookDestinations(secrets.webhookDestinations, "Webhook destinations") }),
  };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the host. */ }

  const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(validatedSecrets, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
    renameSync(temporary, path);
    try {
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch {
      // Windows does not expose directory fsync. The file was flushed before the atomic rename.
    }
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* Best-effort cleanup after a failed write. */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* Preserve the original write error. */ }
    }
  }
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
}

export interface IntegrationSecretsPatch {
    metadataSnapshotIncomplete?: boolean;
    homeAssistant?: IntegrationSecrets["homeAssistant"] | null;
    homeAssistantLegacyDisabled?: boolean;
    homeAssistantConnections?: HomeAssistantConnectionSecret[];
    tpLink?: IntegrationSecrets["tpLink"] | null;
    tpLinkLegacyDisabled?: boolean;
    tpLinkConnections?: TpLinkConnectionSecret[];
    greeConnections?: GreeConnectionSecret[];
    tuyaConnections?: TuyaConnectionSecret[];
    webhook?: IntegrationSecrets["webhook"] | null;
    webhookDestinations?: WebhookDestinationSecret[] | null;
    telegram?: IntegrationSecrets["telegram"] | null;
    bugReportRelay?: IntegrationSecrets["bugReportRelay"] | null;
    exportDestinations?: ExportDestinationSecrets | null;
    appleNotesGrants?: AppleNotesGrantSecret[];
    hiddenHouseData?: HiddenHouseIntegrationData[];
    addAppleNotesGrant?: AppleNotesGrantSecret;
    removeAppleNotesGrantId?: string;
}

export function applyIntegrationSecretsPatch(
  current: IntegrationSecrets,
  patch: IntegrationSecretsPatch,
): IntegrationSecrets {
    const next: IntegrationSecrets = structuredClone(current);
    if (patch.metadataSnapshotIncomplete === true) next.metadataSnapshotIncomplete = true;
    else if (patch.metadataSnapshotIncomplete === false) delete next.metadataSnapshotIncomplete;
    if (patch.homeAssistant === null) delete next.homeAssistant;
    else if (patch.homeAssistant !== undefined) next.homeAssistant = patch.homeAssistant;
    if (patch.homeAssistantLegacyDisabled === true) next.homeAssistantLegacyDisabled = true;
    else if (patch.homeAssistantLegacyDisabled === false) delete next.homeAssistantLegacyDisabled;
    if (patch.homeAssistantConnections !== undefined) {
      next.homeAssistantConnections = patch.homeAssistantConnections.map((connection) => ({ ...connection }));
    }
    if (patch.tpLink === null) delete next.tpLink;
    else if (patch.tpLink !== undefined) next.tpLink = patch.tpLink;
    if (patch.tpLinkLegacyDisabled === true) next.tpLinkLegacyDisabled = true;
    else if (patch.tpLinkLegacyDisabled === false) delete next.tpLinkLegacyDisabled;
    if (patch.tpLinkConnections !== undefined) next.tpLinkConnections = normalizedTpLinkConnections(patch.tpLinkConnections);
    if (patch.greeConnections !== undefined) next.greeConnections = normalizedGreeConnections(patch.greeConnections);
    if (patch.tuyaConnections !== undefined) next.tuyaConnections = normalizedTuyaConnections(patch.tuyaConnections);
    if (patch.webhook === null) delete next.webhook;
    else if (patch.webhook !== undefined) {
      next.webhook = { ...patch.webhook };
      delete next.webhookDestinations;
    }
    if (patch.webhookDestinations === null) delete next.webhookDestinations;
    else if (patch.webhookDestinations !== undefined) {
      next.webhookDestinations = normalizedWebhookDestinations(patch.webhookDestinations, "Webhook destinations");
      delete next.webhook;
    }
    if (patch.telegram === null) delete next.telegram;
    else if (patch.telegram !== undefined) next.telegram = patch.telegram;
    if (patch.bugReportRelay === null) delete next.bugReportRelay;
    else if (patch.bugReportRelay !== undefined) {
      next.bugReportRelay = normalizedBugReportRelay(patch.bugReportRelay, "The bug report relay");
    }
    patchExportDestinations(next, patch.exportDestinations);
    if (patch.appleNotesGrants !== undefined) next.appleNotesGrants = patch.appleNotesGrants.map((grant) => ({ ...grant }));
    if (patch.hiddenHouseData !== undefined) next.hiddenHouseData = normalizedHiddenHouseData(patch.hiddenHouseData);
    if (patch.addAppleNotesGrant !== undefined) {
      const grants = next.appleNotesGrants ?? [];
      if (grants.some((grant) => grant.id === patch.addAppleNotesGrant!.id)) {
        throw new Error(`Apple Notes grant ${patch.addAppleNotesGrant.id} already exists`);
      }
      next.appleNotesGrants = [...grants, { ...patch.addAppleNotesGrant }];
    }
    if (patch.removeAppleNotesGrantId !== undefined) {
      next.appleNotesGrants = (next.appleNotesGrants ?? [])
        .filter((grant) => grant.id !== patch.removeAppleNotesGrantId);
    }
    return next;
}

export function updateIntegrationSecrets(
  path: string,
  patch: IntegrationSecretsPatch,
): IntegrationSecrets {
  return withIntegrationSecretsLock(path, () => {
    if (existsSync(pendingIntegrationSecretsPath(path))) {
      throw new Error("A committed integration secrets update is pending recovery");
    }
    const next = applyIntegrationSecretsPatch(readIntegrationSecrets(path), patch);
    writeIntegrationSecrets(path, next);
    return next;
  });
}
