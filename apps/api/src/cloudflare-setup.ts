import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const REVOCATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/revoke";
const CALLBACK_PATH = "/api/v1/cloudflare/setup/oauth/callback";
const MAX_RESPONSE_BYTES = 64 * 1024;
const AGENT_MAX_AGE_MS = 2 * 60_000;
const TRANSACTION_MAX_AGE_MS = 5 * 60_000;
const ACTIVE_PHASES = new Set(["awaiting-approval", "queued", "provisioning", "applying", "verifying"]);
const BASE_SCOPES = ["access.write", "argotunnel.write", "dns.write"] as const;
const ALLOWED_CLIENT_SCOPES = [...BASE_SCOPES, "zone.read"] as const;

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

interface CloudflareDeployment {
  version?: unknown;
  mode?: unknown;
  hostname?: unknown;
  accountId?: unknown;
  zoneId?: unknown;
  oauthClientId?: unknown;
  oauthRedirectUri?: unknown;
}

interface SetupTransaction {
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

function authorizationUrl(transaction: SetupTransaction): string {
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

interface PendingClaim {
  claim: CloudflareSetupClaim;
  secret: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentHeartbeat {
  schema?: unknown;
  ready?: unknown;
  updatedAt?: unknown;
  capabilities?: unknown;
}

interface CloudflareEnvelope<T> {
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

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validHostname(value: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

function normalizedHostname(value: unknown, label: string): string {
  const hostname = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!validHostname(hostname)) {
    throw new CloudflareSetupError(400, "INVALID_HOSTNAME", `${label} must be a valid DNS name`);
  }
  return hostname;
}

function normalizedEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@<>,]+@[^\s@<>,]+$/u.test(email)) {
    throw new CloudflareSetupError(400, "INVALID_OWNER_EMAIL", "Enter the email address used to sign in through Cloudflare");
  }
  return email;
}

function normalizedId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-f0-9]{32}$/iu.test(id)) {
    throw new CloudflareSetupError(400, "INVALID_CLOUDFLARE_ID", `${label} must be a 32-character Cloudflare ID`);
  }
  return id;
}

function knownId(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{32}$/iu.test(value.trim());
}

function normalizedToken(value: unknown, label: string): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (Buffer.byteLength(token, "utf8") < 32 || /[\r\n]/u.test(token)) {
    throw new CloudflareSetupError(400, "INVALID_CLOUDFLARE_TOKEN", `${label} could not be used`);
  }
  return token;
}

function normalizedClientId(value: unknown): string | null {
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

function suggestedZone(hostname: string | null): string | null {
  if (!hostname) return null;
  const labels = hostname.split(".");
  return labels.length >= 2 ? labels.slice(-2).join(".") : hostname;
}

function boundedJson(path: string): unknown {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_RESPONSE_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
  renameSync(temporary, path);
}

function deploymentFromJson(value: unknown): CloudflareDeployment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deployment = value as CloudflareDeployment;
  const version = deployment.version;
  const mode = version === 1
    ? "remote-ui"
    : version === 2 && (deployment.mode === "remote-ui" || deployment.mode === "stuguby-coordinator")
      ? deployment.mode
      : null;
  const hostname = typeof deployment.hostname === "string" ? deployment.hostname.trim().toLowerCase() : "";
  if (!mode || !validHostname(hostname)) return null;
  return { ...deployment, mode, hostname };
}

