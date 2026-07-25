#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
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
} from "./cloudflare-stuga.mjs";
import { revokeAccessToken } from "./cloudflare-oauth.mjs";

const AGENT_VERSION = "1.1.0";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT = 16 * 1024;
const POLL_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 45 * 60_000;

function optional(value) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function trustedRepository(value) {
  const repository = optional(value) ?? "liljestk/open-stuga";
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    throw new Error("SYSTEM_UPDATE_REPOSITORY must use owner/repository form");
  }
  return repository;
}

function trustedImagePrefix(value, repository) {
  const prefix = optional(value) ?? `ghcr.io/${repository.toLowerCase()}`;
  if (!/^ghcr\.io\/[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/.test(prefix)) {
    throw new Error("SYSTEM_UPDATE_IMAGE_PREFIX must be a lower-case GHCR image prefix");
  }
  return prefix;
}

function updateRuntime(value) {
  const runtime = optional(value) ?? (existsSync("/etc/stuga-version") ? "raspberry-pi" : "docker");
  if (runtime !== "docker" && runtime !== "raspberry-pi") {
    throw new Error("SYSTEM_UPDATE_RUNTIME must be docker or raspberry-pi");
  }
  return runtime;
}

function optionValue(args, option) {
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
  return {
    projectDirectory,
    operationsDirectory,
    repository,
    imagePrefix: trustedImagePrefix(env.SYSTEM_UPDATE_IMAGE_PREFIX, repository),
    runtime: updateRuntime(env.SYSTEM_UPDATE_RUNTIME),
    releaseEnvFile: resolve(
      projectDirectory,
      optional(env.STUGA_RELEASE_ENV_FILE) ?? ".stuga-release.env",
    ),
    composeProjectName: optional(env.STUGA_COMPOSE_PROJECT_NAME),
    cloudflareSecretDirectory: resolve(
      projectDirectory,
      optional(env.STUGA_CLOUDFLARE_SECRET_DIR) ?? join("secrets", "cloudflare"),
    ),
    once: args.includes("--once"),
  };
}

function readJson(path) {
  if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeTextAtomic(path, text, mode = 0o640) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8", mode });
  renameSync(temporary, path);
}

function writeJson(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o644);
}

function bounded(text) {
  if (text.length <= MAX_COMMAND_OUTPUT) return text;
  return text.slice(text.length - MAX_COMMAND_OUTPUT);
}

export async function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk) => { output = bounded(output + chunk.toString("utf8")); };
    child.stdout.on("data", append);
    if (!options.ignoreStderr) child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectCommand(new Error(`${command} timed out`));
    }, options.timeoutMs ?? UPDATE_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectCommand(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveCommand(output.trim());
      else rejectCommand(new Error(`${command} exited ${code ?? signal ?? "unexpectedly"}${output.trim() ? `: ${output.trim()}` : ""}`));
    });
  });
}

function expectedImages(config, tagName) {
  return {
    api: `${config.imagePrefix}-api:${tagName}`,
    web: `${config.imagePrefix}-web:${tagName}`,
    backup: `${config.imagePrefix}-backup:${tagName}`,
    tapo: `${config.imagePrefix}-tapo-export-runner:${tagName}`,
    updateAgent: `${config.imagePrefix}-update-agent:${tagName}`,
  };
}

export function validatedRequest(value, config) {
  if (!value || typeof value !== "object" || value.schema !== "stuga-system-update-request/v1") {
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
  ) throw new Error("Update request contains invalid release identity");
  const images = expectedImages(config, value.tagName);
  if (!value.images || Object.entries(images).some(([name, expected]) => value.images[name] !== expected)) {
    throw new Error("Update request attempted to override the trusted image namespace");
  }
  return {
    id: value.id,
    version: value.version,
    tagName: value.tagName,
    requestedAt: new Date(value.requestedAt).toISOString(),
    previousVersion: value.previousVersion,
    images,
  };
}

function validatedCloudflareHostname(value, label) {
  const hostname = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new Error(`${label} is invalid`);
  }
  return hostname;
}

