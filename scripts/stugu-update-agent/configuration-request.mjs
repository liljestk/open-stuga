import { randomUUID } from "node:crypto";

import {
  closeSync,
  existsSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { spawn } from "node:child_process";

import { dirname, join, resolve } from "node:path";

import process from "node:process";

import { pathToFileURL } from "node:url";

import {
  provision as provisionCloudflare,
  validateToken as validateCloudflareToken,
  verifyCoordinator as verifyCloudflareCoordinator,
  verifyDeployment as verifyCloudflareDeployment,
} from ".././cloudflare-stugu.mjs";

import { revokeAccessToken } from ".././cloudflare-oauth.mjs";

export const AGENT_VERSION = "3.0.0";

export const RELEASE_ENV_SCHEMA = "3";

export const RELEASE_MANIFEST_SCHEMA = "stugu-release-manifest/v1";

export const UPDATE_REQUEST_SCHEMA = "stugu-system-update-request/v3";

export const UPDATE_AGENT_CONTRACT = 3;

export const COMPOSE_CONTRACT = 2;

export const MAX_FILE_BYTES = 256 * 1024;

export const MAX_COMMAND_OUTPUT = 16 * 1024;

export const POLL_MS = 5_000;

export const HEARTBEAT_MS = 30_000;

export const UPDATE_TIMEOUT_MS = 45 * 60_000;

export function optional(value) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function trustedRepository(value) {
  const repository = optional(value) ?? "liljestk/open-stuga";
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    throw new Error("SYSTEM_UPDATE_REPOSITORY must use owner/repository form");
  }
  return repository;
}