function operationFromJson(value: unknown): CloudflareSetupOperation | null {
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

async function boundedText(response: Response): Promise<string> {
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

export class CloudflareSetupService {
  readonly #operationsDirectory: string | null;
  readonly #deploymentFile: string | null;
  readonly #runtimeToken: string | null;
  readonly #ownerEmail: string | null;
  readonly #configuredClientId: string | null;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #randomBytes: typeof randomBytes;
  readonly #transactions = new Map<string, SetupTransaction>();
  readonly #transactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #claims = new Map<string, PendingClaim>();
  #pendingClient: { accountId: string; clientId: string; redirectUri: string } | null = null;
  #starting = false;

  constructor(options: CloudflareSetupServiceOptions = {}) {
    this.#operationsDirectory = options.operationsDirectory ?? null;
    this.#deploymentFile = options.deploymentFile ?? null;
    this.#runtimeToken = options.runtimeToken ? normalizedToken(options.runtimeToken, "Runtime Access token") : null;
    this.#ownerEmail = options.ownerEmail ? normalizedEmail(options.ownerEmail) : null;
    this.#configuredClientId = normalizedClientId(options.oauthClientId);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytesImpl ?? randomBytes;

    const interruptedOperation = this.#operation();
    if (interruptedOperation?.phase === "awaiting-approval") {
      try {
        this.#fail(
          interruptedOperation,
          "Cloudflare approval was interrupted by a Stugu restart. Start again from Stugu.",
        );
      } catch {
        // A later start still replaces an interrupted approval if shared status storage is unavailable.
      }
    }
  }

  status(): CloudflareSetupStatus {
    const deployment = this.#deployment();
    const heartbeat = this.#heartbeat();
    const configuredClientId = normalizedClientId(deployment?.oauthClientId)
      ?? this.#configuredClientId
      ?? this.#pendingClient?.clientId
      ?? null;
    const hostname = typeof deployment?.hostname === "string" ? deployment.hostname : null;
    return {
      capability: {
        available: heartbeat.available,
        agentLastSeenAt: heartbeat.updatedAt,
        reason: heartbeat.reason,
      },
      configuration: {
        configured: Boolean(deployment),
        mode: (deployment?.mode as CloudflareSetupMode | undefined) ?? null,
        hostname,
        suggestedZone: suggestedZone(hostname),
        accountIdKnown: knownId(deployment?.accountId),
        zoneIdKnown: knownId(deployment?.zoneId),
        oauthClientConfigured: Boolean(configuredClientId),
        runtimeTokenAvailable: Boolean(this.#runtimeToken),
        ownerEmail: this.#ownerEmail,
      },
      operation: this.#operation(),
    };
  }

  async start(input: CloudflareSetupStartInput, redirectUriValue: string): Promise<CloudflareSetupStartResult> {
    if (this.#starting) {
      throw new CloudflareSetupError(409, "CLOUDFLARE_SETUP_IN_PROGRESS", "Cloudflare setup is already starting");
    }
    this.#starting = true;
    try {
      return await this.#start(input, redirectUriValue);
    } finally {
      this.#starting = false;
    }
  }

  async #start(input: CloudflareSetupStartInput, redirectUriValue: string): Promise<CloudflareSetupStartResult> {
    const status = this.status();
    if (!status.capability.available) {
      throw new CloudflareSetupError(
        503,
        "CLOUDFLARE_SETUP_AGENT_UNAVAILABLE",
        status.capability.reason === "agent-upgrade-required"
          ? "The connected host agent must be updated before it can apply Cloudflare setup"
          : "The trusted Stugu host agent is not connected",
      );
    }
    if (status.operation && ACTIVE_PHASES.has(status.operation.phase)) {
      const transaction = [...this.#transactions.values()]
        .find(({ operation }) => operation.id === status.operation?.id);
      const staleApproval = status.operation.phase === "awaiting-approval"
        && Date.parse(status.operation.requestedAt) + TRANSACTION_MAX_AGE_MS <= this.#now().getTime();
      const interruptedApproval = status.operation.phase === "awaiting-approval"
        && !transaction;
      if (staleApproval || interruptedApproval) {
        this.#fail(status.operation, "Cloudflare approval expired. Start again from Stugu.");
      } else if (status.operation.phase === "awaiting-approval" && transaction) {
        return {
          operation: transaction.operation,
          authorizationUrl: authorizationUrl(transaction),
        };
      } else {
        throw new CloudflareSetupError(409, "CLOUDFLARE_SETUP_IN_PROGRESS", "Cloudflare setup is already in progress");
      }
    }

    const redirectUri = validateCloudflareUiRedirectUri(redirectUriValue);
    const mode = input.mode;
    if (mode !== "remote-ui" && mode !== "stuguby-coordinator") {
      throw new CloudflareSetupError(400, "INVALID_CLOUDFLARE_MODE", "Choose remote access or shared Stuguby hosting");
    }
    const hostname = normalizedHostname(input.hostname, "Stugu address");
    const zone = normalizedHostname(input.zone, "DNS zone");
    if (hostname !== zone && !hostname.endsWith(`.${zone}`)) {
      throw new CloudflareSetupError(400, "HOSTNAME_OUTSIDE_ZONE", "The Stugu address must belong to the selected DNS zone");
    }
    const ownerEmail = normalizedEmail(input.ownerEmail);
    const deployment = this.#deployment();
    if (deployment?.hostname !== undefined && deployment.hostname !== hostname) {
      throw new CloudflareSetupError(
        409,
        "CLOUDFLARE_DEPLOYMENT_MISMATCH",
        `This Stugu is already connected at ${String(deployment.hostname)}`,
      );
    }
    if (deployment?.mode === "stuguby-coordinator" && mode === "remote-ui") {
      throw new CloudflareSetupError(409, "CLOUDFLARE_DOWNGRADE_REFUSED", "A Stuguby coordinator cannot be downgraded from the UI");
    }

    let accountId = normalizedId(deployment?.accountId, "Account ID") ?? normalizedId(input.accountId, "Account ID");
    const zoneId = normalizedId(deployment?.zoneId, "Zone ID") ?? normalizedId(input.zoneId, "Zone ID");
    const runtimeToken = this.#runtimeToken ?? normalizedToken(input.runtimeToken, "Runtime Access token");
    let clientId = normalizedClientId(deployment?.oauthClientId) ?? this.#configuredClientId;

    if (!clientId && this.#pendingClient?.redirectUri === redirectUri
      && (!accountId || this.#pendingClient.accountId === accountId)) {
      accountId = this.#pendingClient.accountId;
      clientId = this.#pendingClient.clientId;
    }
    if (!clientId) {
      const registrationToken = normalizedToken(input.oauthClientToken, "One-time OAuth client token");
      if (registrationToken === runtimeToken) {
        throw new CloudflareSetupError(
          400,
          "CLOUDFLARE_TOKEN_REUSE",
          "The one-time OAuth client token and retained runtime token must be different",
        );
      }
      accountId ??= await this.#discoverAccount(registrationToken);
      clientId = await this.#createOAuthClient(registrationToken, accountId, hostname, redirectUri);
      this.#pendingClient = { accountId, clientId, redirectUri };
    }
    accountId ??= await this.#discoverAccount(runtimeToken);
    if (!accountId) {
      throw new CloudflareSetupError(400, "CLOUDFLARE_ACCOUNT_REQUIRED", "Cloudflare account selection is required");
    }

    const requestedAt = this.#now().toISOString();
    const operation: CloudflareSetupOperation = {
      id: randomUUID(),
      mode,
      hostname,
      phase: "awaiting-approval",
      requestedAt,
      completedAt: null,
      detail: "Waiting for approval in Cloudflare",
    };
    const state = base64Url(this.#randomBytes(32));
    const codeVerifier = base64Url(this.#randomBytes(48));
    const scopes = [...BASE_SCOPES, ...(!zoneId ? ["zone.read"] : [])];
    const transaction: SetupTransaction = {
      operation,
      state,
      codeVerifier,
      redirectUri,
      scopes,
      clientId,
      runtimeToken,
      options: {
        command: mode === "stuguby-coordinator" ? "provision-coordinator" : "provision",
        hostname,
        zone,
        ownerEmail,
        accountId,
        zoneId,
      },
      expiresAt: this.#now().getTime() + TRANSACTION_MAX_AGE_MS,
    };
    this.#transactions.set(state, transaction);
    const timer = setTimeout(() => {
      if (this.#transactions.get(state) !== transaction) return;
      this.#transactions.delete(state);
      this.#transactionTimers.delete(state);
      try {
        this.#fail(operation, "Cloudflare approval expired. Start again from Stugu.");
      } catch {
        // A later request still rejects the expired state even if status storage disappeared.
      }
    }, TRANSACTION_MAX_AGE_MS);
    timer.unref?.();
    this.#transactionTimers.set(state, timer);
    this.#writeOperation(operation);

    return { operation, authorizationUrl: authorizationUrl(transaction) };
  }

  async completeOAuth(query: URLSearchParams): Promise<CloudflareSetupOperation> {
    const state = query.get("state") ?? "";
    const transaction = this.#transactions.get(state);
    if (!transaction || !equalSecret(transaction.state, state)) {
      throw new CloudflareSetupError(400, "OAUTH_STATE_INVALID", "This Cloudflare approval is not linked to an active Stugu setup");
    }
    this.#transactions.delete(state);
    const transactionTimer = this.#transactionTimers.get(state);
    if (transactionTimer) clearTimeout(transactionTimer);
    this.#transactionTimers.delete(state);
    if (transaction.expiresAt < this.#now().getTime()) {
      return this.#fail(transaction.operation, "Cloudflare approval expired. Start again from Stugu.");
    }
    if (query.get("error")) {
      return this.#fail(transaction.operation, "Cloudflare approval was not granted.");
    }
    const code = query.get("code")?.trim() ?? "";
    if (!code || code.length > 4_096 || /[\r\n]/u.test(code)) {
      return this.#fail(transaction.operation, "Cloudflare did not return a usable approval.");
    }

    let provisionToken: string;
    try {
      provisionToken = await this.#exchangeCode(transaction, code);
    } catch (error) {
      const message = error instanceof CloudflareSetupError
        ? error.message
        : "Cloudflare approval could not be completed.";
      return this.#fail(transaction.operation, message);
    }

    const claimSecret = base64Url(this.#randomBytes(32));
    const claim: CloudflareSetupClaim = {
      schema: "stugu-cloudflare-setup-claim/v1",
      provisionToken,
      accessToken: transaction.runtimeToken,
      oauthClientId: transaction.clientId,
    };
    const timer = setTimeout(() => {
      const pending = this.#claims.get(transaction.operation.id);
      if (!pending || pending.claim !== claim) return;
      this.#claims.delete(transaction.operation.id);
      void this.#revoke(provisionToken, transaction.clientId).catch(() => undefined);
      try {
        this.#fail(transaction.operation, "The trusted host agent did not collect the approval in time.");
      } catch {
        // The grant is still revoked even if shared status storage disappeared.
      }
    }, TRANSACTION_MAX_AGE_MS);
    timer.unref?.();
    this.#claims.set(transaction.operation.id, {
      claim,
      secret: claimSecret,
      expiresAt: this.#now().getTime() + TRANSACTION_MAX_AGE_MS,
      timer,
    });

    const queued: CloudflareSetupOperation = {
      ...transaction.operation,
      phase: "queued",
      detail: "Waiting for the trusted host agent",
    };
    this.#writeOperation(queued);
    if (!this.#operationsDirectory) {
      clearTimeout(timer);
      this.#claims.delete(transaction.operation.id);
      await this.#revoke(provisionToken, transaction.clientId).catch(() => undefined);
      return this.#fail(transaction.operation, "Cloudflare setup operations are not configured.");
    }
    writeJsonAtomic(join(
      this.#operationsDirectory,
      `cloudflare-request-${transaction.operation.id}.json`,
    ), {
      schema: "stugu-cloudflare-setup-request/v1",
      ...queued,
      ...transaction.options,
      oauthClientId: transaction.clientId,
      oauthRedirectUri: transaction.redirectUri,
      claimSecret,
    });
    return queued;
  }

  claim(id: string, secret: string): CloudflareSetupClaim | null {
    const pending = this.#claims.get(id);
    if (!pending || pending.expiresAt < this.#now().getTime() || !equalSecret(pending.secret, secret)) return null;
    clearTimeout(pending.timer);
    this.#claims.delete(id);
    return pending.claim;
  }

  async stop(): Promise<void> {
    const revocations = [...this.#claims.values()].map((pending) => {
      clearTimeout(pending.timer);
      return this.#revoke(pending.claim.provisionToken, pending.claim.oauthClientId).catch(() => undefined);
    });
    this.#claims.clear();
    this.#transactions.clear();
    for (const timer of this.#transactionTimers.values()) clearTimeout(timer);
    this.#transactionTimers.clear();
    await Promise.all(revocations);
  }

  #deployment(): ReturnType<typeof deploymentFromJson> {
    return this.#deploymentFile ? deploymentFromJson(boundedJson(this.#deploymentFile)) : null;
  }

  #operation(): CloudflareSetupOperation | null {
    if (!this.#operationsDirectory) return null;
    return operationFromJson(boundedJson(join(this.#operationsDirectory, "cloudflare-status.json")));
  }

  #writeOperation(operation: CloudflareSetupOperation): void {
    if (!this.#operationsDirectory) {
      throw new CloudflareSetupError(503, "CLOUDFLARE_SETUP_NOT_CONFIGURED", "Cloudflare setup operations are not configured");
    }
    writeJsonAtomic(join(this.#operationsDirectory, "cloudflare-status.json"), operation);
  }

  #fail(operation: CloudflareSetupOperation, detail: string): CloudflareSetupOperation {
    const failed: CloudflareSetupOperation = {
      ...operation,
      phase: "failed",
      completedAt: this.#now().toISOString(),
      detail: detail.slice(0, 2_000),
    };
    this.#writeOperation(failed);
    return failed;
  }

  #heartbeat(): {
    available: boolean;
    updatedAt: string | null;
    reason: CloudflareSetupStatus["capability"]["reason"];
  } {
    if (!this.#operationsDirectory) return { available: false, updatedAt: null, reason: "not-configured" };
    const value = boundedJson(join(this.#operationsDirectory, "agent-status.json")) as AgentHeartbeat | null;
    if (
      !value
      || value.schema !== "stugu-update-agent/v1"
      || value.ready !== true
      || typeof value.updatedAt !== "string"
    ) return { available: false, updatedAt: null, reason: "agent-not-connected" };
    const timestamp = Date.parse(value.updatedAt);
    const age = this.#now().getTime() - timestamp;
    if (!Number.isFinite(timestamp) || age > AGENT_MAX_AGE_MS || age < -AGENT_MAX_AGE_MS) {
      return { available: false, updatedAt: null, reason: "agent-not-connected" };
    }
    if (!Array.isArray(value.capabilities) || !value.capabilities.includes("cloudflare-setup")) {
      return { available: false, updatedAt: value.updatedAt, reason: "agent-upgrade-required" };
    }
    return { available: true, updatedAt: value.updatedAt, reason: "ready" };
  }

  async #request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${CLOUDFLARE_API_BASE}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    } catch {
      throw new CloudflareSetupError(502, "CLOUDFLARE_UNAVAILABLE", "Cloudflare could not be reached");
    }
    const text = await boundedText(response);
    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = JSON.parse(text) as CloudflareEnvelope<T>;
    } catch {
      throw new CloudflareSetupError(502, "CLOUDFLARE_INVALID_RESPONSE", "Cloudflare returned an invalid response");
    }
    if (!response.ok || envelope.success !== true || envelope.result === undefined) {
      const providerCode = envelope.errors?.[0]?.code;
      throw new CloudflareSetupError(
        response.status === 403 ? 403 : 502,
        providerCode === undefined ? `CLOUDFLARE_HTTP_${response.status}` : `CLOUDFLARE_${String(providerCode)}`,
        response.status === 403
          ? "Cloudflare rejected the token. Check that it has OAuth Client Write for this account."
          : "Cloudflare rejected OAuth client registration.",
      );
    }
    return envelope.result;
  }

  async #discoverAccount(token: string): Promise<string> {
    const accounts = await this.#request<Array<{ id?: unknown }>>(token, "/accounts?per_page=50");
    if (!Array.isArray(accounts) || accounts.length !== 1) {
      throw new CloudflareSetupError(
        400,
        "CLOUDFLARE_ACCOUNT_REQUIRED",
        "Enter the Cloudflare account ID because the token can access more than one account",
      );
    }
    const accountId = normalizedId(accounts[0]?.id, "Account ID");
    if (!accountId) throw new CloudflareSetupError(502, "CLOUDFLARE_INVALID_RESPONSE", "Cloudflare did not return an account ID");
    return accountId;
  }

  async #createOAuthClient(token: string, accountId: string, hostname: string, redirectUri: string): Promise<string> {
    const result = await this.#request<{ client_id?: unknown }>(
      token,
      `/accounts/${encodeURIComponent(accountId)}/oauth_clients`,
      {
        method: "POST",
        body: JSON.stringify({
          client_name: `Stugu setup (${hostname})`,
          grant_types: ["authorization_code"],
          redirect_uris: [redirectUri],
          response_types: ["code"],
          scopes: ALLOWED_CLIENT_SCOPES,
          token_endpoint_auth_method: "none",
        }),
      },
    );
    const clientId = normalizedClientId(result.client_id);
    if (!clientId) {
      throw new CloudflareSetupError(502, "CLOUDFLARE_INVALID_RESPONSE", "Cloudflare did not return an OAuth client ID");
    }
    return clientId;
  }

  async #exchangeCode(transaction: SetupTransaction, code: string): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(TOKEN_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: transaction.clientId,
          code,
          redirect_uri: transaction.redirectUri,
          code_verifier: transaction.codeVerifier,
        }),
      });
    } catch {
      throw new CloudflareSetupError(502, "OAUTH_EXCHANGE_FAILED", "Cloudflare approval could not be exchanged");
    }
    const text = await boundedText(response);
    let payload: { access_token?: unknown; token_type?: unknown; scope?: unknown };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new CloudflareSetupError(502, "OAUTH_INVALID_RESPONSE", "Cloudflare returned an invalid OAuth response");
    }
    if (!response.ok) {
      throw new CloudflareSetupError(502, "OAUTH_EXCHANGE_FAILED", "Cloudflare approval could not be exchanged");
    }
    const accessToken = normalizedToken(payload.access_token, "Cloudflare approval");
    if (payload.token_type !== undefined && String(payload.token_type).toLowerCase() !== "bearer") {
      throw new CloudflareSetupError(502, "OAUTH_INVALID_RESPONSE", "Cloudflare returned an unsupported approval");
    }
    if (typeof payload.scope === "string") {
      const granted = new Set(payload.scope.split(/\s+/u).filter(Boolean));
      const missing = transaction.scopes.find((scope) => !granted.has(scope));
      if (missing) {
        await this.#revoke(accessToken, transaction.clientId).catch(() => undefined);
        throw new CloudflareSetupError(403, "OAUTH_SCOPE_MISSING", "Cloudflare approval omitted a required permission");
      }
    }
    return accessToken;
  }

  async #revoke(accessToken: string, clientId: string): Promise<void> {
    const response = await this.#fetch(REVOCATION_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        token: accessToken,
        token_type_hint: "access_token",
      }),
    });
    await boundedText(response);
    if (!response.ok) throw new Error("Cloudflare OAuth revocation failed");
  }
}

export const cloudflareSetupCallbackPath = CALLBACK_PATH;
