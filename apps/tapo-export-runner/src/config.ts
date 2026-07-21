import { hostname } from "node:os";
import { createHash, createHmac } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface RunnerConfig {
  enabled: boolean;
  apiBaseUrl: string;
  apiPrefix: string;
  apiToken: string;
  workerLabel: string;
  workerId: string;
  targetLockId: string;
  /** Stable attestation for the exact Android/Tapo/driver/flow deployment. */
  deploymentFingerprint: string;
  tapoAppVersion: string;
  appiumVersion: string;
  appiumUrl: string;
  appiumCapabilities: Record<string, unknown>;
  appiumLogsHardened: boolean;
  uiautomator2Version: string;
  appiumSessionFile: string;
  artifactDirectory: string;
  artifactRetentionMs: number;
  flowConfigFile: string;
  /** Exact bytes hashed into deploymentFingerprint and parsed at startup. */
  flowConfigSource: string;
  tapoUsername?: string;
  tapoPassword?: string;
  dedicatedAccount: boolean;
  exportEmail: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  requestTimeoutMs: number;
  defaultActionTimeoutMs: number;
  keepSessionOnShutdown: boolean;
}

type Environment = Record<string, string | undefined>;

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function integerValue(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function urlValue(value: string | undefined, fallback: string, name: string): string {
  const candidate = value?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) throw new Error(`${name} must not contain URL credentials`);
  const localHttpHosts = new Set([
    "127.0.0.1",
    "[::1]",
    "::1",
    "localhost",
    "host.docker.internal",
    "api",
    "appium",
  ]);
  if (parsed.protocol === "http:" && !localHttpHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${name} must use HTTPS except for an explicit loopback or Compose service host`);
  }
  return parsed.toString().replace(/\/$/u, "");
}

function objectJson(value: string | undefined, name: string): Record<string, unknown> {
  const candidate = value?.trim() ||
    '{"platformName":"Android","appium:automationName":"UiAutomator2","appium:noReset":true,"appium:newCommandTimeout":86400}';
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export interface DeploymentFingerprintInput {
  runnerImplementationSha256?: string;
  flowConfigSource: string;
  targetLockId: string;
  appiumUdid: string;
  tapoAppVersion: string;
  appiumVersion: string;
  uiautomator2Version: string;
  exportEmail: string;
  apiToken: string;
  accountIdentity: { kind: "email" | "proof"; value: string };
  appiumCapabilities: Record<string, unknown>;
}

/**
 * Hash the exact compiled runner implementation being executed. This is
 * intentionally derived at runtime rather than supplied by an operator: a
 * rebuilt image cannot inherit a canary merely by retaining its environment.
 */
export function runnerImplementationSha256(directory = dirname(fileURLToPath(import.meta.url))): string {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    }
  };
  visit(directory);
  if (files.length === 0) throw new Error("Runner implementation attestation found no compiled JavaScript files");
  const hash = createHash("sha256");
  for (const path of files.sort((left, right) => relative(directory, left).localeCompare(relative(directory, right)))) {
    const name = relative(directory, path).replaceAll("\\", "/");
    const metadata = statSync(path);
    if (!metadata.isFile()) throw new Error("Runner implementation changed during attestation");
    hash.update(name, "utf8").update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
}

/**
 * Hashes only deployment pins, with sorted object keys so equivalent JSON
 * capability objects produce the same attestation on every host.
 */
export function calculateDeploymentFingerprint(input: DeploymentFingerprintInput): string {
  const implementationSha256 = input.runnerImplementationSha256 ?? runnerImplementationSha256();
  if (!/^[a-f0-9]{64}$/u.test(implementationSha256)) {
    throw new Error("Runner implementation digest must be 64 lowercase hexadecimal characters");
  }
  const platformName = input.appiumCapabilities.platformName;
  const platformVersion = input.appiumCapabilities["appium:platformVersion"];
  const flowSha256 = createHash("sha256").update(input.flowConfigSource, "utf8").digest("hex");
  const normalizedAccountIdentity = input.accountIdentity.kind === "email"
    ? input.accountIdentity.value.trim().toLowerCase()
    : input.accountIdentity.value.trim();
  const accountIdentityHmac = createHmac("sha256", input.apiToken)
    .update(normalizedAccountIdentity, "utf8")
    .digest("hex");
  const attestation = {
    schema: "stuga-tapo-deployment-v4",
    runnerImplementationSha256: implementationSha256,
    nodeVersion: process.versions.node,
    flowSha256,
    targetLockId: input.targetLockId,
    appiumUdid: input.appiumUdid,
    tapoAppVersion: input.tapoAppVersion,
    appiumVersion: input.appiumVersion,
    uiautomator2Version: input.uiautomator2Version,
    exportMailbox: normalizedExportMailbox(input.exportEmail),
    accountIdentityKind: input.accountIdentity.kind,
    accountIdentityHmac,
    platformName,
    platformVersion,
    capabilities: input.appiumCapabilities,
  };
  return createHash("sha256").update(canonicalJson(attestation), "utf8").digest("hex");
}

function normalizedExportMailbox(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  const local = trimmed.slice(0, at).split("+", 1)[0]?.toLowerCase() ?? "";
  return `${local}@${trimmed.slice(at + 1).toLowerCase()}`;
}

function optionalSecret(
  env: Environment,
  inlineName: string,
  fileName: string,
): string | undefined {
  const inline = env[inlineName]?.trim();
  const file = env[fileName]?.trim();
  if (inline && file) throw new Error(`Configure only one of ${inlineName} or ${fileName}`);
  const resolvedFile = file ? resolve(file) : undefined;
  const trimmed = inline || (resolvedFile && existsSync(resolvedFile)
    ? readFileSync(resolvedFile, "utf8").trim()
    : undefined);
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: Environment = process.env): RunnerConfig {
  const enabled = booleanValue(env.TAPO_RUNNER_ENABLED, false, "TAPO_RUNNER_ENABLED");
  const apiToken = optionalSecret(env, "TAPO_HISTORY_WORKER_TOKEN", "TAPO_HISTORY_WORKER_TOKEN_FILE") ?? "";
  const flowConfigFile = env.TAPO_RUNNER_FLOW_CONFIG?.trim() ?? "";
  const exportEmail = env.TAPO_EXPORT_EMAIL?.trim() ?? "";
  const appiumUrl = urlValue(env.TAPO_APPIUM_URL, "http://127.0.0.1:4723", "TAPO_APPIUM_URL");
  const appiumCapabilities = objectJson(env.TAPO_APPIUM_CAPABILITIES_JSON, "TAPO_APPIUM_CAPABILITIES_JSON");
  const appiumUdid = appiumCapabilities["appium:udid"];
  const appiumPlatformName = appiumCapabilities.platformName;
  const appiumAutomationName = appiumCapabilities["appium:automationName"];
  const appiumPlatformVersion = appiumCapabilities["appium:platformVersion"];
  const appiumLanguage = appiumCapabilities["appium:language"];
  const appiumLocale = appiumCapabilities["appium:locale"];
  const targetLockId = env.TAPO_TARGET_LOCK_ID?.trim() ?? "";
  const appiumLogsHardened = booleanValue(
    env.TAPO_APPIUM_LOGS_HARDENED,
    false,
    "TAPO_APPIUM_LOGS_HARDENED",
  );
  const uiautomator2Version = env.TAPO_UIAUTOMATOR2_VERSION?.trim() ?? "";
  const appiumVersion = env.TAPO_APPIUM_VERSION?.trim() ?? "";
  const tapoAppVersion = env.TAPO_APP_VERSION?.trim() ?? "";
  const tapoUsername = optionalSecret(env, "TAPO_ACCOUNT_EMAIL", "TAPO_ACCOUNT_EMAIL_FILE");
  const tapoPassword = optionalSecret(env, "TAPO_ACCOUNT_PASSWORD", "TAPO_ACCOUNT_PASSWORD_FILE");
  const accountProof = optionalSecret(env, "TAPO_ACCOUNT_PROOF", "TAPO_ACCOUNT_PROOF_FILE");
  const dedicatedAccount = booleanValue(env.TAPO_DEDICATED_ACCOUNT, false, "TAPO_DEDICATED_ACCOUNT");

  if (enabled) {
    if (!apiToken) throw new Error("TAPO_HISTORY_WORKER_TOKEN is required when the runner is enabled");
    if (Buffer.byteLength(apiToken, "utf8") < 32) throw new Error("TAPO_HISTORY_WORKER_TOKEN must contain at least 32 bytes");
    if (apiToken === "replace-with-a-long-random-token") {
      throw new Error("TAPO_HISTORY_WORKER_TOKEN must be generated; the published example placeholder is forbidden");
    }
    if (!flowConfigFile) throw new Error("TAPO_RUNNER_FLOW_CONFIG is required when the runner is enabled");
    if (!exportEmail) throw new Error("TAPO_EXPORT_EMAIL is required when the runner is enabled");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(exportEmail)) {
      throw new Error("TAPO_EXPORT_EMAIL must be a valid email address");
    }
    if (typeof appiumUdid !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(appiumUdid)) {
      throw new Error("TAPO_APPIUM_CAPABILITIES_JSON must contain a stable appium:udid when the runner is enabled");
    }
    if (appiumPlatformName !== "Android") {
      throw new Error("TAPO_APPIUM_CAPABILITIES_JSON must pin platformName to Android when the runner is enabled");
    }
    if (appiumAutomationName !== "UiAutomator2") {
      throw new Error("TAPO_APPIUM_CAPABILITIES_JSON must pin appium:automationName to UiAutomator2 when the runner is enabled");
    }
    if (typeof appiumPlatformVersion !== "string"
      || !/^[0-9]+(?:\.[0-9]+){0,3}$/u.test(appiumPlatformVersion)) {
      throw new Error("TAPO_APPIUM_CAPABILITIES_JSON must contain an exact appium:platformVersion when the runner is enabled");
    }
    if (typeof appiumLanguage !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,34}$/u.test(appiumLanguage)) {
      throw new Error("TAPO_APPIUM_CAPABILITIES_JSON must contain an exact appium:language when the runner is enabled");
    }
    if (typeof appiumLocale !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,34}$/u.test(appiumLocale)) {
      throw new Error("TAPO_APPIUM_CAPABILITIES_JSON must contain an exact appium:locale when the runner is enabled");
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(targetLockId) || targetLockId === "change-me") {
      throw new Error("TAPO_TARGET_LOCK_ID must be a stable 8-128 character deployment target id when the runner is enabled");
    }
    if (!appiumLogsHardened) {
      throw new Error("TAPO_APPIUM_LOGS_HARDENED=true is required because export aliases are sensitive inputs");
    }
    const driverVersion = /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/u.exec(uiautomator2Version);
    if (!driverVersion || Number(driverVersion[1]) < 3
      || (Number(driverVersion[1]) === 3 && Number(driverVersion[2]) < 1)) {
      throw new Error("TAPO_UIAUTOMATOR2_VERSION must record a verified UiAutomator2 driver version of 3.1.0 or newer");
    }
    const serverVersion = /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/u.exec(appiumVersion);
    if (!serverVersion || Number(serverVersion[1]) < 2
      || (Number(serverVersion[1]) === 2 && Number(serverVersion[2]) < 18)) {
      throw new Error("TAPO_APPIUM_VERSION must record the exact Appium server version 2.18.0 or newer");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._()+-]{0,127}$/u.test(tapoAppVersion)
      || /^(?:latest|stable|current|change[-_]?me)$/iu.test(tapoAppVersion)) {
      throw new Error("TAPO_APP_VERSION must contain the exact installed Tapo APK version when the runner is enabled");
    }
    if ((tapoUsername === undefined) !== (tapoPassword === undefined)) {
      throw new Error("TAPO_ACCOUNT_EMAIL and TAPO_ACCOUNT_PASSWORD must be configured together");
    }
    if (tapoUsername !== undefined && accountProof !== undefined) {
      throw new Error("TAPO_ACCOUNT_PROOF is only valid for preauthenticated mode without account credentials");
    }
    if (tapoUsername === undefined) {
      if (!accountProof || Buffer.byteLength(accountProof, "utf8") < 32
        || accountProof === "replace-with-a-high-entropy-account-proof") {
        throw new Error("TAPO_ACCOUNT_PROOF must be a stable high-entropy secret of at least 32 bytes in preauthenticated mode");
      }
    }
    if (!dedicatedAccount) {
      throw new Error("TAPO_DEDICATED_ACCOUNT=true is required to attest that the automation account has globally unique device aliases");
    }
  }

  const apiPrefixRaw = env.TAPO_RUNNER_API_PREFIX?.trim() || "/api/v1/internal/tapo-history";
  const apiPrefix = `/${apiPrefixRaw.replace(/^\/+|\/+$/gu, "")}`;

  let flowConfigSource = "";
  if (enabled) {
    try {
      flowConfigSource = readFileSync(resolve(flowConfigFile), "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown read error";
      throw new Error(`Cannot read TAPO_RUNNER_FLOW_CONFIG for deployment attestation: ${reason}`);
    }
  }
  const deploymentFingerprint = enabled
    ? calculateDeploymentFingerprint({
      flowConfigSource,
      targetLockId,
      appiumUdid: (appiumUdid as string).trim(),
      tapoAppVersion,
      appiumVersion,
      uiautomator2Version,
      exportEmail,
      apiToken,
      accountIdentity: tapoUsername === undefined
        ? { kind: "proof", value: accountProof! }
        : { kind: "email", value: tapoUsername },
      appiumCapabilities,
    })
    : "";

  const targetIdentity = createHash("sha256")
    .update(`${targetLockId || "unconfigured"}\u0000${typeof appiumUdid === "string" ? appiumUdid.trim() : "unconfigured"}`)
    .digest("hex").slice(0, 24);
  const config: RunnerConfig = {
    enabled,
    apiBaseUrl: urlValue(env.STUGA_API_URL, "http://127.0.0.1:8787", "STUGA_API_URL"),
    apiPrefix,
    apiToken,
    workerLabel: env.TAPO_RUNNER_WORKER_ID?.trim() || `${hostname()}-tapo-export`,
    // The lease owner is derived from an operator-stable physical target id +
    // UDID. DNS aliases and runner process names cannot split the phone lock.
    workerId: `tapo-target-${targetIdentity}`,
    targetLockId,
    deploymentFingerprint,
    tapoAppVersion,
    appiumVersion,
    appiumUrl,
    appiumCapabilities,
    appiumLogsHardened,
    uiautomator2Version,
    appiumSessionFile: resolve(env.TAPO_APPIUM_SESSION_FILE?.trim() || "data/tapo-appium-session.json"),
    artifactDirectory: resolve(env.TAPO_RUNNER_ARTIFACT_DIR?.trim() || "data/tapo-runner-artifacts"),
    artifactRetentionMs: integerValue(
      env.TAPO_RUNNER_ARTIFACT_RETENTION_DAYS,
      30,
      "TAPO_RUNNER_ARTIFACT_RETENTION_DAYS",
      1,
      365,
    ) * 24 * 60 * 60_000,
    flowConfigFile: flowConfigFile ? resolve(flowConfigFile) : "",
    flowConfigSource,
    exportEmail,
    dedicatedAccount,
    pollIntervalMs: integerValue(env.TAPO_RUNNER_POLL_MS, 10_000, "TAPO_RUNNER_POLL_MS", 1_000, 300_000),
    heartbeatIntervalMs: integerValue(env.TAPO_RUNNER_HEARTBEAT_MS, 15_000, "TAPO_RUNNER_HEARTBEAT_MS", 2_000, 60_000),
    requestTimeoutMs: integerValue(env.TAPO_RUNNER_REQUEST_TIMEOUT_MS, 15_000, "TAPO_RUNNER_REQUEST_TIMEOUT_MS", 1_000, 120_000),
    defaultActionTimeoutMs: integerValue(env.TAPO_ACTION_TIMEOUT_MS, 15_000, "TAPO_ACTION_TIMEOUT_MS", 1_000, 120_000),
    keepSessionOnShutdown: booleanValue(env.TAPO_KEEP_SESSION_ON_SHUTDOWN, true, "TAPO_KEEP_SESSION_ON_SHUTDOWN"),
  };

  if (tapoUsername !== undefined) config.tapoUsername = tapoUsername;
  if (tapoPassword !== undefined) config.tapoPassword = tapoPassword;
  return config;
}
