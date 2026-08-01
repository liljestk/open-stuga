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

import { basename, dirname, join, resolve } from "node:path";

import process from "node:process";

import { pathToFileURL } from "node:url";

import {
  provision as provisionCloudflare,
  validateToken as validateCloudflareToken,
  verifyCoordinator as verifyCloudflareCoordinator,
  verifyDeployment as verifyCloudflareDeployment,
} from ".././cloudflare-stugu.mjs";

import { revokeAccessToken } from ".././cloudflare-oauth.mjs";

import { AGENT_VERSION, COMPOSE_CONTRACT, HEARTBEAT_MS, POLL_MS, RELEASE_MANIFEST_SCHEMA, UPDATE_AGENT_CONTRACT, UPDATE_REQUEST_SCHEMA, bounded, compose, currentReleaseEnvironment, operation, readAgentConfig, readJson, readReleaseEnvironment, releaseEnvironment, removeFileDurable, runCommand, validatedReleaseEnvironment, validatedRequest, writeJson, writeReleaseEnvironmentAtomic, writeTextDurableAtomic } from "./configuration-request.mjs";

import { activeServices, applyCloudflareSetupRequest, exactApiVersion, restoreReleaseEnvironment } from "./services-cloudflare.mjs";
import { applySourceProfileRequest } from "./services-source-profiles.mjs";

export const APPLIANCE_UPGRADE_REQUIRED = "appliance-upgrade-required";

export const APPLIANCE_UPGRADE_DETAIL = "This Raspberry Pi uses an older updater boot contract. Create a verified backup, install a factory image with updater contract 3, and restore the backup before installing another container release.";

export const UPDATE_JOURNAL_SCHEMA = "stugu-system-update-journal/v1";

const UPDATE_JOURNAL_NAME = "update-journal.json";
const UPDATE_JOURNAL_PHASES = new Set([
  "prepared",
  "verified",
  "mutation-active",
  "termination-uncertain",
]);
const UPDATE_MUTATION_NAMES = new Set([
  "backup",
  "candidate-pull",
  "candidate-start",
  "candidate-reconcile",
  "rollback",
]);
const UPDATE_SERVICE_NAMES = new Set([
  "api",
  "web",
  "stugu-backup-scheduler",
  "stugu-r2-backup",
  "tapo-export-runner",
  "mqtt",
  "nexus433",
]);

export function updateJournalPath(config) {
  return join(config.operationsDirectory, UPDATE_JOURNAL_NAME);
}

export function updateJournal(
  config,
  request,
  requestPath,
  previousRelease,
  services,
  phase = "prepared",
  mutation = null,
) {
  const durableRequest = {
    schema: UPDATE_REQUEST_SCHEMA,
    ...request,
    repository: config.repository,
    releaseManifestSchema: RELEASE_MANIFEST_SCHEMA,
  };
  return {
    schema: UPDATE_JOURNAL_SCHEMA,
    request: durableRequest,
    requestFile: basename(requestPath),
    requestId: request.id,
    version: request.version,
    previousVersion: request.previousVersion,
    previousRelease,
    services,
    phase,
    mutation,
    updatedAt: new Date().toISOString(),
  };
}

export function writeUpdateJournal(config, journal) {
  writeTextDurableAtomic(
    updateJournalPath(config),
    `${JSON.stringify(journal, null, 2)}\n`,
    0o600,
  );
}