export function trustedImagePrefix(value, repository) {
  const prefix = optional(value) ?? `ghcr.io/${repository.toLowerCase()}`;
  if (!/^ghcr\.io\/[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/.test(prefix)) {
    throw new Error("SYSTEM_UPDATE_IMAGE_PREFIX must be a lower-case GHCR image prefix");
  }
  return prefix;
}

export function updateRuntime(value) {
  const runtime = optional(value) ?? (existsSync("/etc/stugu-version") ? "raspberry-pi" : "docker");
  if (runtime !== "docker" && runtime !== "raspberry-pi") {
    throw new Error("SYSTEM_UPDATE_RUNTIME must be docker or raspberry-pi");
  }
  return runtime;
}

export function optionValue(args, option) {
  const prefix = `${option}=`;
  const inline = args.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(option);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function readAgentConfig(env = process.env, cwd = process.cwd(), args = process.argv.slice(2)) {
  const projectDirectory = resolve(optionValue(args, "--project-directory")
    ?? optional(env.STUGA_PROJECT_DIRECTORY)
    ?? cwd);
  const operationsDirectory = resolve(
    projectDirectory,
    optional(env.SYSTEM_UPDATE_OPERATIONS_DIRECTORY) ?? join("data", "update-operations"),
  );
  const repository = trustedRepository(env.SYSTEM_UPDATE_REPOSITORY);
  const config = {
    projectDirectory,
    operationsDirectory,
    repository,
    imagePrefix: trustedImagePrefix(env.SYSTEM_UPDATE_IMAGE_PREFIX, repository),
    runtime: updateRuntime(env.SYSTEM_UPDATE_RUNTIME),
    factoryReleaseEnvFile: resolve(
      projectDirectory,
      optional(env.STUGA_FACTORY_RELEASE_ENV_FILE) ?? "release.env",
    ),
    knownGoodReleaseEnvFile: resolve(
      projectDirectory,
      optional(env.STUGA_KNOWN_GOOD_RELEASE_ENV_FILE) ?? ".stugu-known-good.env",
    ),
    releaseEnvFile: resolve(
      projectDirectory,
      optional(env.STUGA_RELEASE_ENV_FILE) ?? ".stugu-release.env",
    ),
    composeProjectName: optional(env.STUGA_COMPOSE_PROJECT_NAME),
    cloudflareSecretDirectory: resolve(
      projectDirectory,
      optional(env.STUGA_UPDATE_CLOUDFLARE_SECRET_DIR)
        ?? optional(env.STUGA_CLOUDFLARE_SECRET_DIR)
        ?? join("secrets", "cloudflare"),
    ),
    composeProfileEnvironmentFile: resolve(
      projectDirectory,
      optional(env.STUGA_UPDATE_PROFILE_ENV_FILE) ?? ".env",
    ),
    once: args.includes("--once"),
  };
  const releasePaths = [
    config.factoryReleaseEnvFile,
    config.knownGoodReleaseEnvFile,
    config.releaseEnvFile,
  ];
  if (new Set(releasePaths).size !== releasePaths.length) {
    throw new Error("Factory, known-good, and candidate release environment files must be distinct");
  }
  return config;
}

export function readJson(path) {
  if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const atomicFileOperations = {
  closeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
};

function writeTextAtomicInternal(
  path,
  text,
  mode = 0o640,
  ownership = null,
  operationOverrides = {},
  durable = false,
) {
  const operations = { ...atomicFileOperations, ...operationOverrides };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor = null;
  let temporaryCreated = false;
  try {
    descriptor = operations.openSync(temporary, "wx", mode);
    temporaryCreated = true;
    operations.writeFileSync(descriptor, text, { encoding: "utf8" });
    operations.fchmodSync(descriptor, mode);
    if (ownership && process.platform !== "win32") {
      operations.fchownSync(descriptor, ownership.uid, ownership.gid);
    }
    if (durable) operations.fsyncSync(descriptor);
    operations.closeSync(descriptor);
    descriptor = null;
    operations.renameSync(temporary, path);
    if (durable) fsyncRenamedFile(path, operations);
  } catch (error) {
    if (descriptor !== null) {
      try {
        operations.closeSync(descriptor);
      } catch {
        // Preserve the first failure; cleanup below remains best effort.
      }
    }
    if (temporaryCreated) {
      try {
        operations.rmSync(temporary, { force: true });
      } catch {
        // Preserve the first failure.
      }
    }
    throw error;
  }
}

function fsyncRenamedFile(path, operations) {
  if (process.platform !== "win32") {
    fsyncDirectory(dirname(path), operations);
    return;
  }
  // Node cannot open Windows directories for fsync. Reopening the renamed
  // target and flushing its handle is the strongest portable metadata barrier.
  const descriptor = operations.openSync(path, "r+");
  try {
    operations.fsyncSync(descriptor);
  } finally {
    operations.closeSync(descriptor);
  }
}

function fsyncDirectory(path, operations) {
  if (process.platform === "win32") return;
  const directoryDescriptor = operations.openSync(path, "r");
  try {
    operations.fsyncSync(directoryDescriptor);
  } finally {
    operations.closeSync(directoryDescriptor);
  }
}

export function writeTextAtomic(
  path,
  text,
  mode = 0o640,
  ownership = null,
  operationOverrides = {},
) {
  writeTextAtomicInternal(path, text, mode, ownership, operationOverrides, false);
}

export function writeTextDurableAtomic(
  path,
  text,
  mode = 0o640,
  ownership = null,
  operationOverrides = {},
) {
  writeTextAtomicInternal(path, text, mode, ownership, operationOverrides, true);
}

export function removeFileDurable(path, operationOverrides = {}) {
  const operations = { ...atomicFileOperations, ...operationOverrides };
  operations.rmSync(path, { force: true });
  fsyncDirectory(dirname(path), operations);
}

export function releaseEnvironmentOwnership(
  directoryMetadata,
  effectiveUserId = process.geteuid?.(),
  platform = process.platform,
) {
  return platform !== "win32" && effectiveUserId === 0
    ? directoryMetadata
    : null;
}

export function writeReleaseEnvironmentAtomic(path, text, operationOverrides = {}) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const directoryMetadata = statSync(directory);
  if (!directoryMetadata.isDirectory()) {
    throw new Error("Release state parent must be a directory");
  }
  const ownership = releaseEnvironmentOwnership(directoryMetadata);
  writeTextDurableAtomic(path, text, 0o640, ownership, operationOverrides);
}

export function writeJson(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o644);
}

export function bounded(text) {
  if (text.length <= MAX_COMMAND_OUTPUT) return text;
  return text.slice(text.length - MAX_COMMAND_OUTPUT);
}

const COMMAND_TERMINATION_GRACE_MS = 5_000;
const COMMAND_TERMINATION_WAIT_MS = 5_000;
const COMMAND_CLOSE_WAIT_MS = 5_000;
const COMMAND_EXIT_CLOSE_WAIT_MS = 1_000;
const COMMAND_TERMINATION_POLL_MS = 25;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (check()) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(COMMAND_TERMINATION_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function taskkill(pid, force) {
  return new Promise((resolveTaskkill) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const killer = spawn("taskkill.exe", args, {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", (error) => resolveTaskkill({ error, status: null }));
    killer.once("close", (status) => resolveTaskkill({ error: null, status }));
  });
}

async function terminateProcessTree(child, options) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    child.kill("SIGTERM");
    return;
  }
  const graceMs = options.terminationGraceMs ?? COMMAND_TERMINATION_GRACE_MS;
  const waitMs = options.terminationWaitMs ?? COMMAND_TERMINATION_WAIT_MS;

  if (process.platform === "win32") {
    const taskkillProcess = options.taskkill ?? taskkill;
    const processExistsCheck = options.processExists ?? processExists;
    const graceful = await taskkillProcess(pid, false);
    if (!processExistsCheck(pid)) return;
    await delay(graceMs);
    const forced = await taskkillProcess(pid, true);
    const stopped = await waitUntil(() => processExistsCheck(pid), waitMs);
    if (stopped) return;
    const cause = forced.error ?? graceful.error;
    throw new Error(
      `process tree ${pid} could not be confirmed terminated after taskkill${cause ? `: ${cause.message}` : ""}`,
    );
  }

  signalProcessGroup(pid, "SIGTERM");
  if (await waitUntil(() => processGroupExists(pid), graceMs)) return;
  signalProcessGroup(pid, "SIGKILL");
  if (await waitUntil(() => processGroupExists(pid), waitMs)) return;
  throw new Error(`process group ${pid} remained alive after SIGKILL`);
}

function commandTimeoutError(command, terminationError = null) {
  const error = new Error(
    terminationError
      ? `${command} timed out and its process tree could not be terminated: ${terminationError.message}`
      : `${command} timed out`,
  );
  error.code = "COMMAND_TIMEOUT";
  error.processTreeTerminated = terminationError === null;
  return error;
}

function waitForClose(closed, timeoutMs) {
  return new Promise((resolveWait) => {
    let complete = false;
    const finish = (value) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolveWait(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void closed.then(() => finish(true));
  });
}

export async function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timedOut = false;
    let exitCloseTimer = null;
    let resolveClosed;
    const closed = new Promise((resolveClose) => { resolveClosed = resolveClose; });
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (exitCloseTimer !== null) clearTimeout(exitCloseTimer);
      callback(value);
    };
    const settleFromExit = (code, signal) => {
      if (code === 0) settle(resolveCommand, output.trim());
      else settle(rejectCommand, new Error(`${command} exited ${code ?? signal ?? "unexpectedly"}${output.trim() ? `: ${output.trim()}` : ""}`));
    };
    const append = (chunk) => { output = bounded(output + chunk.toString("utf8")); };
    child.stdout.on("data", append);
    if (!options.ignoreStderr) child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void terminateProcessTree(child, options).then(
        async () => {
          const didClose = await waitForClose(
            closed,
            options.terminationCloseWaitMs ?? COMMAND_CLOSE_WAIT_MS,
          );
          settle(
            rejectCommand,
            commandTimeoutError(
              command,
              didClose
                ? null
                : new Error("terminated process group left inherited output handles open"),
            ),
          );
        },
        (terminationError) => {
          settle(rejectCommand, commandTimeoutError(command, terminationError));
        },
      );
    }, options.timeoutMs ?? UPDATE_TIMEOUT_MS);
    child.once("error", (error) => {
      resolveClosed();
      if (!timedOut) settle(rejectCommand, error);
    });
    child.once("exit", (code, signal) => {
      if (timedOut || settled) return;
      // Process execution is complete. Give inherited output handles a short,
      // independent drain window rather than converting a successful exit into
      // a full command timeout when a descendant keeps a pipe open.
      clearTimeout(timeout);
      exitCloseTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolveClosed();
        settleFromExit(code, signal);
      }, options.exitCloseWaitMs ?? COMMAND_EXIT_CLOSE_WAIT_MS);
    });
    child.once("close", (code, signal) => {
      resolveClosed();
      if (timedOut) return;
      settleFromExit(code, signal);
    });
  });
}