export function validatedCloudflareSetupRequest(value) {
  if (!value || typeof value !== "object" || value.schema !== "stuga-cloudflare-setup-request/v1") {
    throw new Error("Unsupported Cloudflare setup request");
  }
  const mode = value.mode;
  const command = value.command;
  const hostname = validatedCloudflareHostname(value.hostname, "Stuga address");
  const zone = validatedCloudflareHostname(value.zone, "Cloudflare zone");
  if (
    typeof value.id !== "string"
    || !/^[0-9a-f-]{36}$/i.test(value.id)
    || (mode !== "remote-ui" && mode !== "stugby-coordinator")
    || command !== (mode === "stugby-coordinator" ? "provision-coordinator" : "provision")
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

function releaseEnvironment(request) {
  return [
    `STUGA_VERSION=${request.version}`,
    `STUGA_API_IMAGE=${request.images.api}`,
    `STUGA_WEB_IMAGE=${request.images.web}`,
    `STUGA_BACKUP_IMAGE=${request.images.backup}`,
    `STUGA_TAPO_RUNNER_IMAGE=${request.images.tapo}`,
    `STUGA_UPDATE_AGENT_IMAGE=${request.images.updateAgent}`,
    "",
  ].join("\n");
}

export function composeArguments(config) {
  const args = ["compose"];
  if (config.composeProjectName) args.push("--project-name", config.composeProjectName);
  const localEnv = join(config.projectDirectory, ".env");
  if (existsSync(localEnv)) args.push("--env-file", localEnv);
  if (existsSync(config.releaseEnvFile)) args.push("--env-file", config.releaseEnvFile);
  args.push("--file", join(config.projectDirectory, "docker-compose.yml"));
  return args;
}

async function compose(config, args, timeoutMs = UPDATE_TIMEOUT_MS) {
  return runCommand("docker", [...composeArguments(config), ...args], {
    cwd: config.projectDirectory,
    timeoutMs,
  });
}

function operation(request, phase, detail, startedAt, completedAt = null) {
  return {
    id: request.id,
    version: request.version,
    tagName: request.tagName,
    phase,
    requestedAt: request.requestedAt,
    startedAt,
    completedAt,
    detail,
    previousVersion: request.previousVersion,
  };
}

async function activeServices(config, composeCommand = compose) {
  const output = await composeCommand(config, ["ps", "--services", "--filter", "status=running"], 30_000);
  const active = new Set(output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  const missing = ["api", "web"].filter((service) => !active.has(service));
  if (missing.length > 0) {
    const selected = config.composeProjectName
      ? ` "${config.composeProjectName}"`
      : " derived from the project directory";
    throw new Error(`Compose project${selected} is not the running Stuga installation (missing ${missing.join(", ")})`);
  }
  const services = ["api", "web"];
  if (active.has("stuga-backup-scheduler")) services.push("stuga-backup-scheduler");
  if (active.has("tapo-export-runner")) services.push("tapo-export-runner");
  return services;
}

async function exactApiVersion(config, composeCommand = compose) {
  const script = "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>r.json()).then(x=>process.stdout.write(String(x.systemVersion||'')))";
  return composeCommand(config, ["exec", "-T", "api", "node", "-e", script], 30_000);
}

function cloudflareOperation(request, phase, detail, completedAt = null) {
  return {
    id: request.id,
    mode: request.mode,
    hostname: request.hostname,
    phase,
    requestedAt: request.requestedAt,
    completedAt,
    detail,
  };
}

async function claimCloudflareSetup(config, request) {
  const claimScript = [
    "const secret=process.env.STUGA_CLOUDFLARE_CLAIM_SECRET||'';",
    `fetch('http://127.0.0.1:8787/api/v1/internal/cloudflare-setup/claims/${request.id}',`,
    "{headers:{authorization:'Bearer '+secret},signal:AbortSignal.timeout(15000)})",
    ".then(async response=>{const text=await response.text();if(!response.ok)throw new Error('HTTP '+response.status);process.stdout.write(text)})",
    ".catch(error=>{process.stderr.write(String(error.message||error));process.exitCode=1})",
  ].join("");
  const output = await runCommand("docker", [
    ...composeArguments(config),
    "exec",
    "-T",
    "-e",
    `STUGA_CLOUDFLARE_CLAIM_SECRET=${request.claimSecret}`,
    "api",
    "node",
    "-e",
    claimScript,
  ], {
    cwd: config.projectDirectory,
    timeoutMs: 30_000,
    ignoreStderr: true,
  });
  let claim;
  try { claim = JSON.parse(output); } catch {
    throw new Error("The API did not return a valid in-memory Cloudflare setup claim");
  }
  if (!claim || claim.schema !== "stuga-cloudflare-setup-claim/v1"
    || claim.oauthClientId !== request.oauthClientId) {
    throw new Error("The Cloudflare setup claim did not match the queued operation");
  }
  return {
    provisionToken: validateCloudflareToken(claim.provisionToken, "Temporary Cloudflare OAuth approval"),
    accessToken: validateCloudflareToken(claim.accessToken, "Runtime Access token"),
    oauthClientId: claim.oauthClientId,
  };
}

async function verifyCloudflareWithRetry(config, request, dependencies) {
  const verifier = request.mode === "stugby-coordinator"
    ? dependencies.verifyCoordinator ?? verifyCloudflareCoordinator
    : dependencies.verifyDeployment ?? verifyCloudflareDeployment;
  const waitForRetry = dependencies.waitForRetry
    ?? ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)));
  let lastError = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      return await verifier(
        { secretDirectory: config.cloudflareSecretDirectory },
        { logger: { log: () => undefined } },
      );
    } catch (error) {
      lastError = error;
      if (attempt < 12) await waitForRetry(5_000);
    }
  }
  throw lastError ?? new Error("Cloudflare verification failed");
}

