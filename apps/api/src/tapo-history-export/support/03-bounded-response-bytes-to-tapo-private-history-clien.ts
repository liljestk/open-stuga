import { MAX_CSV_BYTES, MAX_GMAIL_CANDIDATE_ATTACHMENTS, MAX_GMAIL_CANDIDATE_BYTES, MAX_GMAIL_MESSAGES_PER_PAGE, MAX_GMAIL_MESSAGE_BYTES, MAX_GMAIL_PAGES, MAX_GMAIL_SEARCH_MS, MAX_GMAIL_SEARCH_REQUESTS, MAX_GMAIL_SEARCH_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } from "./01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { GmailMessage, GmailPart, base64UrlBytes, gmailHeader, gmailParts } from "./02-finite-csv-number-to-gmail-header.js";

export async function boundedResponseBytes(
  response: Response,
  limit: number,
  controller?: AbortController,
  charge?: (bytes: number) => void,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    controller?.abort();
    throw new Error("Remote response exceeds the allowed size");
  }
  if (!response.body) throw new Error("Remote service returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      charge?.(next.value.byteLength);
      total += next.value.byteLength;
      if (total > limit) {
        controller?.abort();
        await reader.cancel().catch(() => undefined);
        throw new Error("Remote response exceeds the allowed size");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    controller?.abort();
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function boundedResponseJson(
  response: Response,
  limit = 2 * 1024 * 1024,
  controller?: AbortController,
): Promise<unknown> {
  const bytes = await boundedResponseBytes(response, limit, controller);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Error("Remote service returned invalid JSON"); }
}

export interface GmailTapoMailboxOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Exact primary account identity expected from Gmail /users/me/profile. */
  expectedEmail: string;
  fetcher?: typeof fetch;
  tokenEndpoint?: string;
  apiBaseUrl?: string;
}

export interface GmailCsvSearchResult {
  attachments: Array<{ messageId: string; filename: string; bytes: Uint8Array }>;
  /** Matching messages/attachments rejected locally as malformed or oversized. */
  rejectedCandidates: number;
  /** Per-message Gmail fetch failures; these remain retryable and do not poison the scan. */
  transientFailures: number;
}

export function mailboxContentRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("exceeds the allowed size")
    || message.includes("invalid attachment encoding")
    || message.includes("MIME tree exceeds the allowed complexity");
}

export class GmailSearchBudgetExceeded extends Error {}

export class GmailAuthenticationUnavailable extends Error {}

export class GmailHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface GmailSearchBudget {
  deadlineAt: number;
  requests: number;
  responseBytes: number;
}

export function gmailSearchBudget(deadlineAt = Date.now() + MAX_GMAIL_SEARCH_MS): GmailSearchBudget {
  return {
    deadlineAt: Math.min(deadlineAt, Date.now() + MAX_GMAIL_SEARCH_MS),
    requests: 0,
    responseBytes: 0,
  };
}

/** Minimal Gmail REST client: no mailbox password and no IMAP surface. */
export class GmailTapoMailbox {
  readonly #fetcher: typeof fetch;
  readonly #tokenEndpoint: string;
  readonly #apiBaseUrl: string;
  #accessToken: { value: string; expiresAt: number } | null = null;
  #identityVerifiedForToken: string | null = null;

  constructor(private readonly options: GmailTapoMailboxOptions) {
    if (!/^[^\s@<>]+@[^\s@<>]+$/u.test(options.expectedEmail.trim())) {
      throw new Error("Expected Gmail account identity must be a valid email address");
    }
    this.#fetcher = options.fetcher ?? fetch;
    this.#tokenEndpoint = options.tokenEndpoint ?? "https://oauth2.googleapis.com/token";
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://gmail.googleapis.com/gmail/v1").replace(/\/$/, "");
  }

