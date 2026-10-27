import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export const AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";

export const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";

export const REVOCATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/revoke";

export const CALLBACK_PATH = "/api/v1/cloudflare/setup/oauth/callback";

export const MAX_RESPONSE_BYTES = 64 * 1024;

export const AGENT_MAX_AGE_MS = 2 * 60_000;

export const TRANSACTION_MAX_AGE_MS = 5 * 60_000;

export const ACTIVE_PHASES = new Set(["awaiting-approval", "queued", "provisioning", "applying", "verifying"]);

export const BASE_SCOPES = ["access.write", "argotunnel.write", "dns.write"] as const;

export const ALLOWED_CLIENT_SCOPES = [...BASE_SCOPES, "zone.read"] as const;

export type CloudflareSetupMode = "remote-ui" | "stuguby-coordinator";

export type CloudflareSetupPhase =
  | "awaiting-approval"
  | "queued"
  | "provisioning"
  | "applying"
  | "verifying"
  | "complete"
  | "failed";

export interface CloudflareSetupOperation {
  id: string;
  mode: CloudflareSetupMode;
  hostname: string;
  phase: CloudflareSetupPhase;
  requestedAt: string;
  completedAt: string | null;
  detail: string | null;
}

export interface CloudflareSetupStatus {
  capability: {
    available: boolean;
    agentLastSeenAt: string | null;
    reason: "ready" | "agent-not-connected" | "not-configured" | "agent-upgrade-required";
  };
  configuration: {
    configured: boolean;
    mode: CloudflareSetupMode | null;
    hostname: string | null;
    suggestedZone: string | null;
    accountIdKnown: boolean;
    zoneIdKnown: boolean;
    oauthClientConfigured: boolean;
    runtimeTokenAvailable: boolean;
    ownerEmail: string | null;
  };
  operation: CloudflareSetupOperation | null;
}

export interface CloudflareSetupStartInput {
  mode: CloudflareSetupMode;
  hostname: string;
  zone: string;
  ownerEmail: string;
  accountId?: string | null;
  zoneId?: string | null;
  oauthClientToken?: string | null;
  runtimeToken?: string | null;
}

export interface CloudflareSetupStartResult {
  operation: CloudflareSetupOperation;
  authorizationUrl: string;
}

export interface CloudflareSetupClaim {
  schema: "stugu-cloudflare-setup-claim/v1";
  provisionToken: string;
  accessToken: string;
  oauthClientId: string;
}

export interface CloudflareDeployment {
  version?: unknown;
  mode?: unknown;
  hostname?: unknown;
  accountId?: unknown;
  zoneId?: unknown;
  oauthClientId?: unknown;
  oauthRedirectUri?: unknown;
}

export interface SetupTransaction {
  operation: CloudflareSetupOperation;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  clientId: string;
  runtimeToken: string;
  options: {
    command: "provision" | "provision-coordinator";
    hostname: string;
    zone: string;
    ownerEmail: string;
    accountId: string;
    zoneId: string | null;
  };
  expiresAt: number;
}

export function authorizationUrl(transaction: SetupTransaction): string {
  const authorization = new URL(AUTHORIZATION_ENDPOINT);
  authorization.search = new URLSearchParams({
    client_id: transaction.clientId,
    redirect_uri: transaction.redirectUri,
    response_type: "code",
    scope: transaction.scopes.join(" "),
    state: transaction.state,
    code_challenge: base64Url(createHash("sha256").update(transaction.codeVerifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  return authorization.href;
}

export interface PendingClaim {
  claim: CloudflareSetupClaim;
  secret: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface AgentHeartbeat {
  schema?: unknown;
  ready?: unknown;
  updatedAt?: unknown;
  capabilities?: unknown;
}

export interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number | string }>;
}

export interface CloudflareSetupServiceOptions {
  operationsDirectory?: string | null;
  deploymentFile?: string | null;
  runtimeToken?: string | null;
  ownerEmail?: string | null;
  oauthClientId?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  randomBytesImpl?: typeof randomBytes;
}

export class CloudflareSetupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareSetupError";
  }
}

export function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validHostname(value: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

export function normalizedHostname(value: unknown, label: string): string {
  const hostname = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!validHostname(hostname)) {
    throw new CloudflareSetupError(400, "INVALID_HOSTNAME", `${label} must be a valid DNS name`);
  }
  return hostname;
}

export function normalizedEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@<>,]+@[^\s@<>,]+$/u.test(email)) {
    throw new CloudflareSetupError(400, "INVALID_OWNER_EMAIL", "Enter the email address used to sign in through Cloudflare");
  }
  return email;
}