export async function applyCloudflareSetupRequest(config, requestPath, dependencies = {}) {
  const composeCommand = dependencies.compose ?? compose;
  const provisioner = dependencies.provisioner ?? provisionCloudflare;
  const claimer = dependencies.claim ?? claimCloudflareSetup;
  const revoker = dependencies.revoke ?? revokeAccessToken;
  const statusPath = join(config.operationsDirectory, "cloudflare-status.json");
  const raw = readJson(requestPath);
  let request;
  try {
    request = validatedCloudflareSetupRequest(raw);
  } catch (error) {
    const completedAt = new Date().toISOString();
    writeJson(statusPath, {
      id: typeof raw?.id === "string" ? raw.id : randomUUID(),
      mode: raw?.mode === "remote-ui" ? "remote-ui" : "stugby-coordinator",
      hostname: typeof raw?.hostname === "string" ? raw.hostname : "invalid.example",
      phase: "failed",
      requestedAt: typeof raw?.requestedAt === "string" ? raw.requestedAt : completedAt,
      completedAt,
      detail: error instanceof Error ? bounded(error.message) : "Invalid Cloudflare setup request",
    });
    rmSync(requestPath, { force: true });
    return;
  }

  const setStatus = (phase, detail, completedAt = null) => writeJson(
    statusPath,
    cloudflareOperation(request, phase, detail, completedAt),
  );
  let claim = null;
  let finalPhase = "failed";
  let finalDetail = "Cloudflare setup did not complete";
  try {
    setStatus("provisioning", "Configuring the secure Cloudflare connection");
    claim = await claimer(config, request);
    await provisioner({
      command: request.command,
      hostname: request.hostname,
      zone: request.zone,
      ownerEmail: request.ownerEmail,
      accountId: request.accountId,
      zoneId: request.zoneId,
      secretDirectory: config.cloudflareSecretDirectory,
      provisionTokenFile: null,
      accessTokenFile: null,
      oauthClientId: request.oauthClientId,
      oauthRedirectUri: request.oauthRedirectUri,
    }, {
      provisionToken: claim.provisionToken,
      accessToken: claim.accessToken,
      composeCommand: "docker compose",
      logger: { log: () => undefined },
      printGuidance: false,
    });

    setStatus("applying", "Restarting Stuga with the secure connection");
    await composeCommand(config, [
      "up",
      "--detach",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "600",
      "api",
      "web",
      "cloudflared",
    ]);

    setStatus("verifying", "Checking every public and protected path");
    await verifyCloudflareWithRetry(config, request, dependencies);
    finalPhase = "complete";
    finalDetail = `Secure connection verified at https://${request.hostname}`;
  } catch (error) {
    finalDetail = error instanceof Error ? bounded(error.message) : "Cloudflare setup failed";
    if (!claim) {
      finalDetail = `${finalDetail} Stuga could not confirm approval revocation; revoke Stuga Setup from the Cloudflare OAuth authorizations page.`;
    }
    try { await composeCommand(config, ["stop", "cloudflared"], 30_000); } catch { /* Keep the original failure. */ }
  }

  if (claim) {
    try {
      await revoker({
        accessToken: claim.provisionToken,
        clientId: claim.oauthClientId,
      });
    } catch {
      finalDetail = `${finalDetail} Cloudflare did not confirm approval revocation; revoke Stuga Setup from the Cloudflare OAuth authorizations page.`;
    }
  }
  setStatus(finalPhase, finalDetail, new Date().toISOString());
  claim = null;
  rmSync(requestPath, { force: true });
}

