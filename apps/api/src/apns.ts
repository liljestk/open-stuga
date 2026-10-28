import { createPrivateKey, sign } from "node:crypto";
import { connect, constants, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import type { AppConfig } from "./config.js";

const MAX_APNS_PAYLOAD_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 8_192;
const TOKEN_TTL_MS = 50 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface APNSDestination {
  registrationId: string;
  deviceToken: string;
  environment: "sandbox" | "production";
  includeDetails: boolean;
  canAcknowledge: boolean;
}

export class APNSDeliveryError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

export function apnsConfigured(
  config: Pick<AppConfig, "apnsTeamId" | "apnsKeyId" | "apnsBundleId" | "apnsPrivateKey">,
): boolean {
  return Boolean(config.apnsTeamId && config.apnsKeyId && config.apnsBundleId && config.apnsPrivateKey);
}

function base64url(value: Buffer | string): string {
  return typeof value === "string"
    ? Buffer.from(value, "utf8").toString("base64url")
    : value.toString("base64url");
}

function terminalReason(status: number, reason: string | null): boolean {
  if (reason === "ExpiredProviderToken") return false;
  return status === 410 || (status >= 400 && status < 500 && status !== 429);
}

function validatedPayload(payloadJson: string): { payload: string; silent: boolean } {
  const bytes = Buffer.byteLength(payloadJson, "utf8");
  if (bytes === 0 || bytes > MAX_APNS_PAYLOAD_BYTES) {
    throw new APNSDeliveryError("Queued APNs payload exceeds Apple's 4 KiB limit", true);
  }
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    throw new APNSDeliveryError("Queued APNs payload is invalid JSON", true);
  }
  const root = value as { aps?: { alert?: unknown; sound?: unknown } } | null;
  if (!root?.aps || typeof root.aps.alert !== "object" || root.aps.alert === null) {
    throw new APNSDeliveryError("Queued APNs alert payload is invalid", true);
  }
  return { payload: payloadJson, silent: root.aps.sound === undefined };
}

export interface APNSMessage {
  payloadJson: string;
  signal?: AbortSignal;
  /** UUID sent as apns-id so Apple de-duplicates retries. */
  notificationId?: string;
}

interface APNSRequest {
  deviceToken: string;
  payload: string;
  silent: boolean;
  signal?: AbortSignal | undefined;
  notificationId?: string | undefined;
}

export class APNSService {
  #cachedToken: { value: string; createdAt: number; keyId: string; teamId: string } | null = null;
  readonly #connect: (origin: string) => ClientHttp2Session;

  /** `connectSession` opens the HTTP/2 session to Apple's origin; tests pass a fake. */
  constructor(connectSession: (origin: string) => ClientHttp2Session = connect) {
    this.#connect = connectSession;
  }

  async send(
    config: AppConfig,
    destination: APNSDestination,
    { payloadJson, signal, notificationId }: APNSMessage,
  ): Promise<void> {
    if (!apnsConfigured(config)) {
      throw new APNSDeliveryError("Apple Push Notification service is not configured", false);
    }
    if (!/^[a-f0-9]{64,200}$/u.test(destination.deviceToken)
      || destination.deviceToken.length % 2 !== 0) {
      throw new APNSDeliveryError("Stored APNs device token is invalid", true, "BadDeviceToken");
    }
    if (notificationId && !UUID_PATTERN.test(notificationId)) {
      throw new APNSDeliveryError("Queued APNs notification id is invalid", true);
    }
    const { payload, silent } = validatedPayload(payloadJson);
    const origin = destination.environment === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
    const session = this.#connect(origin);
    try {
      await this.sendRequest(session, config, { deviceToken: destination.deviceToken, payload, silent, signal, notificationId });
    } finally {
      session.close();
    }
  }

  private providerToken(config: AppConfig): string {
    const now = Date.now();
    const teamId = config.apnsTeamId!;
    const keyId = config.apnsKeyId!;
    if (this.#cachedToken
      && this.#cachedToken.teamId === teamId
      && this.#cachedToken.keyId === keyId
      && now - this.#cachedToken.createdAt < TOKEN_TTL_MS) {
      return this.#cachedToken.value;
    }
    const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
    const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1_000) }));
    const signingInput = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(signingInput), {
      key: createPrivateKey(config.apnsPrivateKey!),
      dsaEncoding: "ieee-p1363",
    });
    const value = `${signingInput}.${base64url(signature)}`;
    this.#cachedToken = { value, createdAt: now, keyId, teamId };
    return value;
  }

  private sendRequest(
    session: ClientHttp2Session,
    config: AppConfig,
    { deviceToken, payload, silent, signal, notificationId }: APNSRequest,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let status = 0;
      let responseBody = "";
      let request: ClientHttp2Stream | null = null;
      function finish(error?: Error): void {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      }
      function abort(): void {
        request?.close(constants.NGHTTP2_CANCEL);
        finish(new DOMException("APNs request aborted", "AbortError"));
      }
      session.once("error", (error) => finish(error));
      try {
        request = session.request({
          [constants.HTTP2_HEADER_METHOD]: "POST",
          [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
          authorization: `bearer ${this.providerToken(config)}`,
          "apns-topic": config.apnsBundleId!,
          "apns-push-type": "alert",
          "apns-priority": silent ? "5" : "10",
          "apns-expiration": String(Math.floor(Date.now() / 1_000) + 24 * 60 * 60),
          ...(notificationId ? { "apns-id": notificationId } : {}),
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Could not create the APNs request"));
        return;
      }
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on("data", (chunk: string) => {
        if (responseBody.length < MAX_RESPONSE_BYTES) responseBody += chunk;
      });
      request.on("error", (error) => finish(error));
      request.on("end", () => {
        if (status === 200) {
          finish();
          return;
        }
        let reason: string | null = null;
        try {
          const parsed = JSON.parse(responseBody) as { reason?: unknown };
          reason = typeof parsed.reason === "string" ? parsed.reason : null;
        } catch {
          // HTTP status still controls retry behavior.
        }
        if (reason === "ExpiredProviderToken") this.#cachedToken = null;
        finish(new APNSDeliveryError(
          `APNs returned HTTP ${status}${reason ? ` (${reason})` : ""}`,
          terminalReason(status, reason),
          reason,
        ));
      });
      request.end(payload);
    });
  }
}
