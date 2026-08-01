import { createPrivateKey, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  readIntegrationSecrets,
  normalizedWebhookDestinations,
  type AppleNotesGrantSecret,
  type GreeConnectionSecret,
  type HomeAssistantConnectionSecret,
  type TpLinkConnectionSecret,
  type TuyaConnectionSecret,
  type WebhookDestinationSecret,
} from "../integration-secrets.js";

export interface AppConfig {
  port: number;
  apiHost: string;
  databasePath: string;
  /** Optional local-only research engine. Older programmatic configs may omit these fields. */
  spatialLayersEnabled?: boolean;
  spatialLayersDatabasePath?: string;
  spatialLayersIntervalMs?: number;
  spatialLayersRetentionDays?: number;
  /** Property-wide BLE equipment tracking remains an explicit deployment opt-in. */
  trackingEnabled?: boolean;
  trackingMobileObserverEnabled?: boolean;
  trackingIosBackgroundEnabled?: boolean;
  trackingAndroidBackgroundEnabled?: boolean;
  trackingAndroidGatewayModeEnabled?: boolean;
  trackingLiveMapEnabled?: boolean;
  trackingMovementTrailsEnabled?: boolean;
  trackingExitAlertsEnabled?: boolean;
  trackingUserLocationSharingEnabled?: boolean;
  /** Server-owned key for endpoint identity encryption and pseudonymous references. */
  trackingSecretKeyFile?: string | null;
  integrationSecretsFile: string;
  assetDirectory: string;
  /** Protected internal Ed25519 identity. Never exposed through configuration APIs. */
  stugubyIdentityFile?: string | null;
  stugubyNodeName?: string;
  stugubySyncIntervalMs?: number;
  /** Server-owned coordinator origin. Participants never need to configure one. */
  stugubyPublicOrigin?: string | null;
  /** Safe setup suggestion inferred from browser/edge configuration; never authoritative by itself. */
  stugubySuggestedPublicOrigin?: string | null;
  /** Cloudflare must expose the signed machine path before the UI may persist its suggested origin. */
  stugubyCoordinatorProvisioningRequired?: boolean;
  /** Shared, non-secret coordination directory used by the isolated backup worker. */
  backupOperationsDirectory?: string;
  /** Read-only manifest discovery path for local/non-Compose operation. */
  backupDirectory?: string;
  /** Shared coordination directory consumed by the external, self-replacing update agent. */
  systemUpdateOperationsDirectory?: string | null;
  /** Public GitHub repository used only for release discovery. */
  systemUpdateRepository?: string;
  /** Trusted GHCR image prefix; release data can never override this registry namespace. */
  systemUpdateImagePrefix?: string;
  /** Read-only host declaration. Optional source adapters stay absent unless explicitly advertised. */
  hostCapabilitiesFile?: string | null;
  sourceMqttHost?: string;
  sourceMqttPort?: number;
  sourceMqttUser?: string;
  /** Subscriber credential mounted only by deployments that offer source ingress. */
  sourceMqttPasswordFile?: string | null;
  mockEnabled: boolean;
  mockIntervalMs: number;
  retentionDays: number;
  /** Optional durable time-series store. SQLite remains the local control plane and fallback. */
  timeseriesEnabled?: boolean;
  /** Fail startup when the time-series store cannot be initialized. Off by default for local resilience. */
  timeseriesRequired?: boolean;
  timeseriesHost?: string;
  timeseriesPort?: number;
  timeseriesDatabase?: string;
  timeseriesUser?: string;
  /** Write-only PostgreSQL credential. Never include AppConfig in logs or API responses. */
  timeseriesPassword?: string;
  /** PostgreSQL transport security. Compose's private network uses disable. */
  timeseriesSslMode?: "disable" | "require" | "verify-ca" | "verify-full";
  /** Optional PEM CA bundle contents loaded from TIMESERIES_SSL_CA_FILE. */
  timeseriesSslCa?: string | null;
  timeseriesPoolMax?: number;
  timeseriesConnectTimeoutMs?: number;
  timeseriesStatementTimeoutMs?: number;
  timeseriesBatchSize?: number;
  ingestApiKey: string | null;
  haUrl: string | null;
  haToken: string | null;
  haEntityMapFile: string | null;
  /** House-scoped connections saved through the UI. Legacy HA_* remains one advanced override. */
  homeAssistantConnections?: HomeAssistantConnectionSecret[];
  /** A saved UI migration/disconnect prevents legacy HA_* from reappearing after restart. */
  homeAssistantLegacyDisabled?: boolean;
  tpLinkHost: string | null;
  tpLinkUsername: string | null;
  tpLinkPassword: string | null;
  /** House-scoped connections saved through the UI. Legacy TP_LINK_* remains one advanced override. */
  tpLinkConnections?: TpLinkConnectionSecret[];
  /** A saved UI migration/disconnect prevents legacy TP_LINK_* from reappearing after restart. */
  tpLinkLegacyDisabled?: boolean;
  tpLinkDeviceMapFile: string | null;
  tpLinkPollIntervalMs: number;
  tpLinkPython: string;
  tpLinkBridgeScript: string;
  /** House-scoped local Gree/Wilfa bindings saved after LAN discovery. */
  greeConnections?: GreeConnectionSecret[];
  greePollIntervalMs?: number;
  greePython?: string;
  greeBridgeScript?: string;
  /** Directed broadcast targets required by some bridged/container networks. */
  greeDiscoveryTargets?: string[];
  /** Home-scoped local Tuya LAN credentials saved after explicit verification. */
  tuyaConnections?: TuyaConnectionSecret[];
  tuyaPollIntervalMs?: number;
  tuyaPython?: string;
  tuyaBridgeScript?: string;
  /** Enables asynchronous Tapo app/private-history fallback after local retention is exhausted. */
  tapoHistoryEnabled?: boolean;
  /** Route-scoped bearer secret shared only with the isolated Appium worker. */
  tapoHistoryWorkerToken?: string | null;
  tapoHistoryExportEmail?: string | null;
  tapoHistoryEmailTagPrefix?: string;
  tapoHistoryExportIntervalMinutes?: 1 | 15 | 30 | 60 | 360 | 720 | 1440;
  /** Conservative app-report span; the public UI has truncated longer requests in practice. */
  tapoHistoryMaxExportDays?: number;
  /** Bounds correlated app exports that have been submitted but not yet ingested. */
  tapoHistoryMaxPendingEmails?: number;
  tapoHistoryMailboxPollIntervalMs?: number;
  /** How long a submitted app export may wait for its correlated email before automatic retry. */
  tapoHistoryEmailTimeoutMs?: number;
  tapoHistoryWorkerLeaseMs?: number;
  /** Gmail OAuth credentials are write-only deployment secrets. */
  /** Primary mailbox identity returned by Gmail /users/me/profile. */
  tapoHistoryGmailAccountEmail?: string | null;
  tapoHistoryGmailClientId?: string | null;
  tapoHistoryGmailClientSecret?: string | null;
  tapoHistoryGmailRefreshToken?: string | null;
  /** Experimental, explicitly configured compatibility endpoint. Never enabled by default. */
  tapoHistoryPrivateEndpoint?: string | null;
  tapoHistoryPrivateToken?: string | null;
  alertWebhookUrl: string | null;
  alertWebhookBearerToken: string | null;
  /** All effective webhook destinations. Legacy singleton fields above project the primary/first entry. */
  alertWebhookDestinations?: WebhookDestinationSecret[];
  /** Optional HMAC-SHA256 signing key. Receivers verify X-Stugu-Timestamp and X-Stugu-Signature. */
  alertWebhookSigningSecret?: string | null;
  /** Exact host allowlist; redirects are never followed. */
  alertWebhookAllowedHosts?: string[];
  /** Effective source, used only to mirror environment credentials into protected backup storage. */
  alertWebhookSource?: "environment" | "protected-file" | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  /** Apple provider credentials are deployment secrets and are never returned by the API. */
  apnsTeamId?: string | null;
  apnsKeyId?: string | null;
  apnsBundleId?: string | null;
  apnsPrivateKey?: string | null;
  appleNotesGrants: AppleNotesGrantSecret[];
  corsOrigin: string | null;
  /** Optional high-entropy secret that explicitly permits first-owner setup off loopback. */
  localAuthBootstrapSecret?: string | null;
  /** Unit/integration-test compatibility only; rejected outside NODE_ENV=test. */
  localAuthTestBypass?: boolean;
  /** Browser-visible bind of the bundled private proxy; only an explicit loopback value enables proxy bootstrap. */
  localAuthProxyBindAddress?: string | null;
  /** High-entropy credential used to authenticate the immediate reverse proxy. */
  localAuthProxySecret?: string | null;
  /** HTTPS relay that owns the GitHub App credential; never exposed through APIs. */
  bugReportRelayUrl?: string | null;
  /** Shared high-entropy relay credential; never expose or log AppConfig. */
  bugReportRelayToken?: string | null;
  /** Optional account-scoped Cloudflare Access group synchronized from local members and invitations. */
  cloudflareAccessAccountId?: string | null;
  cloudflareAccessGroupId?: string | null;
  cloudflareAccessGroupName?: string | null;
  /** Cloudflare identities that permanently retain access, independent of local Stugu account email. */
  cloudflareAccessStaticEmails?: string[];
  /** Write-only, least-privilege Access group credential. Never log AppConfig. */
  cloudflareAccessApiToken?: string | null;
  cloudflareAccessSyncIntervalMs?: number;
  /** Read-only deployment metadata used by the local UI setup coordinator. */
  cloudflareSetupDeploymentFile?: string | null;
  /** Optional pre-registered public/private OAuth client ID. It is not a secret. */
  cloudflareSetupOAuthClientId?: string | null;
  /** Browser-facing loopback port used only for local setup guidance. */
  cloudflareSetupLocalUiPort?: number;
  /** Explicit opt-in for a deliberately private-network custom electricity feed. */
  electricityAllowPrivateEndpoints?: boolean;
}