async function restoreReleaseEnvironment(path, previous) {
  if (previous === null) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  writeTextAtomic(path, previous);
}

export async function applyRequest(config, requestPath, dependencies = {}) {
  const composeCommand = dependencies.compose ?? compose;
  const statusPath = join(config.operationsDirectory, "status.json");
  const raw = readJson(requestPath);
  const startedAt = new Date().toISOString();
  let request;
  try {
    request = validatedRequest(raw, config);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid update request";
    writeJson(statusPath, {
      id: typeof raw?.id === "string" ? raw.id : randomUUID(),
      version: typeof raw?.version === "string" ? raw.version : "unknown",
      tagName: typeof raw?.tagName === "string" ? raw.tagName : "unknown",
      phase: "failed",
      requestedAt: typeof raw?.requestedAt === "string" ? raw.requestedAt : startedAt,
      startedAt,
      completedAt: startedAt,
      detail,
      previousVersion: typeof raw?.previousVersion === "string" ? raw.previousVersion : "unknown",
    });
    rmSync(requestPath, { force: true });
    return;
  }

  const previousRelease = existsSync(config.releaseEnvFile) ? readFileSync(config.releaseEnvFile, "utf8") : null;
  let services = [];
  let releaseChanged = false;
  const setStatus = (phase, detail, completedAt = null) => writeJson(
    statusPath,
    operation(request, phase, detail, startedAt, completedAt),
  );

  try {
    services = await activeServices(config, composeCommand);
    const previousVersion = (await exactApiVersion(config, composeCommand)).trim();
    if (previousVersion !== request.previousVersion) {
      throw new Error(
        `Compose target reported version ${previousVersion || "unknown"} instead of ${request.previousVersion}`,
      );
    }

    setStatus("backup", "Creating a verified pre-update backup");
    await composeCommand(config, ["--profile", "maintenance", "run", "--rm", "stuga-backup"]);

    writeTextAtomic(config.releaseEnvFile, releaseEnvironment(request));
    releaseChanged = true;

    setStatus("pulling", `Pulling Stuga ${request.version} images`);
    await composeCommand(config, ["pull", ...services]);

    setStatus("applying", `Starting Stuga ${request.version}`);
    await composeCommand(config, ["up", "--detach", "--no-deps", "--wait", "--wait-timeout", "600", ...services]);

    setStatus("verifying", `Verifying Stuga ${request.version}`);
    const runningVersion = (await exactApiVersion(config, composeCommand)).trim();
    if (runningVersion !== request.version) {
      throw new Error(`Updated API reported version ${runningVersion || "unknown"} instead of ${request.version}`);
    }

    const completedAt = new Date().toISOString();
    setStatus("complete", `Stuga ${request.version} is healthy`, completedAt);
    rmSync(requestPath, { force: true });
  } catch (error) {
    const failure = error instanceof Error ? bounded(error.message) : "The update failed";
    if (!releaseChanged) {
      setStatus("failed", failure, new Date().toISOString());
      rmSync(requestPath, { force: true });
      return;
    }
    setStatus("rolling-back", "The new release was unhealthy; restoring the previous image set");
    try {
      await restoreReleaseEnvironment(config.releaseEnvFile, previousRelease);
      await composeCommand(config, ["up", "--detach", "--no-deps", "--wait", "--wait-timeout", "600", ...services]);
      setStatus("failed", `${failure} Previous release restored.`, new Date().toISOString());
    } catch (rollbackError) {
      const rollback = rollbackError instanceof Error ? bounded(rollbackError.message) : "rollback failed";
      setStatus("failed", `${failure} Rollback also failed: ${rollback}`, new Date().toISOString());
    }
    rmSync(requestPath, { force: true });
  }
}

