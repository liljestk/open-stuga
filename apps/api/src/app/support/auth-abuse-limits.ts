import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { AppConfig } from "../../config.js";
import { HttpError } from "../../http-error.js";
import { trustedProxyClientAddress } from "./trusted-network.js";

export interface AuthAttemptBucket {
  attempts: number;
  active: number;
  resetAt: number;
}

export interface AuthAttemptLimit {
  key: string;
  maxAttempts: number;
  maxActive: number;
}

export class AuthAbuseLimiter {
  readonly #buckets = new Map<string, AuthAttemptBucket>();
  #active = 0;

  enter(limits: readonly AuthAttemptLimit[], response: Response): (forgiveAttempt?: boolean) => void {
    const now = Date.now();
    this.prune(now);
    const uniqueLimits = [...new Map(limits.map((limit) => [limit.key, limit])).values()];
    const entries = uniqueLimits.map((limit) => {
      let bucket = this.#buckets.get(limit.key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { attempts: 0, active: 0, resetAt: now + 60_000 };
        this.#buckets.set(limit.key, bucket);
      }
      return { bucket, limit };
    });
    const limited = entries.find(({ bucket, limit }) => (
      bucket.attempts >= limit.maxAttempts || bucket.active >= limit.maxActive
    ));
    if (limited || this.#active >= 4) {
      const retrySeconds = limited && limited.bucket.attempts >= limited.limit.maxAttempts
        ? Math.max(1, Math.ceil((limited.bucket.resetAt - now) / 1_000))
        : 1;
      response.setHeader("retry-after", String(retrySeconds));
      throw new HttpError(429, "AUTH_RATE_LIMITED", "Too many authentication attempts; try again later");
    }
    for (const { bucket } of entries) {
      bucket.attempts += 1;
      bucket.active += 1;
    }
    this.#active += 1;
    let released = false;
    return (forgiveAttempt = false) => {
      if (released) return;
      released = true;
      for (const { bucket } of entries) {
        bucket.active = Math.max(0, bucket.active - 1);
        if (forgiveAttempt) bucket.attempts = Math.max(0, bucket.attempts - 1);
      }
      this.#active = Math.max(0, this.#active - 1);
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now && bucket.active === 0) this.#buckets.delete(key);
    }
    if (this.#buckets.size <= 10_000) return;
    for (const key of this.#buckets.keys()) {
      this.#buckets.delete(key);
      if (this.#buckets.size <= 10_000) break;
    }
  }
}

export function authAttemptKeys(request: Request, config: AppConfig, kind: string, subject: unknown): AuthAttemptLimit[] {
  const address = trustedProxyClientAddress(request, config)
    ?? request.socket.remoteAddress?.toLowerCase().replace(/^::ffff:/, "")
    ?? "unknown";
  const normalized = typeof subject === "string" ? subject.trim().toLowerCase() : "invalid";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return [
    { key: `auth:${address}:*`, maxAttempts: 60, maxActive: 4 },
    { key: `${kind}:subject:${digest}`, maxAttempts: 8, maxActive: 2 },
  ];
}

/** Assistant OAuth endpoints are public: bound registrations and token exchanges per client address. */
export function assistantOAuthAttemptKeys(request: Request, config: AppConfig, endpoint: string): AuthAttemptLimit[] {
  const address = trustedProxyClientAddress(request, config)
    ?? request.socket.remoteAddress?.toLowerCase().replace(/^::ffff:/, "")
    ?? "unknown";
  return [
    { key: `assistant-oauth:${address}:*`, maxAttempts: 120, maxActive: 4 },
    { key: `assistant-oauth:${address}:${endpoint}`, maxAttempts: endpoint === "register" ? 10 : 60, maxActive: 2 },
  ];
}

export function trackingObserverAttemptKeys(
  request: Request,
  config: AppConfig,
  credential: string,
): AuthAttemptLimit[] {
  const address = trustedProxyClientAddress(request, config)
    ?? request.socket.remoteAddress?.toLowerCase().replace(/^::ffff:/, "")
    ?? "unknown";
  const digest = createHash("sha256").update(credential).digest("hex").slice(0, 24);
  return [
    { key: `tracking-observer:${address}:*`, maxAttempts: 240, maxActive: 4 },
    { key: `tracking-observer:credential:${digest}`, maxAttempts: 120, maxActive: 2 },
  ];
}