export function configuredAlertWebhookDestinations(
  config: Pick<AppConfig, "alertWebhookDestinations" | "alertWebhookUrl" | "alertWebhookBearerToken" | "alertWebhookSigningSecret">,
): WebhookDestinationSecret[] {
  if (config.alertWebhookDestinations !== undefined) {
    return config.alertWebhookDestinations.map((destination) => ({ ...destination }));
  }
  if (!config.alertWebhookUrl) return [];
  return [{
    id: "primary",
    url: config.alertWebhookUrl,
    ...(config.alertWebhookBearerToken ? { bearerToken: config.alertWebhookBearerToken } : {}),
    ...(config.alertWebhookSigningSecret ? { signingSecret: config.alertWebhookSigningSecret } : {}),
  }];
}

export function optional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizedEmailList(value: string | undefined, name: string): string[] {
  const emails = [...new Set((value ?? "").split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean))];
  for (const email of emails) {
    if (email.length > 254 || !/^[^\s@<>,]+@[^\s@<>,]+$/.test(email)) {
      throw new Error(`${name} must contain only valid comma-separated email addresses`);
    }
  }
  return emails;
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

export function timeseriesSslMode(value: string | undefined): NonNullable<AppConfig["timeseriesSslMode"]> {
  const normalized = optional(value) ?? "disable";
  if (!["disable", "require", "verify-ca", "verify-full"].includes(normalized)) {
    throw new Error("TIMESERIES_SSL_MODE must be disable, require, verify-ca, or verify-full");
  }
  return normalized as NonNullable<AppConfig["timeseriesSslMode"]>;
}