export function validatedUpdateJournal(raw, config, request) {
  if (!raw || raw.schema !== UPDATE_JOURNAL_SCHEMA || !UPDATE_JOURNAL_PHASES.has(raw.phase)) {
    throw new Error("The interrupted update journal is invalid");
  }
  if (
    raw.requestId !== request.id
    || raw.version !== request.version
    || raw.previousVersion !== request.previousVersion
  ) {
    throw new Error("The interrupted update journal does not match its update request");
  }
  if (
    typeof raw.requestFile !== "string"
    || !/^request-[A-Za-z0-9._-]+\.json$/u.test(raw.requestFile)
  ) {
    throw new Error("The interrupted update journal contains an invalid request filename");
  }
  if (
    !Array.isArray(raw.services)
    || raw.services.length < 2
    || raw.services[0] !== "api"
    || raw.services[1] !== "web"
    || new Set(raw.services).size !== raw.services.length
    || raw.services.some((service) => !UPDATE_SERVICE_NAMES.has(service))
  ) {
    throw new Error("The interrupted update journal contains invalid Compose services");
  }
  const mutation = raw.mutation ?? null;
  if (
    (mutation !== null && !UPDATE_MUTATION_NAMES.has(mutation))
    || (raw.phase === "mutation-active" && mutation === null)
    || ((raw.phase === "prepared" || raw.phase === "verified") && mutation !== null)
  ) {
    throw new Error("The interrupted update journal contains an invalid mutation state");
  }
  const rollback = validatedReleaseEnvironment(
    raw.previousRelease,
    config,
    "interrupted update rollback environment",
  );
  if (rollback.version !== request.previousVersion) {
    throw new Error("The interrupted update journal contains the wrong rollback version");
  }
  return {
    ...raw,
    request,
    previousRelease: raw.previousRelease,
    services: [...raw.services],
    mutation,
  };
}

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
  const removeDurableFile = dependencies.removeFileDurable ?? removeFileDurable;
  const statusPath = join(config.operationsDirectory, "status.json");
  const journalPath = updateJournalPath(config);
  const journalPresent = existsSync(journalPath);
  const rawJournal = journalPresent ? readJson(journalPath) : null;
  const raw = rawJournal?.request ?? (requestPath ? readJson(requestPath) : null);
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
    if (!journalPresent && requestPath) removeDurableFile(requestPath);
    return;
  }

  let previousRelease = null;
  let services = [];
  let journal = null;
  let candidateCommitted = false;
  let releaseMutationStarted = false;
  let effectiveRequestPath = requestPath;
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
  const cleanup = () => {
    if (effectiveRequestPath) removeDurableFile(effectiveRequestPath);
    // The journal is deliberately removed last. If the process dies between
    // these removals, its embedded validated request can finish recovery.
    removeDurableFile(journalPath);
  };
  const transitionJournal = (phase, mutation = null) => {
    if (!journal) throw new Error("Durable update state is unavailable");
    const next = {
      ...journal,
      phase,
      mutation,
      updatedAt: new Date().toISOString(),
    };
    writeUpdateJournal(config, next);
    journal = next;
  };
  const blockAutomaticRecovery = (failure) => {
    const blockedJournal = {
      ...journal,
      phase: "termination-uncertain",
      updatedAt: new Date().toISOString(),
    };
    writeUpdateJournal(config, blockedJournal);
    journal = blockedJournal;
    setStatus(
      "failed",
      `${failure} Automatic release changes are blocked because a release mutation could not be confirmed quiescent; confirm Docker is idle and complete recovery manually before removing the update journal.`,
      new Date().toISOString(),
    );
  };
  const runComposeMutation = async (args, mutation, safePhase) => {
    transitionJournal("mutation-active", mutation);
    let result;
    try {
      result = await composeCommand(config, args);
    } catch (error) {
      // Killing the Compose CLI cannot prove that an in-flight Docker daemon
      // mutation has quiesced, so every mutation timeout requires manual
      // reconciliation even when the local process tree was terminated.
      if (error?.code === "COMMAND_TIMEOUT" || error?.processTreeTerminated === false) {
        transitionJournal("termination-uncertain", mutation);
      } else {
        transitionJournal(safePhase);
      }
      throw error;
    }
    transitionJournal(safePhase);
    return result;
  };
  const rollback = async (failure, cause = null) => {
    if (
      cause?.processTreeTerminated === false
      || journal?.phase === "mutation-active"
      || journal?.phase === "termination-uncertain"
    ) {
      blockAutomaticRecovery(failure);
      return;
    }
    setStatus("rolling-back", "The interrupted release was not committed; restoring the previous image set");
    try {
      if (!journal) throw new Error("Durable rollback state was lost");
      await restoreReleaseEnvironment(config.releaseEnvFile, journal.previousRelease);
      await runComposeMutation(
        ["up", "--detach", "--no-deps", "--wait", "--wait-timeout", "600", ...journal.services],
        "rollback",
        "prepared",
      );
      setStatus("failed", `${failure} Previous release restored.`, new Date().toISOString());
      cleanup();
    } catch (rollbackError) {
      const detail = rollbackError instanceof Error ? bounded(rollbackError.message) : "rollback failed";
      if (
        rollbackError?.processTreeTerminated === false
        || journal?.phase === "mutation-active"
        || journal?.phase === "termination-uncertain"
      ) {
        blockAutomaticRecovery(`${failure} Rollback also failed: ${detail}`);
        return;
      }
      setStatus("failed", `${failure} Rollback also failed: ${detail}`, new Date().toISOString());
      // Keep both the request and journal so the next agent start retries the
      // rollback from the durable previous release.
    }
  };

  if (journalPresent) {
    try {
      journal = validatedUpdateJournal(rawJournal, config, request);
      effectiveRequestPath = join(config.operationsDirectory, journal.requestFile);
    } catch (error) {
      const detail = error instanceof Error ? bounded(error.message) : "The interrupted update journal is invalid";
      setStatus("failed", detail, new Date().toISOString());
      return;
    }

    if (journal.phase === "mutation-active" || journal.phase === "termination-uncertain") {
      const mutation = journal.mutation ? ` (${journal.mutation})` : "";
      setStatus(
        "failed",
        `Automatic rollback remains blocked because a prior release mutation${mutation} could not be confirmed quiescent. Confirm Docker is idle and reconcile the requested or previous release before removing the update journal.`,
        new Date().toISOString(),
      );
      return;
    }

    if (journal.phase === "verified") {
      try {
        setStatus("verifying", `Resuming verification of interrupted Stugu ${request.version}`);
        const expectedRelease = releaseEnvironment(request);
        const candidate = readReleaseEnvironment(
          config.releaseEnvFile,
          config,
          "interrupted candidate release environment",
        );
        if (candidate.text !== expectedRelease) {
          throw new Error("The interrupted candidate release no longer matches its update request");
        }
        await runComposeMutation(
          ["up", "--detach", "--no-deps", "--wait", "--wait-timeout", "600", ...journal.services],
          "candidate-reconcile",
          "verified",
        );
        const runningVersion = (await exactApiVersion(config, composeCommand)).trim();
        if (runningVersion !== request.version) {
          throw new Error(
            `Interrupted candidate API reported ${runningVersion || "unknown"} instead of ${request.version}`,
          );
        }
        writeReleaseEnvironmentAtomic(config.knownGoodReleaseEnvFile, expectedRelease);
        candidateCommitted = true;
        const completedAt = new Date().toISOString();
        setStatus("complete", `Stugu ${request.version} is healthy`, completedAt);
        cleanup();
      } catch (error) {
        // A durable known-good write is the commit boundary. Leave the
        // verified journal for idempotent finalization instead of rolling a
        // committed candidate back because status or cleanup failed.
        if (candidateCommitted) return;
        const failure = error instanceof Error ? bounded(error.message) : "Interrupted update verification failed";
        await rollback(failure, error);
      }
      return;
    }

    await rollback("The update agent restarted before candidate verification completed.");
    return;
  }

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

    const preparedJournal = updateJournal(
      config,
      request,
      effectiveRequestPath,
      previousRelease,
      services,
    );
    writeUpdateJournal(config, preparedJournal);
    journal = preparedJournal;

    setStatus("backup", "Creating a verified pre-update backup");
    await runComposeMutation(
      ["--profile", "maintenance", "run", "--rm", "--no-deps", "stugu-backup"],
      "backup",
      "prepared",
    );

    releaseMutationStarted = true;
    writeReleaseEnvironmentAtomic(config.releaseEnvFile, releaseEnvironment(request));

    setStatus("pulling", `Pulling Stugu ${request.version} images`);
    await runComposeMutation(["pull", ...services], "candidate-pull", "prepared");

    setStatus("applying", `Starting Stugu ${request.version}`);
    await runComposeMutation(
      ["up", "--detach", "--no-deps", "--wait", "--wait-timeout", "600", ...services],
      "candidate-start",
      "prepared",
    );

    setStatus("verifying", `Verifying Stugu ${request.version}`);
    const runningVersion = (await exactApiVersion(config, composeCommand)).trim();
    if (runningVersion !== request.version) {
      throw new Error(`Updated API reported version ${runningVersion || "unknown"} instead of ${request.version}`);
    }
    const verifiedJournal = {
      ...journal,
      phase: "verified",
      mutation: null,
      updatedAt: new Date().toISOString(),
    };
    writeUpdateJournal(config, verifiedJournal);
    journal = verifiedJournal;
    writeReleaseEnvironmentAtomic(config.knownGoodReleaseEnvFile, releaseEnvironment(request));
    candidateCommitted = true;

    const completedAt = new Date().toISOString();
    setStatus("complete", `Stugu ${request.version} is healthy`, completedAt);
    cleanup();
  } catch (error) {
    // Post-commit status and cleanup are retryable from the verified journal;
    // they must never turn a committed healthy release into a rollback.
    if (candidateCommitted) return;
    const failure = error instanceof Error ? bounded(error.message) : "The update failed";
    if (!journal) {
      setStatus("failed", failure, new Date().toISOString());
      if (effectiveRequestPath) removeDurableFile(effectiveRequestPath);
      return;
    }
    if (!releaseMutationStarted && journal.phase === "prepared") {
      setStatus("failed", failure, new Date().toISOString());
      cleanup();
      return;
    }
    await rollback(failure, error);
  }
}

export function pendingWork(config) {
  if (existsSync(updateJournalPath(config))) {
    return { kind: "update", path: null };
  }
  const name = readdirSync(config.operationsDirectory)
    .filter((candidate) => /^(?:request-|cloudflare-request-|source-profile-request-).*\.json$/.test(candidate))
    .sort()
    .find(Boolean);
  if (!name) return null;
  return {
    kind: name.startsWith("cloudflare-request-")
      ? "cloudflare"
      : name.startsWith("source-profile-request-") ? "source-profile" : "update",
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
    capabilities: ["system-update", "cloudflare-setup", "source-profile"],
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
      else if (work.kind === "source-profile") await applySourceProfileRequest(config, work.path);
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
