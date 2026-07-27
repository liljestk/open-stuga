import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MeasurementSample } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type {
  ClimateDatabase,
  SensorDataGapRecord,
  TapoHistoryExportClaim,
  TapoHistoryExportJob,
  TapoHistoryExportJobStatus,
  TapoHistoryExportProvider,
  TapoHistoryExportStagedSample,
  TapoHistoryExportStagedSampleInput,
} from "../../db.js";
import type { SensorHistoryRecoveryResult } from "../../sensor-gap-recovery.js";
import { MAX_TAPO_HISTORY_DATA_ROWS_PER_JOB, REQUEST_TIMEOUT_MS, TapoHistoryFormatError } from "./01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { TapoPrivateHistoryClientOptions, boundedResponseJson } from "./03-bounded-response-bytes-to-tapo-private-history-clien.js";

export interface PrivateHistoryPayload {
  deviceId?: unknown;
  state?: unknown;
  rangeStart?: unknown;
  rangeEnd?: unknown;
  samples?: unknown;
}

export const PRIVATE_ENDPOINT_RESERVED_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE_ENDPOINT_RESERVED_ADDRESSES.addSubnet(network, prefix, "ipv4");

for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001:2::", 48],
  ["2001:10::", 28], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) PRIVATE_ENDPOINT_RESERVED_ADDRESSES.addSubnet(network, prefix, "ipv6");

export function normalizedEndpointHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isPublicEndpointAddress(value: string): boolean {
  const address = normalizedEndpointHost(value);
  // Block IPv4-mapped IPv6 input outright. Node's BlockList maps IPv4 checks
  // into this range internally, so adding the /96 subnet would also block all
  // ordinary public IPv4 addresses.
  if (address.startsWith("::ffff:")) return false;
  const family = isIP(address);
  return family > 0 && !PRIVATE_ENDPOINT_RESERVED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function validatePrivateEndpoint(value: string): string {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("TAPO_HISTORY_PRIVATE_ENDPOINT must be a valid URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !endpoint.hostname) {
    throw new Error("TAPO_HISTORY_PRIVATE_ENDPOINT must use HTTPS without embedded credentials");
  }
  const hostname = normalizedEndpointHost(endpoint.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname.endsWith(".internal") || hostname === "home.arpa" || hostname.endsWith(".home.arpa")
    || isIP(hostname) > 0) {
    throw new Error("TAPO_HISTORY_PRIVATE_ENDPOINT may not target a private or reserved network");
  }
  return endpoint.toString();
}

export async function withAbortDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Explicitly configured adapter for a reverse-engineered endpoint; disabled unless endpoint and token are supplied. */
export class TapoPrivateHistoryClient {
  readonly #endpoint: URL;
  readonly #fetcher: typeof fetch | null;
  readonly #resolver: (hostname: string) => Promise<readonly string[]>;
  constructor(private readonly options: TapoPrivateHistoryClientOptions) {
    this.#endpoint = new URL(validatePrivateEndpoint(options.endpoint));
    // An injected fetcher is retained for deterministic tests/embedders. The
    // production path below pins the vetted DNS answer through node:https.
    this.#fetcher = options.fetcher ?? null;
    this.#resolver = options.resolver ?? (async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address));
  }

  async fetch(deviceId: string, sensorId: string, from: string, to: string): Promise<MeasurementSample[]> {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const hostname = normalizedEndpointHost(this.#endpoint.hostname);
      const addresses = isIP(hostname) > 0
        ? [hostname]
        : await withAbortDeadline(Promise.resolve(this.#resolver(hostname)), deadline);
      if (addresses.length === 0 || addresses.some((address) => !isPublicEndpointAddress(address))) {
        throw new Error("Experimental Tapo history endpoint resolved to a private or reserved network");
      }
      const body = JSON.stringify({ deviceId, from, to });
      const payload = (this.#fetcher
        ? await this.fetchInjected(body, deadline)
        : await this.fetchPinned(addresses[0]!, body, deadline)) as PrivateHistoryPayload;
      if (payload.deviceId !== deviceId || !Array.isArray(payload.samples)) {
        throw new Error("Experimental Tapo history response did not echo the requested device identity");
      }
      const coverageStart = typeof payload.rangeStart === "string" ? Date.parse(payload.rangeStart) : NaN;
      const coverageEnd = typeof payload.rangeEnd === "string" ? Date.parse(payload.rangeEnd) : NaN;
      if (payload.state !== "complete" || !Number.isFinite(coverageStart) || !Number.isFinite(coverageEnd)
        || coverageStart > Date.parse(from) || coverageEnd < Date.parse(to)) {
        throw new Error("Experimental Tapo history response did not prove complete requested-range coverage");
      }
      if (payload.samples.length > MAX_TAPO_HISTORY_DATA_ROWS_PER_JOB) {
        throw new Error("Experimental Tapo history response contains too many rows for one bounded job");
      }
      const result: MeasurementSample[] = [];
      for (const candidate of payload.samples) {
        if (!candidate || typeof candidate !== "object") continue;
        const row = candidate as Record<string, unknown>;
        const timestampMs = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
        if (!Number.isFinite(timestampMs) || timestampMs < Date.parse(from) || timestampMs > Date.parse(to)) continue;
        for (const [metric, unit, min, max] of [["temperature", "\u00b0C", -100, 200], ["humidity", "%", 0, 100], ["power", "W", 0, 1_000_000]] as const) {
          const value = row[metric];
          if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) continue;
          // This compatibility endpoint is reverse-engineered history, not a
          // trusted direct/live observation. It must never satisfy a canary's
          // independent-reference requirement.
          result.push({ sensorId, metric, value, canonicalUnit: unit, timestamp: new Date(timestampMs).toISOString(), source: "tp-link", quality: "estimated" });
        }
      }
      return result;
    } catch (error) {
      if (deadline.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
        throw new Error("Experimental Tapo history request timed out");
      }
      throw error;
    }
  }

  private async fetchInjected(body: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.#fetcher!(this.#endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", accept: "application/json" },
      body,
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error(`Experimental Tapo history endpoint returned HTTP ${response.status}`);
    return await withAbortDeadline(boundedResponseJson(response, 8 * 1024 * 1024), signal);
  }

  /** HTTPS transport with the validated DNS answer pinned while TLS verifies the configured hostname. */
  private fetchPinned(address: string, body: string, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callback();
      };
      const request = httpsRequest({
        protocol: "https:",
        hostname: address,
        port: this.#endpoint.port || 443,
        servername: this.#endpoint.hostname,
        method: "POST",
        path: `${this.#endpoint.pathname}${this.#endpoint.search}`,
        headers: {
          host: this.#endpoint.host,
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(body),
        },
        signal,
      }, (response) => {
        const status = response.statusCode ?? 502;
        if (status < 200 || status >= 300) {
          response.destroy();
          finish(() => reject(new Error(`Experimental Tapo history endpoint returned HTTP ${status}`)));
          return;
        }
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > 8 * 1024 * 1024) {
          request.destroy();
          finish(() => reject(new Error("Remote response exceeds the allowed size")));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > 8 * 1024 * 1024) {
            const error = new Error("Remote response exceeds the allowed size");
            response.destroy(error);
            request.destroy(error);
            finish(() => reject(error));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          try { finish(() => resolve(JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown)); }
          catch { finish(() => reject(new Error("Remote service returned invalid JSON"))); }
        });
        response.once("error", (error) => finish(() => reject(error)));
      });
      request.once("error", (error) => finish(() => reject(error)));
      request.end(body);
    });
  }
}

