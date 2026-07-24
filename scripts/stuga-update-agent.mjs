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

const AGENT_VERSION = "1.0.0";
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
    child.stderr.on("data", append);
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

function pendingRequest(config) {
  return readdirSync(config.operationsDirectory)
    .filter((name) => /^request-.*\.json$/.test(name))
    .sort()
    .map((name) => join(config.operationsDirectory, name))[0] ?? null;
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
    const requestPath = pendingRequest(config);
    if (!requestPath) return false;
    const lock = acquireLock(config);
    if (!lock) return false;
    try {
      await applyRequest(config, requestPath);
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