const releaseImageSuffixes = {
  api: "api",
  web: "web",
  backup: "backup",
  tapo: "tapo-export-runner",
  updateAgent: "update-agent",
  mqtt: "mqtt",
  nexus433: "nexus433",
};

export function isExpectedDigestImage(config, name, version, value) {
  if (typeof value !== "string" || !(name in releaseImageSuffixes)) return false;
  const prefix = `${config.imagePrefix}-${releaseImageSuffixes[name]}:v${version}@sha256:`;
  return value.startsWith(prefix)
    && value.length === prefix.length + 64
    && /^[0-9a-f]{64}$/.test(value.slice(prefix.length));
}

export function validatedRequest(value, config) {
  if (!value || typeof value !== "object" || value.schema !== UPDATE_REQUEST_SCHEMA) {
    throw new Error("Unsupported update request");
  }
  if (
    typeof value.id !== "string"
    || !/^[0-9a-f-]{36}$/i.test(value.id)
    || typeof value.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)
    || typeof value.tagName !== "string"
    || value.tagName !== `v${value.version}`
    || value.repository !== config.repository
    || typeof value.requestedAt !== "string"
    || !Number.isFinite(Date.parse(value.requestedAt))
    || typeof value.previousVersion !== "string"
    || value.releaseManifestSchema !== RELEASE_MANIFEST_SCHEMA
    || value.compatibility?.updateAgent !== UPDATE_AGENT_CONTRACT
    || value.compatibility?.compose !== COMPOSE_CONTRACT
  ) throw new Error("Update request contains invalid release identity");
  const images = {};
  if (
    !value.images
    || typeof value.images !== "object"
    || Object.keys(value.images).length !== Object.keys(releaseImageSuffixes).length
  ) {
    throw new Error("Update request does not contain immutable release images");
  }
  for (const name of Object.keys(releaseImageSuffixes)) {
    const image = value.images[name];
    if (!isExpectedDigestImage(config, name, value.version, image)) {
      throw new Error("Update request attempted to override the trusted image namespace or omit an immutable digest");
    }
    images[name] = image;
  }
  return {
    id: value.id,
    version: value.version,
    tagName: value.tagName,
    requestedAt: new Date(value.requestedAt).toISOString(),
    previousVersion: value.previousVersion,
    compatibility: {
      updateAgent: UPDATE_AGENT_CONTRACT,
      compose: COMPOSE_CONTRACT,
    },
    images,
  };
}