export function timeseriesPassword(env: NodeJS.ProcessEnv): string {
  const inline = env.TIMESERIES_PASSWORD;
  const configuredFile = optional(env.TIMESERIES_PASSWORD_FILE);
  if (inline !== undefined && configuredFile) {
    throw new Error("Configure only one of TIMESERIES_PASSWORD or TIMESERIES_PASSWORD_FILE");
  }
  if (!configuredFile) return inline ?? "";
  const password = readFileSync(resolve(configuredFile), "utf8").trim();
  if (!password) throw new Error("TIMESERIES_PASSWORD_FILE must not be empty");
  return password;
}

export function validatedSecret(value: string, label: string): string {
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${label} must contain at least 32 UTF-8 bytes`);
  }
  return value;
}

export function optionalFileSecret(
  env: NodeJS.ProcessEnv,
  inlineKey: string,
  fileKey: string,
  label: string,
  minimumBytes = 1,
  allowMissingFile = false,
): string | null {
  const inline = optional(env[inlineKey]);
  const configuredFile = optional(env[fileKey]);
  if (inline && configuredFile) throw new Error(`Configure only one of ${inlineKey} or ${fileKey}`);
  const resolvedFile = configuredFile ? resolve(configuredFile) : null;
  if (!inline && resolvedFile && allowMissingFile && !existsSync(resolvedFile)) return null;
  const value = inline ?? (resolvedFile ? readFileSync(resolvedFile, "utf8").trim() : null);
  if (value !== null && Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(`${label} must contain at least ${minimumBytes} UTF-8 bytes`);
  }
  return value;
}

export function exportIntervalMinutes(value: string | undefined): 1 | 15 | 30 | 60 | 360 | 720 | 1440 {
  const parsed = Number(value ?? 15);
  if (![1, 15, 30, 60, 360, 720, 1440].includes(parsed)) {
    throw new Error("TAPO_HISTORY_EXPORT_INTERVAL_MINUTES must be 1, 15, 30, 60, 360, 720, or 1440");
  }
  return parsed as 1 | 15 | 30 | 60 | 360 | 720 | 1440;
}

export function localAuthProxySecret(env: NodeJS.ProcessEnv): string | null {
  const inline = optional(env.LOCAL_AUTH_PROXY_SECRET);
  const configuredFile = optional(env.LOCAL_AUTH_PROXY_SECRET_FILE);
  if (inline && configuredFile) {
    throw new Error("Configure only one of LOCAL_AUTH_PROXY_SECRET or LOCAL_AUTH_PROXY_SECRET_FILE");
  }
  if (inline) return validatedSecret(inline, "LOCAL_AUTH_PROXY_SECRET");
  if (!configuredFile) return null;

  const path = resolve(configuredFile);
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dirname(path), { recursive: true });
    value = randomBytes(32).toString("hex");
    try {
      // The proxy mounts this dedicated volume read-only. World-readable mode
      // is intentional within that volume because the two images use distinct UIDs.
      writeFileSync(path, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o444 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      value = readFileSync(path, "utf8").trim();
    }
  }
  if (!value) throw new Error("LOCAL_AUTH_PROXY_SECRET_FILE must not be empty");
  return validatedSecret(value, "LOCAL_AUTH_PROXY_SECRET_FILE contents");
}

export function environmentTuple(
  env: NodeJS.ProcessEnv,
  label: string,
  keys: readonly string[],
): string[] | null {
  const values = keys.map((key) => optional(env[key]));
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) {
    throw new Error(`${label} environment configuration requires ${keys.join(", ")}`);
  }
  return values as string[];
}

export function httpEndpoint(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a valid HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} must be an HTTP(S) URL without embedded credentials`);
  }
  return url.toString().replace(/\/$/, "");
}

