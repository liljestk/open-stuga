import type { ExportJob, JobStatusUpdate } from "./types.js";
import { readBoundedResponseText, ResponseLimitError } from "./bounded-response.js";

export const MAX_JOB_API_RESPONSE_BYTES = 256 * 1024;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class LeaseLostError extends ApiError {
  constructor(responseBody: string) {
    super("The export job lease is no longer owned by this worker", 409, responseBody);
    this.name = "LeaseLostError";
  }
}

export interface JobApiOptions {
  baseUrl: string;
  apiPrefix: string;
  token: string;
  workerId: string;
  deploymentFingerprint: string;
  requestTimeoutMs: number;
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Claim response has invalid ${name}`);
  }
  return value;
}

function assertLeaseExpiry(value: unknown): string {
  const expiry = assertString(value, "leaseExpiresAt");
  if (!Number.isFinite(Date.parse(expiry))) throw new Error("Job API response has invalid leaseExpiresAt");
  return expiry;
}

function assertServerNow(value: unknown): string {
  const serverNow = assertString(value, "serverNow");
  if (!Number.isFinite(Date.parse(serverNow))) throw new Error("Job API response has invalid serverNow");
  return serverNow;
}

function leaseTtlMs(leaseExpiresAt: string, serverNow: string): number {
  const serverTimestamp = Date.parse(serverNow);
  const expiresTimestamp = Date.parse(leaseExpiresAt);
  const ttl = expiresTimestamp - serverTimestamp;
  if (!Number.isFinite(serverTimestamp) || !Number.isFinite(ttl) || ttl <= 0 || ttl > 24 * 60 * 60_000) {
    throw new Error("Job API response has invalid server-relative lease timing");
  }
  return ttl;
}

function parseJob(value: unknown, outerLeaseToken: unknown, serverNow: unknown): ExportJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claim response job must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const attemptCount = candidate.attemptCount;
  if (!Number.isSafeInteger(attemptCount) || (attemptCount as number) < 0) {
    throw new Error("Claim response has invalid attemptCount");
  }
  const intervalMinutes = candidate.intervalMinutes;
  if (!Number.isSafeInteger(intervalMinutes) || (intervalMinutes as number) < 1) {
    throw new Error("Claim response has invalid intervalMinutes");
  }
  const leaseToken = candidate.leaseToken ?? outerLeaseToken;
  const timeZone = assertString(candidate.timeZone, "timeZone");
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw new Error("Claim response has invalid timeZone");
  }
  const leaseExpiresAt = assertLeaseExpiry(candidate.leaseExpiresAt);
  const claimedServerNow = assertServerNow(serverNow);
  const parsed: ExportJob = {
    id: assertString(candidate.id, "id"),
    sensorId: assertString(candidate.sensorId, "sensorId"),
    deviceId: assertString(candidate.deviceId, "deviceId"),
    deviceName: assertString(candidate.deviceName, "deviceName"),
    metric: assertString(candidate.metric, "metric"),
    from: assertString(candidate.from, "from"),
    to: assertString(candidate.to, "to"),
    timeZone,
    intervalMinutes: intervalMinutes as number,
    expectedRecipient: assertString(candidate.expectedRecipient, "expectedRecipient"),
    status: assertString(candidate.status, "status"),
    attemptCount: attemptCount as number,
    leaseToken: assertString(leaseToken, "leaseToken"),
    leaseExpiresAt,
    serverNow: claimedServerNow,
    leaseTtlMs: leaseTtlMs(leaseExpiresAt, claimedServerNow),
  };
  return parsed;
}

export class JobApiClient {
  private readonly prefixUrl: string;

  constructor(private readonly options: JobApiOptions) {
    if (!/^[a-f0-9]{64}$/u.test(options.deploymentFingerprint)) {
      throw new Error("Job API deployment fingerprint must be 64 lowercase hexadecimal characters");
    }
    this.prefixUrl = `${options.baseUrl.replace(/\/$/u, "")}${options.apiPrefix}`;
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ response: Response; responseText: string }> {
    const response = await fetch(`${this.prefixUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "x-stuga-worker-id": this.options.workerId,
        "x-tapo-deployment-fingerprint": this.options.deploymentFingerprint,
        ...init.headers,
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)])
        : AbortSignal.timeout(this.options.requestTimeoutMs),
    });
    let responseText: string;
    try {
      responseText = await readBoundedResponseText(response, MAX_JOB_API_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ResponseLimitError) {
        throw new Error(`Internal job API response exceeded ${MAX_JOB_API_RESPONSE_BYTES} bytes`);
      }
      throw error;
    }
    if (!response.ok) {
      const body = responseText.slice(0, 2_000);
      if (response.status === 409) throw new LeaseLostError(body);
      throw new ApiError(`Internal job API returned HTTP ${response.status}`, response.status, body);
    }
    return { response, responseText };
  }

  private parseJson(responseText: string, name: string): unknown {
    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      throw new Error(`${name} must contain valid bounded JSON`);
    }
  }

  async claim(): Promise<ExportJob | null> {
    const worker = encodeURIComponent(this.options.workerId);
    const fingerprint = encodeURIComponent(this.options.deploymentFingerprint);
    const { response, responseText } = await this.request(
      `/jobs/claim?workerId=${worker}&deploymentFingerprint=${fingerprint}`,
      { method: "GET" },
    );
    if (response.status === 204) return null;
    const body = this.parseJson(responseText, "Claim response");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Claim response must be an object");
    }
    const parsedBody = body as Record<string, unknown>;
    const job = parsedBody.job ?? parsedBody;
    if (job === null || job === undefined) return null;
    return parseJob(job, parsedBody.leaseToken, parsedBody.serverNow);
  }

  async heartbeat(job: ExportJob, signal?: AbortSignal): Promise<{ leaseExpiresAt: string; leaseTtlMs: number }> {
    const { responseText } = await this.request(`/jobs/${encodeURIComponent(job.id)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({
        workerId: this.options.workerId,
        leaseToken: job.leaseToken,
      }),
    }, signal);
    const body = this.parseJson(responseText, "Heartbeat response");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Heartbeat response must contain the renewed job lease");
    }
    const record = body as Record<string, unknown>;
    const jobRecord = record.job && typeof record.job === "object" && !Array.isArray(record.job)
      ? record.job as Record<string, unknown>
      : record;
    const leaseExpiresAt = assertLeaseExpiry(jobRecord.leaseExpiresAt);
    return { leaseExpiresAt, leaseTtlMs: leaseTtlMs(leaseExpiresAt, assertServerNow(record.serverNow)) };
  }

  async updateStatus(job: ExportJob, update: JobStatusUpdate, signal?: AbortSignal): Promise<void> {
    await this.request(`/jobs/${encodeURIComponent(job.id)}/status`, {
      method: "POST",
      body: JSON.stringify({
        workerId: this.options.workerId,
        leaseToken: job.leaseToken,
        status: update.status,
        ...(update.detail === undefined ? {} : { detail: update.detail }),
      }),
    }, signal);
  }
}
