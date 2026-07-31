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
} from ".././cloudflare-stugu.mjs";

import { revokeAccessToken } from ".././cloudflare-oauth.mjs";

import { AGENT_VERSION, COMPOSE_CONTRACT, HEARTBEAT_MS, POLL_MS, UPDATE_AGENT_CONTRACT, bounded, compose, currentReleaseEnvironment, operation, readAgentConfig, readJson, readReleaseEnvironment, releaseEnvironment, runCommand, validatedRequest, writeJson, writeReleaseEnvironmentAtomic } from "./configuration-request.mjs";

import { activeServices, applyCloudflareSetupRequest, exactApiVersion, restoreReleaseEnvironment } from "./services-cloudflare.mjs";

export const APPLIANCE_UPGRADE_REQUIRED = "appliance-upgrade-required";

export const APPLIANCE_UPGRADE_DETAIL = "This Raspberry Pi still uses the legacy updater boot contract. Create a verified backup, install a factory image with updater contract 2, and restore the backup before installing another container release.";

export function applianceUpdateTransition(config) {
  if (config.runtime !== "raspberry-pi") return null;
  try {
    const factoryRelease = readReleaseEnvironment(
      config.factoryReleaseEnvFile,
      config,
      "factory release environment",
    );
    return factoryRelease.format === "legacy-v1"
      ? { reason: APPLIANCE_UPGRADE_REQUIRED, detail: APPLIANCE_UPGRADE_DETAIL }
      : null;
  } catch {
    return { reason: APPLIANCE_UPGRADE_REQUIRED, detail: APPLIANCE_UPGRADE_DETAIL };
  }
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
    const completedAt = new Date().toISOString();
    writeJson(statusPath, {
      id: typeof raw?.id === "string" ? raw.id : randomUUID(),
      version: typeof raw?.version === "string" ? raw.version : "unknown",
      tagName: typeof raw?.tagName === "string" ? raw.tagName : "unknown",
      phase: "failed",
      requestedAt: typeof raw?.requestedAt === "string" ? raw.requestedAt : startedAt,
      startedAt,
      completedAt,
      updatedAt: completedAt,
      phaseStartedAt: completedAt,
      detail,
      previousVersion: typeof raw?.previousVersion === "string" ? raw.previousVersion : "unknown",
      activity: [{ phase: "failed", at: completedAt, detail }],
    });
    rmSync(requestPath, { force: true });
    return;
  }

  let previousRelease = null;
  let services = [];
  let releaseChanged = false;
  const activity = [{
    phase: "queued",
    at: request.requestedAt,
    detail: "Update requested; waiting for the external update agent",
  }];
  const setStatus = (phase, detail, completedAt = null) => {
    const phaseStartedAt = new Date().toISOString();
    activity.push({ phase, at: phaseStartedAt, detail });
    writeJson(
      statusPath,
      operation(request, phase, detail, startedAt, phaseStartedAt, activity, completedAt),
    );
  };

  try {
    setStatus("preparing", "Checking the running Stugu services and installed version");
    const applianceTransition = applianceUpdateTransition(config);
    if (applianceTransition) throw new Error(applianceTransition.detail);
    const currentRelease = currentReleaseEnvironment(config);
    previousRelease = currentRelease.text;
    if (currentRelease.version !== request.previousVersion) {
      throw new Error(
        `Current release manifest reports ${currentRelease.version} instead of ${request.previousVersion}`,
      );
    }
    services = await activeServices(config, composeCommand);
    const previousVersion = (await exactApiVersion(config, composeCommand)).trim();
    if (previousVersion !== request.previousVersion) {
      throw new Error(
        `Compose target reported version ${previousVersion || "unknown"} instead of ${request.previousVersion}`,
      );
    }

    setStatus("backup", "Creating a verified pre-update backup");
    await composeCommand(
      config,
      ["--profile", "maintenance", "run", "--rm", "--no-deps", "stugu-backup"],
    );

    writeReleaseEnvironmentAtomic(config.releaseEnvFile, releaseEnvironment(request));
    releaseChanged = true;

    setStatus("pulling", `Pulling Stugu ${request.version} images`);
    await composeCommand(config, ["pull", ...services]);

    setStatus("applying", `Starting Stugu ${request.version}`);
    await composeCommand(config, ["up", "--detach", "--no-deps", "--wait", "--wait-timeout", "600", ...services]);

    setStatus("verifying", `Verifying Stugu ${request.version}`);
    const runningVersion = (await exactApiVersion(config, composeCommand)).trim();
    if (runningVersion !== request.version) {
      throw new Error(`Updated API reported version ${runningVersion || "unknown"} instead of ${request.version}`);
    }
    writeReleaseEnvironmentAtomic(config.knownGoodReleaseEnvFile, releaseEnvironment(request));

    const completedAt = new Date().toISOString();
    setStatus("complete", `Stugu ${request.version} is healthy`, completedAt);
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
      if (previousRelease === null) throw new Error("Immutable rollback state was lost");
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

export function pendingWork(config) {
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

export function acquireLock(config) {
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

export function releaseLock(lock) {
  if (!lock) return;
  closeSync(lock.descriptor);
  rmSync(lock.path, { force: true });
}

export function heartbeat(config, ready, detail = null, systemUpdateReason = null) {
  writeJson(join(config.operationsDirectory, "agent-status.json"), {
    schema: "stugu-update-agent/v1",
    runtime: config.runtime,
    agentVersion: AGENT_VERSION,
    updateAgentContract: UPDATE_AGENT_CONTRACT,
    composeContract: COMPOSE_CONTRACT,
    capabilities: ["system-update", "cloudflare-setup"],
    ready,
    detail,
    systemUpdateReason,
    updatedAt: new Date().toISOString(),
  });
}

export async function publishDockerHeartbeat(config) {
  try {
    await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000 });
    const transition = applianceUpdateTransition(config);
    if (transition) {
      heartbeat(config, true, transition.detail, transition.reason);
      return { ready: true, detail: transition.detail };
    }
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