export interface TapoHistoryServiceOptions {
  fetcher?: typeof fetch;
  onHistoryReady?: (job: TapoHistoryExportJob) => void;
  now?: () => Date;
  /** Returns the exact, unique alias visible in the Tapo app for this immutable device id. */
  deviceNameFor?: (sensorId: string, deviceId: string) => string | null;
  /** Deterministic DNS hook for the explicitly configured private adapter. */
  privateResolver?: (hostname: string) => Promise<readonly string[]>;
}

export interface TapoWorkerStatusUpdate {
  status: Extract<TapoHistoryExportJobStatus, "running" | "waiting-email" | "needs-attention" | "failed">;
  detail?: string | null;
}

export interface TapoHistoryMailboxHealth {
  lastSuccessfulPollAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  budgetExhaustions: number;
}

export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Tapo history operation failed").slice(0, 1_000);
}

/** Largest inclusive interval range whose two climate series fit one atomic staged job. */
export function maxTapoHistoryJobSpanMs(intervalMinutes: number, maximumExportDays = 30): number {
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new TapoHistoryFormatError("Tapo history interval must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumExportDays) || maximumExportDays < 1 || maximumExportDays > 730) {
    throw new TapoHistoryFormatError("Tapo history maximum export days must be an integer from 1 through 730");
  }
  const rowBound = (MAX_TAPO_HISTORY_DATA_ROWS_PER_JOB - 1) * intervalMinutes * 60_000;
  // Public reports have truncated multi-month requests to roughly 30 days in
  // practice. Keep that separately configurable while retaining row/2y caps.
  return Math.min(rowBound, maximumExportDays * 24 * 60 * 60_000, 730 * 24 * 60 * 60_000);
}

export function recoveryKey(sensorId: string, metric: string, from: string, to: string): string {
  return `${sensorId}\u0000${metric}\u0000${new Date(from).toISOString()}\u0000${new Date(to).toISOString()}`;
}

export function stageMeasurement(sample: MeasurementSample, identityPrefix: string): TapoHistoryExportStagedSampleInput {
  return {
    metric: sample.metric,
    timestamp: sample.timestamp,
    value: sample.value,
    canonicalUnit: sample.canonicalUnit,
    source: "tp-link",
    quality: sample.quality,
    sourceIdentity: createHash("sha256")
      .update(`${identityPrefix}\u0000${sample.metric}\u0000${sample.timestamp}`)
      .digest("hex"),
  };
}

export function stagedMeasurement(sample: TapoHistoryExportStagedSample): MeasurementSample {
  return {
    sensorId: sample.sensorId,
    metric: sample.metric,
    timestamp: sample.timestamp,
    value: sample.value,
    canonicalUnit: sample.canonicalUnit,
    source: "tp-link",
    quality: sample.quality,
  };
}
