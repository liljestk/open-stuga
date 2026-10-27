import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ACTIVE_PHASES, AGENT_MAX_AGE_MS, ALLOWED_CLIENT_SCOPES, AgentHeartbeat, BASE_SCOPES, CLOUDFLARE_API_BASE, CloudflareEnvelope, CloudflareSetupClaim, CloudflareSetupError, CloudflareSetupMode, CloudflareSetupOperation, CloudflareSetupServiceOptions, CloudflareSetupStartInput, CloudflareSetupStartResult, CloudflareSetupStatus, PendingClaim, REVOCATION_ENDPOINT, SetupTransaction, TOKEN_ENDPOINT, TRANSACTION_MAX_AGE_MS, authorizationUrl, base64Url, boundedJson, boundedText, deploymentFromJson, equalSecret, knownId, normalizedClientId, normalizedEmail, normalizedHostname, normalizedId, normalizedToken, operationFromJson, suggestedZone, validateCloudflareUiRedirectUri, writeJsonAtomic } from "./01-cloudflare-api-base-to-bounded-text.js";

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