export function validatedCloudflareHostname(value, label) {
  const hostname = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new Error(`${label} is invalid`);
  }
  return hostname;
}

export function validatedCloudflareSetupRequest(value) {
  if (!value || typeof value !== "object" || value.schema !== "stugu-cloudflare-setup-request/v1") {
    throw new Error("Unsupported Cloudflare setup request");
  }
  const mode = value.mode;
  const command = value.command;
  const hostname = validatedCloudflareHostname(value.hostname, "Stugu address");
  const zone = validatedCloudflareHostname(value.zone, "Cloudflare zone");
  if (
    typeof value.id !== "string"
    || !/^[0-9a-f-]{36}$/i.test(value.id)
    || (mode !== "remote-ui" && mode !== "stuguby-coordinator")
    || command !== (mode === "stuguby-coordinator" ? "provision-coordinator" : "provision")
    || typeof value.requestedAt !== "string"
    || !Number.isFinite(Date.parse(value.requestedAt))
    || (hostname !== zone && !hostname.endsWith(`.${zone}`))
    || typeof value.ownerEmail !== "string"
    || value.ownerEmail.length > 254
    || !/^[^\s@<>,]+@[^\s@<>,]+$/.test(value.ownerEmail)
    || typeof value.accountId !== "string"
    || !/^[a-f0-9]{32}$/i.test(value.accountId)
    || (value.zoneId !== null && (typeof value.zoneId !== "string" || !/^[a-f0-9]{32}$/i.test(value.zoneId)))
    || typeof value.oauthClientId !== "string"
    || value.oauthClientId.length < 8
    || value.oauthClientId.length > 200
    || !/^[A-Za-z0-9._~-]+$/.test(value.oauthClientId)
    || typeof value.oauthRedirectUri !== "string"
    || typeof value.claimSecret !== "string"
    || !/^[A-Za-z0-9_-]{43,128}$/.test(value.claimSecret)
  ) throw new Error("Cloudflare setup request contains invalid configuration");
  let redirect;
  try { redirect = new URL(value.oauthRedirectUri); } catch {
    throw new Error("Cloudflare setup callback is invalid");
  }
  const redirectPort = Number(redirect.port);
  if (
    redirect.protocol !== "http:"
    || redirect.hostname !== "127.0.0.1"
    || !Number.isInteger(redirectPort)
    || redirectPort < 1024
    || redirectPort > 65_535
    || redirect.pathname !== "/api/v1/cloudflare/setup/oauth/callback"
    || redirect.username
    || redirect.password
    || redirect.search
    || redirect.hash
  ) throw new Error("Cloudflare setup callback is not an explicit loopback address");
  return {
    id: value.id,
    mode,
    command,
    hostname,
    zone,
    ownerEmail: value.ownerEmail.trim().toLowerCase(),
    accountId: value.accountId,
    zoneId: value.zoneId,
    oauthClientId: value.oauthClientId,
    oauthRedirectUri: redirect.href,
    claimSecret: value.claimSecret,
    requestedAt: new Date(value.requestedAt).toISOString(),
  };
}