  async findCsv(
    expectedRecipient: string,
    seenMessageIds: ReadonlySet<string>,
    notBefore?: string,
    budget = gmailSearchBudget(),
  ): Promise<GmailCsvSearchResult> {
    const token = await this.accessToken(budget);
    await this.verifyIdentity(token, budget);
    const results: Array<{ messageId: string; filename: string; bytes: Uint8Array }> = [];
    let candidateBytes = 0;
    let rejectedCandidates = 0;
    let transientFailures = 0;
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_GMAIL_PAGES; page += 1) {
      const endpoint = new URL(`${this.#apiBaseUrl}/users/me/messages`);
      const minimumMs = notBefore ? Date.parse(notBefore) : Date.now() - 30 * 24 * 60 * 60_000;
      if (!Number.isFinite(minimumMs)) throw new Error("Tapo mailbox correlation time is invalid");
      endpoint.searchParams.set("q", `to:${expectedRecipient} has:attachment filename:csv after:${Math.floor((minimumMs - 300_000) / 1_000)}`);
      endpoint.searchParams.set("maxResults", String(MAX_GMAIL_MESSAGES_PER_PAGE));
      if (pageToken) endpoint.searchParams.set("pageToken", pageToken);
      const listed = await this.requestJson(endpoint, token, 2 * 1024 * 1024, budget) as { messages?: unknown; nextPageToken?: unknown };
      const messages = Array.isArray(listed.messages) ? listed.messages : [];
      for (const item of messages) {
        const messageId = item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id : null;
        if (!messageId || seenMessageIds.has(messageId)) continue;
        let message: GmailMessage;
        try {
          message = await this.requestJson(
            `${this.#apiBaseUrl}/users/me/messages/${encodeURIComponent(messageId)}?format=full`, token, MAX_GMAIL_MESSAGE_BYTES, budget,
          ) as GmailMessage;
        } catch (error) {
          if (error instanceof GmailSearchBudgetExceeded) throw error;
          if (mailboxContentRejected(error)) rejectedCandidates += 1;
          else transientFailures += 1;
          continue;
        }
        const recipientHeaders = ["to", "delivered-to", "x-original-to"]
          .map((name) => gmailHeader(message.payload, name)).join(",");
        const recipients: string[] = [...(recipientHeaders.toLowerCase()
          .match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) ?? [])];
        const internalDate = typeof message.internalDate === "string" ? Number(message.internalDate) : NaN;
        if (message.id !== messageId || !recipients.includes(expectedRecipient.toLowerCase())
          || !Number.isFinite(internalDate) || internalDate < minimumMs - 300_000 || internalDate > Date.now() + 300_000) continue;
        let parts: GmailPart[];
        try { parts = gmailParts(message.payload); }
        catch (error) {
          if (mailboxContentRejected(error)) rejectedCandidates += 1;
          else transientFailures += 1;
          continue;
        }
        for (const part of parts) {
          const filename = typeof part.filename === "string" ? part.filename.trim() : "";
          if (!filename.toLowerCase().endsWith(".csv")) continue;
          try {
            const size = Number(part.body?.size);
            if (Number.isFinite(size) && size > MAX_CSV_BYTES) throw new Error("oversized attachment");
            let bytes: Uint8Array;
            if (typeof part.body?.data === "string") bytes = base64UrlBytes(part.body.data);
            else if (typeof part.body?.attachmentId === "string") {
              let attachment: { data?: unknown; size?: unknown };
              try {
                attachment = await this.requestJson(
                  `${this.#apiBaseUrl}/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
                  token,
                  MAX_GMAIL_MESSAGE_BYTES,
                  budget,
                ) as { data?: unknown; size?: unknown };
              } catch (error) {
                if (error instanceof GmailSearchBudgetExceeded) throw error;
                if (mailboxContentRejected(error)) rejectedCandidates += 1;
                else transientFailures += 1;
                continue;
              }
              if (typeof attachment.data !== "string") throw new Error("missing attachment body");
              bytes = base64UrlBytes(attachment.data);
            } else {
              rejectedCandidates += 1;
              continue;
            }
            if (bytes.byteLength > MAX_CSV_BYTES) throw new Error("oversized attachment");
            if (results.length >= MAX_GMAIL_CANDIDATE_ATTACHMENTS
              || candidateBytes + bytes.byteLength > MAX_GMAIL_CANDIDATE_BYTES) {
              rejectedCandidates += 1;
              continue;
            }
            results.push({ messageId, filename, bytes });
            candidateBytes += bytes.byteLength;
            if (results.length >= MAX_GMAIL_CANDIDATE_ATTACHMENTS
              || candidateBytes >= MAX_GMAIL_CANDIDATE_BYTES) {
              return { attachments: results, rejectedCandidates, transientFailures };
            }
          } catch (error) {
            if (error instanceof GmailSearchBudgetExceeded) throw error;
            rejectedCandidates += 1;
          }
        }
      }
      pageToken = typeof listed.nextPageToken === "string" ? listed.nextPageToken : null;
      if (!pageToken) break;
    }
    return { attachments: results, rejectedCandidates, transientFailures };
  }

  async accessToken(budget?: GmailSearchBudget): Promise<string> {
    if (this.#accessToken && this.#accessToken.expiresAt > Date.now() + 60_000) return this.#accessToken.value;
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: this.options.refreshToken,
      grant_type: "refresh_token",
    });
    let value: { access_token?: unknown; expires_in?: unknown };
    try {
      value = await this.requestJsonWithInit(this.#tokenEndpoint, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, redirect: "error",
      }, 2 * 1024 * 1024, "Gmail OAuth refresh", budget) as { access_token?: unknown; expires_in?: unknown };
    } catch (error) {
      if (error instanceof GmailSearchBudgetExceeded) throw error;
      throw new GmailAuthenticationUnavailable("Gmail OAuth refresh is unavailable");
    }
    if (typeof value.access_token !== "string" || !value.access_token) {
      throw new GmailAuthenticationUnavailable("Gmail OAuth response omitted access_token");
    }
    const expiresIn = Number(value.expires_in);
    this.#accessToken = { value: value.access_token, expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3_600) * 1_000 };
    this.#identityVerifiedForToken = null;
    return value.access_token;
  }

  private async verifyIdentity(token: string, budget?: GmailSearchBudget): Promise<void> {
    if (this.#identityVerifiedForToken === token) return;
    let profile: { emailAddress?: unknown };
    try {
      profile = await this.requestJson(
        `${this.#apiBaseUrl}/users/me/profile`, token, 64 * 1024, budget,
      ) as { emailAddress?: unknown };
    } catch (error) {
      if (error instanceof GmailSearchBudgetExceeded || error instanceof GmailAuthenticationUnavailable) throw error;
      throw new GmailAuthenticationUnavailable("Gmail mailbox identity could not be verified");
    }
    const actual = typeof profile.emailAddress === "string" ? profile.emailAddress.trim().toLowerCase() : "";
    if (actual !== this.options.expectedEmail.trim().toLowerCase()) {
      this.#accessToken = null;
      this.#identityVerifiedForToken = null;
      throw new GmailAuthenticationUnavailable("Gmail OAuth token belongs to a different mailbox");
    }
    this.#identityVerifiedForToken = token;
  }

  private requestJson(
    endpoint: string | URL,
    token: string,
    limit = 2 * 1024 * 1024,
    budget?: GmailSearchBudget,
  ): Promise<unknown> {
    return this.requestJsonWithInit(endpoint, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error",
    }, limit, "Gmail API", budget).catch((error: unknown) => {
      if (error instanceof GmailHttpError && error.status === 401) {
        this.#accessToken = null;
        this.#identityVerifiedForToken = null;
        throw new GmailAuthenticationUnavailable("Gmail rejected the cached OAuth access token");
      }
      throw error;
    });
  }

  private async requestJsonWithInit(
    endpoint: string | URL,
    init: RequestInit,
    limit: number,
    label: string,
    budget?: GmailSearchBudget,
  ): Promise<unknown> {
    if (budget && (budget.requests >= MAX_GMAIL_SEARCH_REQUESTS
      || budget.responseBytes >= MAX_GMAIL_SEARCH_RESPONSE_BYTES
      || Date.now() >= budget.deadlineAt)) {
      throw new GmailSearchBudgetExceeded("Gmail search exceeded its bounded request, byte, or time budget");
    }
    if (budget) budget.requests += 1;
    const controller = new AbortController();
    const remainingMs = budget ? Math.max(1, budget.deadlineAt - Date.now()) : REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingMs));
    timer.unref();
    try {
      const response = await this.#fetcher(endpoint, { ...init, signal: controller.signal });
      if (!response.ok) {
        controller.abort();
        await response.body?.cancel().catch(() => undefined);
        throw new GmailHttpError(response.status, `${label} returned HTTP ${response.status}`);
      }
      if (!budget) return await boundedResponseJson(response, limit, controller);
      const remainingBytes = MAX_GMAIL_SEARCH_RESPONSE_BYTES - budget.responseBytes;
      if (remainingBytes <= 0) throw new GmailSearchBudgetExceeded("Gmail search exceeded its response-byte budget");
      let bytes: Uint8Array;
      try {
        bytes = await boundedResponseBytes(response, Math.min(limit, remainingBytes), controller, (count) => {
          if (count > MAX_GMAIL_SEARCH_RESPONSE_BYTES - budget.responseBytes) {
            budget.responseBytes = MAX_GMAIL_SEARCH_RESPONSE_BYTES;
            throw new GmailSearchBudgetExceeded("Gmail search exceeded its response-byte budget");
          }
          budget.responseBytes += count;
        });
      }
      catch (error) {
        if (error instanceof GmailSearchBudgetExceeded) throw error;
        if (remainingBytes < limit) throw new GmailSearchBudgetExceeded("Gmail search exceeded its response-byte budget");
        throw error;
      }
      try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
      catch { throw new Error("Remote service returned invalid JSON"); }
    }
    catch (error) {
      if (budget && Date.now() >= budget.deadlineAt) {
        throw new GmailSearchBudgetExceeded("Gmail search exceeded its time budget");
      }
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new Error(`${label} request timed out`);
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
}

export interface TapoPrivateHistoryClientOptions {
  endpoint: string;
  token: string;
  fetcher?: typeof fetch;
  resolver?: (hostname: string) => Promise<readonly string[]>;
}