export function normalizedId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-f0-9]{32}$/iu.test(id)) {
    throw new CloudflareSetupError(400, "INVALID_CLOUDFLARE_ID", `${label} must be a 32-character Cloudflare ID`);
  }
  return id;
}

export function knownId(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{32}$/iu.test(value.trim());
}

export function normalizedToken(value: unknown, label: string): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (Buffer.byteLength(token, "utf8") < 32 || /[\r\n]/u.test(token)) {
    throw new CloudflareSetupError(400, "INVALID_CLOUDFLARE_TOKEN", `${label} could not be used`);
  }
  return token;
}

export function normalizedClientId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const clientId = typeof value === "string" ? value.trim() : "";
  if (clientId.length < 8 || clientId.length > 200 || !/^[A-Za-z0-9._~-]+$/u.test(clientId)) {
    return null;
  }
  return clientId;
}

export function validateCloudflareUiRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudflareSetupError(400, "INVALID_REDIRECT_URI", "The local Cloudflare callback address is invalid");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !Number.isInteger(port)
    || port < 1024
    || port > 65_535
    || url.pathname !== CALLBACK_PATH
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new CloudflareSetupError(
      400,
      "INVALID_REDIRECT_URI",
      "Cloudflare approval must return to Stugu on an explicit local loopback port",
    );
  }
  return url.href;
}

export function suggestedZone(hostname: string | null): string | null {
  if (!hostname) return null;
  const labels = hostname.split(".");
  return labels.length >= 2 ? labels.slice(-2).join(".") : hostname;
}

export function boundedJson(path: string): unknown {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_RESPONSE_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
  renameSync(temporary, path);
}

export function deploymentFromJson(value: unknown): CloudflareDeployment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deployment = value as CloudflareDeployment;
  const version = deployment.version;
  const storedMode = deployment.mode === "stugby-coordinator"
    ? "stuguby-coordinator"
    : deployment.mode;
  const mode = version === 1
    ? "remote-ui"
    : version === 2 && (storedMode === "remote-ui" || storedMode === "stuguby-coordinator")
      ? storedMode
      : null;
  const hostname = typeof deployment.hostname === "string" ? deployment.hostname.trim().toLowerCase() : "";
  if (!mode || !validHostname(hostname)) return null;
  return { ...deployment, mode, hostname };
}

export function operationFromJson(value: unknown): CloudflareSetupOperation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<CloudflareSetupOperation>;
  if (
    typeof input.id !== "string"
    || !/^[0-9a-f-]{36}$/iu.test(input.id)
    || (input.mode !== "remote-ui" && input.mode !== "stuguby-coordinator")
    || typeof input.hostname !== "string"
    || !validHostname(input.hostname)
    || typeof input.phase !== "string"
    || !["awaiting-approval", "queued", "provisioning", "applying", "verifying", "complete", "failed"].includes(input.phase)
    || typeof input.requestedAt !== "string"
    || !Number.isFinite(Date.parse(input.requestedAt))
  ) return null;
  return {
    id: input.id,
    mode: input.mode,
    hostname: input.hostname,
    phase: input.phase as CloudflareSetupPhase,
    requestedAt: new Date(input.requestedAt).toISOString(),
    completedAt: typeof input.completedAt === "string" && Number.isFinite(Date.parse(input.completedAt))
      ? new Date(input.completedAt).toISOString()
      : null,
    detail: typeof input.detail === "string" ? input.detail.slice(0, 2_000) : null,
  };
}

export async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new CloudflareSetupError(502, "CLOUDFLARE_RESPONSE_TOO_LARGE", "Cloudflare returned an oversized response");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CloudflareSetupError(502, "CLOUDFLARE_RESPONSE_TOO_LARGE", "Cloudflare returned an oversized response");
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
