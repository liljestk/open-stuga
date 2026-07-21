const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface CloudflareAccessGroupConfig {
  accountId: string;
  groupId: string;
  groupName: string;
  apiToken: string;
  syncIntervalMs: number;
}

export interface CloudflareAccessSyncStatus {
  status: "pending" | "synced";
  lastSyncedAt: string | null;
  lastFailureAt: string | null;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number | string }>;
}

interface CloudflareAccessGroup {
  id?: string;
  name?: string;
  include?: unknown[];
  exclude?: unknown[];
  require?: unknown[];
}

export class CloudflareAccessSyncError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CloudflareAccessSyncError";
  }
}

function exactEmailRule(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== "email") return null;
  const emailRule = entries[0][1];
  if (!emailRule || typeof emailRule !== "object" || Array.isArray(emailRule)) return null;
  const emailEntries = Object.entries(emailRule);
  if (emailEntries.length !== 1 || emailEntries[0]?.[0] !== "email" || typeof emailEntries[0][1] !== "string") {
    return null;
  }
  return emailEntries[0][1].trim().toLowerCase();
}

function normalizedEmails(values: readonly string[]): string[] {
  const emails = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
  if (emails.length === 0) {
    throw new CloudflareAccessSyncError("EMPTY_GROUP", "The managed Access group must retain at least one account");
  }
  for (const email of emails) {
    if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+$/.test(email)) {
      throw new CloudflareAccessSyncError("INVALID_EMAIL", "The local account list contains an invalid email address");
    }
  }
  return emails;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class CloudflareAccessGroupSynchronizer {
  readonly config: CloudflareAccessGroupConfig;
  readonly #emails: () => readonly string[] | null;
  readonly #fetch: typeof fetch;
  readonly #onError: () => void;
  #timer: ReturnType<typeof setInterval> | null = null;
  #queue: Promise<void> = Promise.resolve();
  #status: CloudflareAccessSyncStatus = { status: "pending", lastSyncedAt: null, lastFailureAt: null };

  constructor(
    config: CloudflareAccessGroupConfig,
    emails: () => readonly string[] | null,
    fetchImpl: typeof fetch = fetch,
    onError: () => void = () => undefined,
  ) {
    this.config = config;
    this.#emails = emails;
    this.#fetch = fetchImpl;
    this.#onError = onError;
  }

  status(): CloudflareAccessSyncStatus {
    return { ...this.#status };
  }

  start(): void {
    if (this.#timer) return;
    void this.synchronize().catch(() => this.#onError());
    this.#timer = setInterval(() => {
      void this.synchronize().catch(() => this.#onError());
    }, this.config.syncIntervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#queue;
  }

  synchronize(): Promise<CloudflareAccessSyncStatus> {
    const operation = this.#queue.then(() => this.#synchronizeOnce());
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #synchronizeOnce(): Promise<CloudflareAccessSyncStatus> {
    const localEmails = this.#emails();
    // A pristine installation has no owner yet. Never erase the bootstrap
    // allowlist while first-owner setup is still pending.
    if (localEmails === null) return this.status();
    const desiredEmails = normalizedEmails(localEmails);
    try {
      const group = await this.#request<CloudflareAccessGroup>(
        `/accounts/${encodeURIComponent(this.config.accountId)}/access/groups/${encodeURIComponent(this.config.groupId)}`,
      );
      if (group.id !== this.config.groupId || group.name !== this.config.groupName) {
        throw new CloudflareAccessSyncError(
          "GROUP_IDENTITY_MISMATCH",
          "The configured Cloudflare Access group does not match Stuga's managed group",
        );
      }
      if ((group.exclude?.length ?? 0) > 0 || (group.require?.length ?? 0) > 0) {
        throw new CloudflareAccessSyncError(
          "UNMANAGED_GROUP_RULES",
          "The managed Cloudflare Access group contains unsupported Require or Exclude rules",
        );
      }
      const currentEmails = (group.include ?? []).map(exactEmailRule);
      if (currentEmails.some((email) => email === null)) {
        throw new CloudflareAccessSyncError(
          "UNMANAGED_GROUP_RULES",
          "The managed Cloudflare Access group contains a rule Stuga does not own",
        );
      }
      const normalizedCurrent = [...new Set(currentEmails as string[])].sort();
      if (!sameStrings(normalizedCurrent, desiredEmails)) {
        await this.#request<CloudflareAccessGroup>(
          `/accounts/${encodeURIComponent(this.config.accountId)}/access/groups/${encodeURIComponent(this.config.groupId)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              name: this.config.groupName,
              include: desiredEmails.map((email) => ({ email: { email } })),
              exclude: [],
              require: [],
            }),
          },
        );
      }
      this.#status = { status: "synced", lastSyncedAt: new Date().toISOString(), lastFailureAt: null };
      return this.status();
    } catch (error) {
      this.#status = { ...this.#status, status: "pending", lastFailureAt: new Date().toISOString() };
      throw error;
    }
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${CLOUDFLARE_API_BASE}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.config.apiToken}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    } catch {
      throw new CloudflareAccessSyncError("REQUEST_FAILED", "Cloudflare Access could not be reached");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new CloudflareAccessSyncError("RESPONSE_TOO_LARGE", "Cloudflare returned an oversized response");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new CloudflareAccessSyncError("RESPONSE_TOO_LARGE", "Cloudflare returned an oversized response");
    }
    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = JSON.parse(text) as CloudflareEnvelope<T>;
    } catch {
      throw new CloudflareAccessSyncError("INVALID_RESPONSE", "Cloudflare returned an invalid response");
    }
    if (!response.ok || envelope.success !== true || envelope.result === undefined) {
      const providerCode = envelope.errors?.[0]?.code;
      throw new CloudflareAccessSyncError(
        providerCode === undefined ? `HTTP_${response.status}` : `CF_${String(providerCode)}`,
        "Cloudflare rejected the Access group synchronization",
      );
    }
    return envelope.result;
  }
}
