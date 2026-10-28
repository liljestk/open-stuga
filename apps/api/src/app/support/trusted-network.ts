import type { Request } from "express";
import type { AppConfig } from "../../config.js";
import { cloudflareSetupCallbackPath } from "../../cloudflare-setup.js";
import { HttpError } from "../../http-error.js";
import { isIP } from "node:net";
import { keyMatches } from "./credentials.js";

export function isLoopbackSocket(request: Request): boolean {
  const address = request.socket.remoteAddress?.toLowerCase();
  // Dual-stack sockets report IPv4 peers as IPv4-mapped IPv6 addresses.
  const peer = address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return peer === "127.0.0.1" || peer === "::1";
}

export function isPrivateProxySocket(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (/^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return normalized.startsWith("fc") || normalized.startsWith("fd");
}

export function trustedProxyRequest(request: Request, config: AppConfig): boolean {
  const expected = config.localAuthProxySecret;
  const provided = request.header("x-stugu-local-proxy");
  return Boolean(expected
    && provided
    && isPrivateProxySocket(request.socket.remoteAddress)
    && keyMatches(provided, expected));
}

export function localSetupRequestAllowed(request: Request, config: AppConfig): boolean {
  if (isLoopbackSocket(request)) return true;
  const configuredBind = config.localAuthProxyBindAddress?.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const loopbackBind = configuredBind === "127.0.0.1" || configuredBind === "::1" || configuredBind === "localhost";
  return loopbackBind
    && trustedProxyRequest(request, config);
}

export function localCloudflareUiRequestAllowed(request: Request, config: AppConfig): boolean {
  if (isLoopbackSocket(request)) return true;
  if (!localSetupRequestAllowed(request, config)) return false;
  const forwardedProtocol = request.header("x-forwarded-proto")?.trim().toLowerCase();
  if (forwardedProtocol !== "http") return false;
  try {
    const hostname = new URL(`http://${request.header("host") ?? ""}`).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

export function cloudflareUiRedirectUri(request: Request, config: AppConfig): string {
  if (!localCloudflareUiRequestAllowed(request, config)) {
    throw new HttpError(
      403,
      "CLOUDFLARE_SETUP_LOCAL_ONLY",
      "Open Stugu on this computer through its local address to change the secure connection",
    );
  }
  let port: number;
  try {
    const visible = new URL(`http://${request.header("host") ?? ""}`);
    port = Number(visible.port || 80);
  } catch {
    throw new HttpError(400, "INVALID_LOCAL_ADDRESS", "Stugu could not determine its local browser address");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new HttpError(400, "INVALID_LOCAL_ADDRESS", "Stugu must use an explicit unprivileged local port for Cloudflare approval");
  }
  return `http://127.0.0.1:${port}${cloudflareSetupCallbackPath}`;
}

export function trustedProxyClientAddress(request: Request, config: AppConfig): string | null {
  if (!config.localAuthProxyBindAddress
    || !trustedProxyRequest(request, config)) return null;
  const candidate = request.header("x-real-ip")?.trim().toLowerCase();
  if (!candidate || candidate.includes(",") || isIP(candidate.replace(/^::ffff:/, "")) === 0) return null;
  return candidate.replace(/^::ffff:/, "");
}
