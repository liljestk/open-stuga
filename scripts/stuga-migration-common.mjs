import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";

export const STUGA_MIGRATION_FORMAT = "stuga-live-migration";
export const STUGA_MIGRATION_VERSION = 1;
export const DEFAULT_MIGRATION_CHUNK_BYTES = 4 * 1024 * 1024;
export const MIN_MIGRATION_CHUNK_BYTES = 64 * 1024;
export const MAX_MIGRATION_CHUNK_BYTES = 16 * 1024 * 1024;

export const PORTABLE_ENVIRONMENT_KEYS = new Set([
  "ALERT_WEBHOOK_ALLOWED_HOSTS",
  "ALERT_WEBHOOK_BEARER_TOKEN",
  "ALERT_WEBHOOK_DESTINATIONS_JSON",
  "ALERT_WEBHOOK_SIGNING_SECRET",
  "ALERT_WEBHOOK_URL",
  "BACKUP_INTERVAL_HOURS",
  "BACKUP_RETENTION_COUNT",
  "CLOUDFLARED_IMAGE",
  "CLOUDFLARE_ACCESS_STATIC_EMAILS",
  "CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS",
  "COMPOSE_PROFILES",
  "ELECTRICITY_ALLOW_PRIVATE_ENDPOINTS",
  "HA_TOKEN",
  "HA_URL",
  "INGEST_API_KEY",
  "MOCK_ENABLED",
  "MOCK_INTERVAL_MS",
  "RESTORE_DRILL_INTERVAL_DAYS",
  "RETENTION_DAYS",
  "SPATIAL_LAYERS_ENABLED",
  "SPATIAL_LAYERS_INTERVAL_MS",
  "SPATIAL_LAYERS_RETENTION_DAYS",
  "STUGBY_NODE_NAME",
  "STUGBY_SYNC_INTERVAL_MS",
  "TAPO_ACTION_TIMEOUT_MS",
  "TAPO_APP_VERSION",
  "TAPO_APPIUM_CAPABILITIES_JSON",
  "TAPO_APPIUM_LOGS_HARDENED",
  "TAPO_APPIUM_URL",
  "TAPO_APPIUM_VERSION",
  "TAPO_DEDICATED_ACCOUNT",
  "TAPO_HISTORY_EMAIL_TAG_PREFIX",
  "TAPO_HISTORY_EMAIL_TIMEOUT_MS",
  "TAPO_HISTORY_ENABLED",
  "TAPO_HISTORY_EXPORT_EMAIL",
  "TAPO_HISTORY_EXPORT_INTERVAL_MINUTES",
  "TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL",
  "TAPO_HISTORY_GMAIL_CLIENT_ID",
  "TAPO_HISTORY_MAILBOX_POLL_INTERVAL_MS",
  "TAPO_HISTORY_MAX_EXPORT_DAYS",
  "TAPO_HISTORY_MAX_PENDING_EMAILS",
  "TAPO_HISTORY_PRIVATE_ENDPOINT",
  "TAPO_HISTORY_WORKER_LEASE_MS",
  "TAPO_KEEP_SESSION_ON_SHUTDOWN",
  "TAPO_RUNNER_ARTIFACT_RETENTION_DAYS",
  "TAPO_RUNNER_ENABLED",
  "TAPO_RUNNER_HEARTBEAT_MS",
  "TAPO_RUNNER_POLL_MS",
  "TAPO_RUNNER_REQUEST_TIMEOUT_MS",
  "TAPO_RUNNER_WORKER_ID",
  "TAPO_TARGET_LOCK_ID",
  "TAPO_UIAUTOMATOR2_VERSION",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TP_LINK_HOST",
  "TP_LINK_PASSWORD",
  "TP_LINK_POLL_INTERVAL_MS",
  "TP_LINK_USERNAME",
]);

export function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertMigrationId(value) {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("Migration id must be a UUID");
  }
  return value.toLowerCase();
}

export function assertReleaseVersion(value, label = "Version") {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error(`${label} must be a release-like version`);
  }
  return value;
}

export function compareReleaseVersions(left, right) {
  const numeric = (value) => assertReleaseVersion(value).split(/[.-]/u).slice(0, 3).map(Number);
  const leftParts = numeric(left);
  const rightParts = numeric(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return Math.sign(leftParts[index] - rightParts[index]);
  }
  return 0;
}

export function assertSafeRelativePath(value, label = "Path") {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty portable relative path`);
  }
  if (value.startsWith("/") || posix.isAbsolute(value)) throw new Error(`${label} must be relative`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  if (posix.normalize(value) !== value) throw new Error(`${label} is not normalized`);
  return value;
}

export function pathWithin(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === ""
    || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

export function parseEnvironmentAssignments(text) {
  const assignments = new Map();
  for (const line of String(text).replaceAll("\r\n", "\n").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const value = match[2].trim();
    if ((value.startsWith("'") && !value.endsWith("'"))
      || (value.startsWith('"') && !value.endsWith('"'))) {
      throw new Error(`Multiline environment values are not supported for migration: ${match[1]}`);
    }
    assignments.set(match[1], match[2]);
  }
  return assignments;
}

export function portableEnvironment(text, allowed = PORTABLE_ENVIRONMENT_KEYS) {
  const assignments = parseEnvironmentAssignments(text);
  const lines = [
    "# Portable Stuga settings generated for an authenticated live migration.",
    "# Target-specific bind addresses, ports, paths, and database credentials are intentionally excluded.",
  ];
  for (const key of [...allowed].sort()) {
    if (assignments.has(key)) lines.push(`${key}=${assignments.get(key)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function portableEnvironmentFromFile(path) {
  return portableEnvironment(readFileSync(resolve(path), "utf8"));
}

export function mergePortableEnvironment(
  targetText,
  migratedText,
  allowed = PORTABLE_ENVIRONMENT_KEYS,
  { authoritative = false } = {},
) {
  const migrated = parseEnvironmentAssignments(migratedText);
  for (const key of [...migrated.keys()]) {
    if (!allowed.has(key)) throw new Error(`Migration settings contain a non-portable key: ${key}`);
  }
  const seen = new Set();
  const lines = String(targetText).replaceAll("\r\n", "\n").split("\n").filter((line, index, all) => {
    if (index === all.length - 1 && line === "") return false;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line);
    if (authoritative && match && allowed.has(match[1]) && !migrated.has(match[1])) return false;
    if (!match || !migrated.has(match[1])) return true;
    if (seen.has(match[1])) return false;
    seen.add(match[1]);
    return true;
  }).map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line);
    return match && migrated.has(match[1]) ? `${match[1]}=${migrated.get(match[1])}` : line;
  });
  const additions = [...migrated.keys()].filter((key) => !seen.has(key)).sort();
  if (additions.length > 0) {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    lines.push("# Settings copied by Stuga live migration.");
    for (const key of additions) lines.push(`${key}=${migrated.get(key)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function validatedChunkSize(value) {
  const parsed = Number(value ?? DEFAULT_MIGRATION_CHUNK_BYTES);
  if (!Number.isSafeInteger(parsed)
    || parsed < MIN_MIGRATION_CHUNK_BYTES
    || parsed > MAX_MIGRATION_CHUNK_BYTES) {
    throw new Error(`Chunk size must be an integer from ${MIN_MIGRATION_CHUNK_BYTES} to ${MAX_MIGRATION_CHUNK_BYTES} bytes`);
  }
  return parsed;
}