export function stugubyPublicOrigin(value: string | undefined): string | null {
  const configured = optional(value);
  if (!configured) return null;
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error("STUGBY_PUBLIC_ORIGIN must be a valid absolute URL"); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("STUGBY_PUBLIC_ORIGIN must use HTTPS (HTTP is allowed only on loopback)");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "")
    || url.search || url.hash) {
    throw new Error(
      "STUGBY_PUBLIC_ORIGIN must be an origin without credentials, a path, query parameters, or a fragment",
    );
  }
  return url.origin;
}

export function inferredStugubyPublicOrigin(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    try {
      const origin = stugubyPublicOrigin(value);
      if (origin) return origin;
    } catch {
      // CORS and edge origins may support configurations that are not valid
      // federation origins. Only explicit STUGBY_PUBLIC_ORIGIN errors are fatal.
    }
  }
  return null;
}

export function githubRepository(value: string | undefined): string {
  const normalized = optional(value) ?? "liljestk/open-stuga";
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(normalized)) {
    throw new Error("SYSTEM_UPDATE_REPOSITORY must use the GitHub owner/repository form");
  }
  return normalized;
}

export function systemUpdateImagePrefix(value: string | undefined, repository: string): string {
  const normalized = optional(value) ?? `ghcr.io/${repository.toLowerCase()}`;
  if (!/^ghcr\.io\/[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/u.test(normalized)) {
    throw new Error("SYSTEM_UPDATE_IMAGE_PREFIX must be a lower-case ghcr.io owner/image prefix");
  }
  return normalized;
}
