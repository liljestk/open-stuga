import type { Request } from "express";
import type { AppConfig } from "../../config.js";
import { HttpError } from "../../http-error.js";
import { trustedProxyRequest } from "./trusted-network.js";

export function normalizedOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function requestOrigin(request: Request, config: AppConfig): string | null {
  const host = request.header("host");
  if (!host) return null;
  const forwardedProtocol = trustedProxyRequest(request, config)
    ? request.header("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
    : null;
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : request.protocol;
  return normalizedOrigin(`${protocol}://${host}`);
}

export function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function trustedSelfHostname(hostname: string, apiHost: string): boolean {
  const normalized = normalizedHostname(hostname);
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") return true;
  const configured = normalizedHostname(apiHost);
  return !["0.0.0.0", "::", ""].includes(configured) && normalized === configured;
}

export function browserOriginAllowed(request: Request, origin: string, config: AppConfig): boolean {
  const normalized = normalizedOrigin(origin);
  if (!normalized) return false;
  if (normalized === normalizedOrigin(config.corsOrigin)) return true;
  if (normalized !== requestOrigin(request, config)) return false;
  if (trustedProxyRequest(request, config)) return true;
  return trustedSelfHostname(new URL(normalized).hostname, config.apiHost);
}

export function homeAssistantUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new HttpError(400, "INVALID_FIELD", "url must be a valid HTTP or HTTPS Home Assistant address");
  }
}

export function networkHost(value: string): string {
  const host = value.trim();
  const hostnameOrIpv4 = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
  const ipv6 = host.includes(":") && /^[0-9A-Fa-f:]+$/.test(host);
  if (host.length > 253 || (!hostnameOrIpv4 && !ipv6)) {
    throw new HttpError(400, "INVALID_FIELD", "host must be an IP address or local network name without a URL scheme");
  }
  return host;
}
