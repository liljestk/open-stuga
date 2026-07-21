import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface IntegrationSecrets {
  version: 1;
  /** Set only when a new file was synthesized from one environment credential. */
  metadataSnapshotIncomplete?: true;
  homeAssistant?: { url: string; token: string };
  homeAssistantLegacyDisabled?: true;
  homeAssistantConnections?: HomeAssistantConnectionSecret[];
  tpLink?: { host: string; username: string; password: string };
  tpLinkLegacyDisabled?: true;
  tpLinkConnections?: TpLinkConnectionSecret[];
  webhook?: { url: string; bearerToken?: string; signingSecret?: string };
  webhookDestinations?: WebhookDestinationSecret[];
  telegram?: { botToken: string; chatId: string };
  appleNotesGrants?: AppleNotesGrantSecret[];
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
      || (item.deviceId !== undefined && (!isNonEmptyString(item.deviceId) || item.deviceId.length > 1_024))) {
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
    });
  }
  return connections;
}

export function readIntegrationSecrets(path: string): IntegrationSecrets {
  if (!existsSync(path)) return { version: 1 };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (parsed.version !== 1) throw new Error("The integration secrets file has an unsupported version");

  const result: IntegrationSecrets = { version: 1 };
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
    if (!Array.isArray(parsed.homeAssistantConnections)) {
      throw new Error("The house Home Assistant connections in the integration secrets file are invalid");
    }
    const houseIds = new Set<string>();
    result.homeAssistantConnections = parsed.homeAssistantConnections.map((candidate) => {
      const value = candidate as Record<string, unknown>;
      if (!value || !isNonEmptyString(value.houseId) || !isNonEmptyString(value.url) || !isNonEmptyString(value.token)
        || houseIds.has(value.houseId.trim())) {
        throw new Error("The house Home Assistant connections in the integration secrets file are invalid");
      }
      const houseId = value.houseId.trim();
      houseIds.add(houseId);
      return { houseId, url: value.url.trim(), token: value.token };
    });
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
  if (parsed.appleNotesGrants !== undefined) {
    if (!Array.isArray(parsed.appleNotesGrants)) {
      throw new Error("The Apple Notes grants in the integration secrets file are invalid");
    }
    const grants: AppleNotesGrantSecret[] = [];
    const ids = new Set<string>();
    for (const candidate of parsed.appleNotesGrants) {
      const value = candidate as Record<string, unknown>;
      if (!value || !isNonEmptyString(value.id) || typeof value.tokenHash !== "string"
        || !/^sha256:[0-9a-f]{64}$/.test(value.tokenHash)
        || !isNonEmptyString(value.deviceLabel) || !isNonEmptyString(value.houseId)
        || !isNonEmptyString(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) {
        throw new Error("The Apple Notes grants in the integration secrets file are invalid");
      }
      if (ids.has(value.id)) throw new Error("The Apple Notes grants in the integration secrets file contain duplicate ids");
      ids.add(value.id);
      grants.push({
        id: value.id.trim(),
        tokenHash: value.tokenHash,
        deviceLabel: value.deviceLabel.trim(),
        houseId: value.houseId.trim(),
        createdAt: new Date(value.createdAt).toISOString(),
      });
    }
    result.appleNotesGrants = grants;
  }
  return result;
}

export function writeIntegrationSecrets(path: string, secrets: IntegrationSecrets): void {
  if (secrets.webhook && secrets.webhookDestinations) {
    throw new Error("Integration secrets cannot configure both legacy and multi-destination webhooks");
  }
  const validatedSecrets: IntegrationSecrets = {
    ...secrets,
    ...(secrets.tpLinkConnections === undefined
      ? {}
      : { tpLinkConnections: normalizedTpLinkConnections(secrets.tpLinkConnections) }),
    ...(secrets.webhookDestinations === undefined
      ? {}
      : { webhookDestinations: normalizedWebhookDestinations(secrets.webhookDestinations, "Webhook destinations") }),
  };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the host. */ }

  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(validatedSecrets, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
    renameSync(temporary, path);
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

export function updateIntegrationSecrets(
  path: string,
  patch: {
    metadataSnapshotIncomplete?: boolean;
    homeAssistant?: IntegrationSecrets["homeAssistant"] | null;
    homeAssistantLegacyDisabled?: boolean;
    homeAssistantConnections?: HomeAssistantConnectionSecret[];
    tpLink?: IntegrationSecrets["tpLink"] | null;
    tpLinkLegacyDisabled?: boolean;
    tpLinkConnections?: TpLinkConnectionSecret[];
    webhook?: IntegrationSecrets["webhook"] | null;
    webhookDestinations?: WebhookDestinationSecret[] | null;
    telegram?: IntegrationSecrets["telegram"] | null;
    appleNotesGrants?: AppleNotesGrantSecret[];
    addAppleNotesGrant?: AppleNotesGrantSecret;
    removeAppleNotesGrantId?: string;
  },
): IntegrationSecrets {
  return withIntegrationSecretsLock(path, () => {
    const next = readIntegrationSecrets(path);
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
    if (patch.appleNotesGrants !== undefined) next.appleNotesGrants = patch.appleNotesGrants.map((grant) => ({ ...grant }));
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
    writeIntegrationSecrets(path, next);
    return next;
  });
}

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 60_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function withIntegrationSecretsLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let descriptor: number | null = null;
  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting to update the integration secrets file");
      }
      Atomics.wait(lockWaitArray, 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(lockPath); } catch { /* A stale-lock recovery may already have removed it. */ }
  }
}
