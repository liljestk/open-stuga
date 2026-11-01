import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { parse as parsePath, resolve } from "node:path";

import { pathToFileURL } from "node:url";

export const API_BASE = "https://api.cloudflare.com/client/v4";

export const MANAGED_COMMENT = "Managed by Stugu cloudflare-stugu.mjs";

export class UsageError extends Error {}

export class CloudflareApiError extends Error {
  constructor(message, status, codes = []) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.codes = codes;
  }
}

export function usage() {
  return `Usage:
  node scripts/cloudflare-stugu.mjs provision \\
    --hostname stugu.example.com \\
    --zone example.com \\
    --owner-email owner@example.com \\
    --provision-token-file <temporary-token-file> \\
    --access-token-file <runtime-access-group-token-file> \\
    [--account-id <32-hex-id>] [--zone-id <32-hex-id>] \\
    [--secret-dir ./secrets/cloudflare]

  node scripts/cloudflare-stugu.mjs provision-coordinator \\
    --hostname stugu.example.com \\
    --zone example.com \\
    --owner-email owner@example.com \\
    --provision-token-file <temporary-token-file> \\
    --access-token-file <runtime-access-group-token-file> \\
    [--account-id <32-hex-id>] [--zone-id <32-hex-id>] \\
    [--secret-dir ./secrets/cloudflare]

  node scripts/cloudflare-stugu.mjs verify-coordinator \\
    [--secret-dir ./secrets/cloudflare]

  node scripts/cloudflare-stugu.mjs verify \\
    [--secret-dir ./secrets/cloudflare]

The temporary provisioning token is read but never copied. The runtime token
must have only Account > Access: Organizations, Identity Providers, and Groups
Write. Token values are never accepted as command-line arguments.

provision exposes only the human UI through Access. provision-coordinator also
publishes the signed machine protocol path and pins STUGBY_PUBLIC_ORIGIN.`;
}

export function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...rest] = argv;
  if (!["provision", "provision-coordinator", "verify", "verify-coordinator"].includes(command)) {
    throw new UsageError("The provision, provision-coordinator, verify, or verify-coordinator command is required");
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new UsageError(`Expected a value after ${key ?? "the final argument"}`);
    }
    if (Object.hasOwn(values, key)) throw new UsageError(`Duplicate option ${key}`);
    values[key] = value;
  }
  const provisioningOptions = [
    "--hostname", "--zone", "--owner-email", "--provision-token-file", "--access-token-file",
    "--account-id", "--zone-id", "--secret-dir",
  ];
  const verifying = command === "verify" || command === "verify-coordinator";
  const allowed = new Set(verifying ? ["--secret-dir"] : provisioningOptions);
  const unknown = Object.keys(values).find((key) => !allowed.has(key));
  if (unknown) throw new UsageError(`Unknown option ${unknown}`);
  if (verifying) {
    return {
      help: false,
      command,
      secretDirectory: resolve(values["--secret-dir"] ?? "./secrets/cloudflare"),
    };
  }
  for (const required of ["--hostname", "--zone", "--owner-email", "--provision-token-file", "--access-token-file"]) {
    if (!values[required]) throw new UsageError(`${required} is required`);
  }
  return {
    help: false,
    command,
    hostname: values["--hostname"].trim().toLowerCase(),
    zone: values["--zone"].trim().toLowerCase(),
    ownerEmail: values["--owner-email"].trim().toLowerCase(),
    provisionTokenFile: resolve(values["--provision-token-file"]),
    accessTokenFile: resolve(values["--access-token-file"]),
    accountId: values["--account-id"]?.trim() ?? null,
    zoneId: values["--zone-id"]?.trim() ?? null,
    secretDirectory: resolve(values["--secret-dir"] ?? "./secrets/cloudflare"),
  };
}