function pendingWork(config) {
  const name = readdirSync(config.operationsDirectory)
    .filter((candidate) => /^(?:request-|cloudflare-request-).*\.json$/.test(candidate))
    .sort()
    .find(Boolean);
  if (!name) return null;
  return {
    kind: name.startsWith("cloudflare-request-") ? "cloudflare" : "update",
    path: join(config.operationsDirectory, name),
  };
}

function acquireLock(config) {
  const path = join(config.operationsDirectory, "agent.lock");
  try {
    const descriptor = openSync(path, "wx", 0o640);
    writeFileSync(descriptor, `${process.pid} ${new Date().toISOString()}\n`);
    return { path, descriptor };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const age = Date.now() - statSync(path).mtimeMs;
    if (age <= 2 * 60 * 60_000) return null;
    rmSync(path, { force: true });
    const descriptor = openSync(path, "wx", 0o640);
    writeFileSync(descriptor, `${process.pid} ${new Date().toISOString()}\n`);
    return { path, descriptor };
  }
}

function releaseLock(lock) {
  if (!lock) return;
  closeSync(lock.descriptor);
  rmSync(lock.path, { force: true });
}

function heartbeat(config, ready, detail = null) {
  writeJson(join(config.operationsDirectory, "agent-status.json"), {
    schema: "stuga-update-agent/v1",
    runtime: config.runtime,
    agentVersion: AGENT_VERSION,
    capabilities: ["system-update", "cloudflare-setup"],
    ready,
    detail,
    updatedAt: new Date().toISOString(),
  });
}

async function publishDockerHeartbeat(config) {
  try {
    await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000 });
    heartbeat(config, true);
    return { ready: true, detail: null };
  } catch (error) {
    const detail = error instanceof Error ? bounded(error.message) : "Docker is unavailable";
    heartbeat(config, false, detail);
    return { ready: false, detail };
  }
}

export async function main() {
  const config = readAgentConfig();
  mkdirSync(config.operationsDirectory, { recursive: true });
  let availability = await publishDockerHeartbeat(config);
  while (!availability.ready) {
    if (config.once) throw new Error(availability.detail);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, HEARTBEAT_MS));
    availability = await publishDockerHeartbeat(config);
  }

  const heartbeatTimer = setInterval(
    () => void publishDockerHeartbeat(config).catch(() => undefined),
    HEARTBEAT_MS,
  );
  heartbeatTimer.unref?.();
  const processOne = async () => {
    const work = pendingWork(config);
    if (!work) return false;
    const lock = acquireLock(config);
    if (!lock) return false;
    try {
      if (work.kind === "cloudflare") await applyCloudflareSetupRequest(config, work.path);
      else await applyRequest(config, work.path);
    } finally {
      releaseLock(lock);
      await publishDockerHeartbeat(config);
    }
    return true;
  };

  if (config.once) {
    await processOne();
    clearInterval(heartbeatTimer);
    return;
  }
  for (;;) {
    await processOne();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