export function releaseEnvironment(request) {
  return [
    `STUGA_RELEASE_ENV_SCHEMA=${RELEASE_ENV_SCHEMA}`,
    `STUGA_UPDATE_AGENT_CONTRACT=${request.compatibility.updateAgent}`,
    `STUGA_COMPOSE_CONTRACT=${request.compatibility.compose}`,
    `STUGA_VERSION=${request.version}`,
    `STUGA_API_IMAGE=${request.images.api}`,
    `STUGA_WEB_IMAGE=${request.images.web}`,
    `STUGA_BACKUP_IMAGE=${request.images.backup}`,
    `STUGA_TAPO_RUNNER_IMAGE=${request.images.tapo}`,
    `STUGA_UPDATE_AGENT_IMAGE=${request.images.updateAgent}`,
    `STUGA_MQTT_IMAGE=${request.images.mqtt}`,
    `STUGA_NEXUS433_IMAGE=${request.images.nexus433}`,
    "",
  ].join("\n");
}

const releaseEnvironmentKeys = new Set([
  "STUGA_RELEASE_ENV_SCHEMA",
  "STUGA_UPDATE_AGENT_CONTRACT",
  "STUGA_COMPOSE_CONTRACT",
  "STUGA_VERSION",
  "STUGA_API_IMAGE",
  "STUGA_WEB_IMAGE",
  "STUGA_BACKUP_IMAGE",
  "STUGA_TAPO_RUNNER_IMAGE",
  "STUGA_UPDATE_AGENT_IMAGE",
  "STUGA_MQTT_IMAGE",
  "STUGA_NEXUS433_IMAGE",
]);

const legacyReleaseEnvironmentKeys = new Set([
  "STUGA_VERSION",
  "STUGA_API_IMAGE",
  "STUGA_WEB_IMAGE",
  "STUGA_BACKUP_IMAGE",
  "STUGA_TAPO_RUNNER_IMAGE",
  "STUGA_UPDATE_AGENT_IMAGE",
]);

function releaseEnvironmentValues(lines, keys, label) {
  const values = {};
  if (lines.length !== keys.size) return null;
  for (const line of lines) {
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator) : "";
    if (!keys.has(key) || key in values) {
      throw new Error(`${label} contains an unsupported or duplicate setting`);
    }
    values[key] = line.slice(separator + 1);
  }
  return values;
}

function releaseImages(values) {
  return {
    api: values.STUGA_API_IMAGE,
    web: values.STUGA_WEB_IMAGE,
    backup: values.STUGA_BACKUP_IMAGE,
    tapo: values.STUGA_TAPO_RUNNER_IMAGE,
    updateAgent: values.STUGA_UPDATE_AGENT_IMAGE,
    mqtt: values.STUGA_MQTT_IMAGE,
    nexus433: values.STUGA_NEXUS433_IMAGE,
  };
}

function legacyReleaseImages(values) {
  return {
    api: values.STUGA_API_IMAGE,
    web: values.STUGA_WEB_IMAGE,
    backup: values.STUGA_BACKUP_IMAGE,
    tapo: values.STUGA_TAPO_RUNNER_IMAGE,
    updateAgent: values.STUGA_UPDATE_AGENT_IMAGE,
  };
}