export function validateOptions(options) {
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.hostname)) {
    throw new UsageError("--hostname must be a valid lowercase DNS hostname");
  }
  if (options.hostname !== options.zone && !options.hostname.endsWith(`.${options.zone}`)) {
    throw new UsageError("--hostname must belong to --zone");
  }
  if (!/^[^\s@<>,]+@[^\s@<>,]+$/.test(options.ownerEmail) || options.ownerEmail.length > 254) {
    throw new UsageError("--owner-email must be a valid email address");
  }
  for (const [label, value] of [["--account-id", options.accountId], ["--zone-id", options.zoneId]]) {
    if (value && !/^[a-f0-9]{32}$/i.test(value)) throw new UsageError(`${label} must be a 32-character hexadecimal ID`);
  }
  if (options.oauthClientId
    && (options.oauthClientId.length < 8
      || options.oauthClientId.length > 200
      || !/^[A-Za-z0-9._~-]+$/.test(options.oauthClientId))) {
    throw new UsageError("Cloudflare OAuth client ID is invalid");
  }
  if (options.oauthRedirectUri) {
    let redirect;
    try { redirect = new URL(options.oauthRedirectUri); } catch {
      throw new UsageError("Cloudflare OAuth redirect URI is invalid");
    }
    const port = Number(redirect.port);
    if (
      redirect.protocol !== "http:"
      || redirect.hostname !== "127.0.0.1"
      || !Number.isInteger(port)
      || port < 1024
      || port > 65_535
      || ![
        "/cloudflare/oauth/callback",
        "/api/v1/cloudflare/setup/oauth/callback",
      ].includes(redirect.pathname)
      || redirect.username
      || redirect.password
      || redirect.search
      || redirect.hash
    ) {
      throw new UsageError("Cloudflare OAuth redirect URI must use Stugu's explicit local callback");
    }
  }
  if (options.secretDirectory && resolve(options.secretDirectory) === parsePath(resolve(options.secretDirectory)).root) {
    throw new UsageError("--secret-dir must be a dedicated subdirectory");
  }
}

export function validateToken(token, label) {
  const normalized = typeof token === "string" ? token.trim() : "";
  if (Buffer.byteLength(normalized, "utf8") < 32 || /[\r\n]/.test(normalized)) {
    throw new UsageError(`${label} does not contain one valid token`);
  }
  return normalized;
}

export function readToken(path, label) {
  let token;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error("not a regular file");
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new UsageError(`${label} is readable by another user; restrict it to mode 0600`);
    }
    token = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${label} could not be read`);
  }
  return validateToken(token, label);
}

export function safeErrorMessages(errors) {
  return (Array.isArray(errors) ? errors : []).slice(0, 3).map((error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    const message = error && typeof error === "object" && typeof error.message === "string"
      ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      : "Cloudflare rejected the request";
    return `${code}: ${message}`;
  });
}

export function cloudflareClient(token, fetcher = fetch) {
  return async (path, init = {}) => {
    const response = await fetcher(`${API_BASE}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const text = await response.text();
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new CloudflareApiError(`Cloudflare returned invalid JSON (HTTP ${response.status})`, response.status);
    }
    if (!response.ok || envelope?.success !== true) {
      const messages = safeErrorMessages(envelope?.errors);
      throw new CloudflareApiError(
        `Cloudflare API request failed (HTTP ${response.status})${messages.length ? `: ${messages.join("; ")}` : ""}`,
        response.status,
        messages,
      );
    }
    return envelope.result;
  };
}

export async function findAccount(api, requestedId) {
  if (requestedId) return requestedId;
  const accounts = await api("/accounts?per_page=50");
  if (!Array.isArray(accounts) || accounts.length !== 1 || typeof accounts[0]?.id !== "string") {
    throw new UsageError("More than one Cloudflare account is available; pass --account-id explicitly");
  }
  return accounts[0].id;
}

export async function findZone(api, accountId, zoneName, requestedId) {
  if (requestedId) return requestedId;
  const query = new URLSearchParams({ name: zoneName, "account.id": accountId, per_page: "50" });
  const zones = await api(`/zones?${query}`);
  if (!Array.isArray(zones) || zones.length !== 1 || typeof zones[0]?.id !== "string") {
    throw new UsageError(`Could not identify exactly one ${zoneName} zone; pass --zone-id explicitly`);
  }
  return zones[0].id;
}