function isExpectedLegacyTagImage(config, name, version, value) {
  if (typeof value !== "string" || !(name in releaseImageSuffixes)) return false;
  return value === `${config.imagePrefix}-${releaseImageSuffixes[name]}:v${version}`;
}

export function validatedReleaseEnvironment(text, config, label = "release environment") {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 8 * 1024) {
    throw new Error(`${label} is missing or too large`);
  }
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const currentValues = releaseEnvironmentValues(lines, releaseEnvironmentKeys, label);
  const legacyValues = currentValues
    ? null
    : releaseEnvironmentValues(lines, legacyReleaseEnvironmentKeys, label);
  const values = currentValues ?? legacyValues;
  if (!values) throw new Error(`${label} does not use a supported release environment schema`);
  const version = values.STUGA_VERSION;
  if (
    typeof version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
  ) throw new Error(`${label} contains an invalid release version`);
  const images = legacyValues ? legacyReleaseImages(values) : releaseImages(values);

  if (legacyValues) {
    if (Object.entries(images).some(
      ([name, image]) => !isExpectedLegacyTagImage(config, name, version, image),
    )) {
      throw new Error(`${label} contains an untrusted legacy image reference`);
    }
    return {
      format: "legacy-v1",
      version,
      compatibility: null,
      images,
    };
  }

  if (
    values.STUGA_RELEASE_ENV_SCHEMA !== RELEASE_ENV_SCHEMA
    || values.STUGA_UPDATE_AGENT_CONTRACT !== String(UPDATE_AGENT_CONTRACT)
    || values.STUGA_COMPOSE_CONTRACT !== String(COMPOSE_CONTRACT)
  ) {
    throw new Error(`${label} is incompatible with this updater or Compose contract`);
  }
  if (Object.entries(images).some(([name, image]) => !isExpectedDigestImage(config, name, version, image))) {
    throw new Error(`${label} contains an untrusted or mutable image reference`);
  }
  return {
    format: "v3",
    version,
    compatibility: {
      updateAgent: UPDATE_AGENT_CONTRACT,
      compose: COMPOSE_CONTRACT,
    },
    images,
  };
}

export function readReleaseEnvironment(path, config, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  if (!lstatSync(path).isFile()) throw new Error(`${label} must be a regular file`);
  const text = readFileSync(path, "utf8");
  return {
    path,
    text,
    ...validatedReleaseEnvironment(text, config, label),
  };
}

export function currentReleaseEnvironment(config) {
  for (const [path, label] of [
    [config.releaseEnvFile, "candidate release environment"],
    [config.knownGoodReleaseEnvFile, "known-good release environment"],
    [config.factoryReleaseEnvFile, "factory release environment"],
  ]) {
    if (existsSync(path)) return readReleaseEnvironment(path, config, label);
  }
  throw new Error("No immutable current release environment is available; refusing an update without rollback state");
}

export function releaseEnvironmentFiles(config) {
  const paths = [
    [config.factoryReleaseEnvFile, "factory release environment"],
    [config.knownGoodReleaseEnvFile, "known-good release environment"],
    [config.releaseEnvFile, "candidate release environment"],
  ];
  return paths.flatMap(([path, label]) => {
    if (!existsSync(path)) return [];
    readReleaseEnvironment(path, config, label);
    return [path];
  });
}

export function composeArguments(config) {
  const args = ["compose"];
  if (config.composeProjectName) args.push("--project-name", config.composeProjectName);
  const localEnv = join(config.projectDirectory, ".env");
  if (existsSync(localEnv)) args.push("--env-file", localEnv);
  for (const releaseEnv of releaseEnvironmentFiles(config)) {
    args.push("--env-file", releaseEnv);
  }
  args.push("--file", join(config.projectDirectory, "docker-compose.yml"));
  return args;
}

export async function compose(config, args, timeoutMs = UPDATE_TIMEOUT_MS) {
  return runCommand("docker", [...composeArguments(config), ...args], {
    cwd: config.projectDirectory,
    timeoutMs,
  });
}

export function operation(request, phase, detail, startedAt, phaseStartedAt, activity, completedAt = null) {
  return {
    id: request.id,
    version: request.version,
    tagName: request.tagName,
    phase,
    requestedAt: request.requestedAt,
    startedAt,
    completedAt,
    updatedAt: phaseStartedAt,
    phaseStartedAt,
    detail,
    previousVersion: request.previousVersion,
    activity: activity.slice(-50),
  };
}
