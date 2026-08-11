#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateDoctorReceipt } from "./tooling/receipt-contracts.mjs";
import { targetSelectorSha256, validateSshTarget } from "./tooling/ssh-target.mjs";
import {
  ToolFailure,
  appendLog,
  assertOutsideRepository,
  canonicalJson,
  failureText,
  logPathFor,
  runIdentifier,
  runLogged,
  sha256,
  stateDirectory,
  writeJsonReceipt,
} from "./tooling/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const remoteCollectorPath = resolve(root, "scripts/tooling/rpi-doctor-remote.py");

function usage() {
  return `Read-only diagnosis of one Stugu Raspberry Pi over one SSH session.

Usage:
  npm run rpi:doctor -- --target USER@HOST [--deep] [--json[=PATH]]

Default collection is bounded to 14 seconds. --deep adds integrity checks and
bounded log analysis. Receipts and logs stay outside Git. --json prints the
receipt; --json=PATH writes an additional outside-worktree copy.
`;
}

function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function parseArguments(argv) {
  const options = { deep: false, help: false, json: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      options.target = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--deep") {
      options.deep = true;
    } else if (argument === "--json") {
      const candidate = argv[index + 1];
      if (candidate && !candidate.startsWith("--")) {
        options.json = candidate;
        index += 1;
      } else {
        options.json = "-";
      }
    } else if (argument.startsWith("--json=")) {
      options.json = argument.slice("--json=".length) || "-";
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.help && !options.target) throw new Error("--target is required");
  if (options.target) validateSshTarget(options.target);
  return options;
}

export { targetSelectorSha256 } from "./tooling/ssh-target.mjs";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percent(part, total) {
  return total > 0 ? Number(((part / total) * 100).toFixed(1)) : null;
}

function check(id, status, summary) {
  return { id, status, summary: String(summary).slice(0, 500) };
}

export function diagnoseEvidence(evidence) {
  if (!evidence || evidence.schema !== "stugu-rpi-doctor-evidence/v1") {
    throw new Error("remote evidence schema is invalid");
  }
  const checks = [];
  const identity = evidence.identity ?? {};
  const identityValid = /^[0-9a-f]{64}$/u.test(identity.machineIdSha256 ?? "")
    && /^[0-9a-f]{64}$/u.test(identity.hostnameSha256 ?? "")
    && /^sha256:[0-9a-f]{64}$/u.test(identity.hardwareFingerprint ?? "");
  checks.push(check(
    "IDENTITY",
    identityValid ? "pass" : "fail",
    identityValid ? "Machine, host, and appliance hardware identities were captured." : "Appliance identity is incomplete.",
  ));

  const service = evidence.service ?? {};
  const serviceHealthy = service.available
    && service.ActiveState === "active"
    && ["running", "exited"].includes(service.SubState)
    && number(service.ExecMainStatus) === 0;
  checks.push(check(
    "SERVICE",
    serviceHealthy ? "pass" : "fail",
    service.available
      ? `stugu.service is ${service.ActiveState ?? "unknown"}/${service.SubState ?? "unknown"}; ${number(service.NRestarts)} restart(s).`
      : "stugu.service state is unavailable.",
  ));

  const health = evidence.health ?? {};
  checks.push(check(
    "HEALTH",
    health.available && health.status === "ok" && health.database === "ready" ? "pass" : "fail",
    health.available
      ? `API health is ${health.status ?? "unknown"}; database is ${health.database ?? "unknown"}.`
      : "The local unauthenticated API health endpoint is unavailable.",
  ));

  const containers = Array.isArray(evidence.docker?.containers) ? evidence.docker.containers : [];
  const stopped = containers.filter((item) => item.state !== "running");
  const completed = stopped.filter((item) => (
    item.restartPolicy === "no" && number(item.exitCode, -1) === 0
  ) || /^Exited \(0\)(?:\s|$)/iu.test(item.status ?? ""));
  const unexpectedlyStopped = stopped.filter((item) => !completed.includes(item));
  const unhealthy = containers.filter((item) => item.health === "unhealthy");
  const restarts = containers.reduce((sum, item) => sum + number(item.restartCount), 0);
  const containerStatus = !evidence.docker?.available || containers.length === 0
    || unhealthy.length > 0 || unexpectedlyStopped.length > 0
    ? "fail"
    : restarts > 5 ? "warning" : "pass";
  checks.push(check(
    "CONTAINERS",
    containerStatus,
    `${containers.length} container(s); ${unexpectedlyStopped.length} unexpectedly stopped, ${completed.length} completed one-shot, ${unhealthy.length} unhealthy, ${restarts} restart(s).`,
  ));

  const system = evidence.system ?? {};
  const memoryAvailablePercent = percent(number(system.memoryAvailableBytes), number(system.memoryTotalBytes));
  const rootAvailablePercent = percent(number(system.rootAvailableBytes), number(system.rootTotalBytes));
  const persistentAvailablePercent = percent(
    number(system.persistentAvailableBytes),
    number(system.persistentTotalBytes),
  );
  const rootFilesystemType = typeof system.rootFilesystemType === "string"
    ? system.rootFilesystemType.toLowerCase() : null;
  const persistentFilesystemType = typeof system.persistentFilesystemType === "string"
    ? system.persistentFilesystemType.toLowerCase() : null;
  const rootImmutable = rootFilesystemType === "erofs";
  const storageAvailablePercent = rootImmutable ? persistentAvailablePercent : rootAvailablePercent;
  const storageReadOnly = rootImmutable ? system.persistentReadOnly === true : system.rootReadOnly === true;
  const loadPerCpu = number(system.loadAverage?.[0]) / Math.max(1, number(system.cpuCount, 1));
  const resourcesStatus = storageReadOnly
    ? "fail"
    : memoryAvailablePercent === null || storageAvailablePercent === null
    ? "warning"
    : memoryAvailablePercent < 5 || storageAvailablePercent < 5 ? "fail"
      : memoryAvailablePercent < 10 || storageAvailablePercent < 10 || loadPerCpu > 1.5 ? "warning" : "pass";
  const storageSummary = rootImmutable
    ? `immutable EROFS root; persistent storage ${persistentAvailablePercent ?? "?"}% available${storageReadOnly ? " and read-only" : ""}`
    : `root storage ${rootAvailablePercent ?? "?"}% available${storageReadOnly ? " and read-only" : ""}`;
  checks.push(check(
    "RESOURCES",
    resourcesStatus,
    `Memory ${memoryAvailablePercent ?? "?"}% available; ${storageSummary}; 1m load/core ${loadPerCpu.toFixed(2)}.`,
  ));

  const eventLoopLagMs = number(health.eventLoopLagMs, -1);
  checks.push(check(
    "EVENT_LOOP",
    eventLoopLagMs < 0 ? "warning" : eventLoopLagMs >= 1_000 ? "fail" : eventLoopLagMs >= 250 ? "warning" : "pass",
    eventLoopLagMs < 0 ? "Event-loop delay is unavailable." : `Event-loop delay is ${eventLoopLagMs} ms.`,
  ));

  const archive = health.telemetryArchive ?? {};
  const archiveFailed = archive.required === true
    && (!archive.timescaleAvailable || ["degraded", "stopped"].includes(archive.phase));
  const archiveWarning = archive.enabled === true
    && (!archive.timescaleAvailable || archive.caughtUp === false || archive.schemaWarningCount > 0);
  const databaseAvailable = evidence.database?.available === true;
  checks.push(check(
    "ARCHIVE_DATABASE",
    archiveFailed ? "fail" : !databaseAvailable || archiveWarning ? "warning" : "pass",
    `Archive ${archive.phase ?? "unknown"}, caught up ${archive.caughtUp ?? "unknown"}; bounded database status ${databaseAvailable ? "available" : "unavailable"}.`,
  ));

  const queues = evidence.database?.queues ?? {};
  // Dead-lettered notifications are terminal history retained for operator
  // inspection. They are not pending work and must not make an otherwise
  // healthy appliance fail its release-readiness check.
  const queueFailed = number(queues.tapoExports?.needsAttention) > 0;
  const queueWarning = Object.values(queues).some((item) => item?.capped === true);
  checks.push(check(
    "QUEUES",
    !databaseAvailable ? "warning" : queueFailed ? "fail" : queueWarning ? "warning" : "pass",
    databaseAvailable
      ? `Alert ${number(queues.alertEvaluation?.count)}, notification ${number(queues.notifications?.count)}, Tapo export ${number(queues.tapoExports?.count)} pending; ${number(queues.notifications?.deadLettered)} notification dead-lettered (counts cap at 100).`
      : "Queue status is unavailable.",
  ));

  const integrations = evidence.database?.integrations;
  checks.push(check(
    "INTEGRATIONS",
    integrations ? "pass" : "warning",
    integrations
      ? `HA metrics ${number(integrations.homeAssistantMetrics)}, TP-Link metrics ${number(integrations.tpLinkMetrics)}, heat pumps ${number(integrations.heatPumpConnections)}, connected devices ${number(integrations.connectedDevices)} (counts cap at 100).`
      : "Bounded integration status is unavailable.",
  ));

  const updater = evidence.updater ?? {};
  const updaterPhase = updater.status?.phase ?? "unknown";
  const badUpdaterPhases = new Set(["failed", "recovery-needed", "rolled-back", "rollback-failed"]);
  const activeUpdaterPhases = new Set(["installing", "ready-to-restart", "restarting", "verifying"]);
  checks.push(check(
    "UPDATER",
    !updater.available || badUpdaterPhases.has(updaterPhase) ? "fail" : activeUpdaterPhases.has(updaterPhase) ? "warning" : "pass",
    updater.available ? `Host updater/controller phase is ${updaterPhase}.` : "Host updater/controller state is unavailable.",
  ));

  const versions = evidence.versions ?? {};
  const applicationVersion = health.systemVersion ?? null;
  const recordedVersion = versions.release?.version ?? null;
  const versionFailed = !applicationVersion || (recordedVersion && recordedVersion !== applicationVersion) || versions.release?.failed_version;
  checks.push(check(
    "VERSIONS",
    versionFailed ? "fail" : versions.host ? "pass" : "warning",
    `Host ${versions.host ?? "unknown"}; application ${applicationVersion ?? "unknown"}; recorded release ${recordedVersion ?? "unknown"}.`,
  ));

  if (evidence.deep) {
    const integrity = evidence.database?.integrity;
    const integrityPassed = integrity?.quickCheck?.length === 1
      && integrity.quickCheck[0] === "ok" && number(integrity.foreignKeyViolations) === 0;
    checks.push(check(
      "INTEGRITY",
      integrityPassed ? "pass" : "fail",
      integrity
        ? `SQLite quick check ${integrity.quickCheck?.[0] ?? "failed"}; ${number(integrity.foreignKeyViolations)} foreign-key violation(s).`
        : "Deep database integrity evidence is unavailable.",
    ));
    checks.push(check(
      "LOGS",
      evidence.logs?.available ? "pass" : "warning",
      evidence.logs?.available
        ? `${Object.values(evidence.logs.priorities ?? {}).reduce((sum, value) => sum + number(value), 0)} bounded service log record(s) summarized.`
        : "Bounded service log summary is unavailable.",
    ));
  }

  const result = checks.some((item) => item.status === "fail")
    ? "failed" : checks.some((item) => item.status === "warning") ? "attention" : "healthy";
  const integrationSummary = integrations ? {
    homeAssistantMetrics: number(integrations.homeAssistantMetrics),
    tpLinkMetrics: number(integrations.tpLinkMetrics),
    heatPumpConnections: number(integrations.heatPumpConnections),
    connectedDevices: number(integrations.connectedDevices),
    externalGateways: Array.isArray(integrations.externalGateways) ? integrations.externalGateways.length : 0,
    externalGatewaysEnabled: Array.isArray(integrations.externalGateways)
      ? integrations.externalGateways.filter((gateway) => gateway?.enabled === true).length : 0,
    capped: Boolean(integrations.sourceMetricsCapped
      || integrations.heatPumpConnectionsCapped
      || integrations.connectedDevicesCapped
      || integrations.externalGatewaysCapped),
  } : null;
  return {
    result,
    checks,
    summary: {
      versions: { host: versions.host ?? null, application: applicationVersion, recordedRelease: recordedVersion },
      containers: {
        total: containers.length,
        stopped: unexpectedlyStopped.length,
        completedOneShot: completed.length,
        unhealthy: unhealthy.length,
        restarts,
      },
      resources: {
        memoryAvailablePercent,
        rootAvailablePercent,
        persistentAvailablePercent,
        storageAvailablePercent,
        rootFilesystemType,
        persistentFilesystemType,
        rootImmutable,
        storageReadOnly,
        loadPerCpu: Number(loadPerCpu.toFixed(2)),
        eventLoopLagMs,
      },
      archive: {
        phase: archive.phase ?? null,
        caughtUp: archive.caughtUp ?? null,
        queuedSamples: number(archive.queuedSamples),
        dirtyRows: number(archive.dirtyRows),
      },
      queues: databaseAvailable ? queues : null,
      integrations: integrationSummary,
      updater: { phase: updaterPhase },
    },
  };
}

export function hostKeyFingerprint(stderr) {
  const matches = [...stderr.matchAll(/Server host key:\s+\S+\s+(SHA256:[A-Za-z0-9+/=]{20,})/gu)];
  return matches.at(-1)?.[1] ?? null;
}

export function sanitizeSshLogLine(line, source) {
  if (source === "stdout") return null;
  const safe = /Server host key:|Permission denied|Could not resolve|Connection (?:timed out|refused|closed)|Host key verification failed|REMOTE HOST IDENTIFICATION|No route to host|Network is unreachable|kex_exchange_identification|sign_and_send_pubkey|Load key|no such identity|Bad configuration option/iu;
  if (!safe.test(line)) return null;
  return String(line)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[REDACTED IP]")
    .replace(/\[[0-9A-Fa-f:.%]+\]/gu, "[REDACTED ADDRESS]")
    .replace(/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"']+/giu, "[REDACTED PATH]")
    .replace(/\/(?:home|Users)\/[^\s"']+/gu, "[REDACTED PATH]");
}

function receiptOutputPath(env, selectorSha256) {
  return join(
    stateDirectory(root, env),
    "receipts",
    "rpi-doctor",
    selectorSha256,
    `${runIdentifier()}-stugu-rpi-doctor.json`,
  );
}

function outputCopyPath(path) {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  return assertOutsideRepository(absolute, root, "--json output");
}

function printSummary(receipt, print = console.log) {
  const counts = { pass: 0, warning: 0, fail: 0 };
  for (const item of receipt.checks) counts[item.status] += 1;
  print(`Raspberry Pi: ${receipt.result} (${counts.pass} pass, ${counts.warning} warning, ${counts.fail} fail)`);
  for (const item of receipt.checks.filter((value) => value.status !== "pass")) {
    print(`- ${item.id}: ${item.summary}`);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const logPath = logPathFor(root, "rpi-doctor", env);
  try {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    appendLog(logPath, `${error instanceof Error ? error.stack : String(error)}\n`);
    throw new ToolFailure(
      "RPI_DOCTOR_USAGE",
      error instanceof Error ? error.message : String(error),
      "npm run rpi:doctor -- --target USER@HOST",
      logPath,
    );
  }
  if (options.help) {
    console.log(usage());
    return null;
  }

  const selectorSha256 = targetSelectorSha256(options.target);
  const [targetUser, targetHost] = options.target.includes("@")
    ? options.target.split("@", 2)
    : [null, options.target];
  const remoteScript = readFileSync(remoteCollectorPath, "utf8");
  const startedAt = Date.now();
  const ssh = env.STUGU_SSH_BIN?.trim() || "ssh";
  const sshArguments = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ConnectionAttempts=1",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=1",
    "-v",
    options.target,
    "python3", "-", ...(options.deep ? ["--deep"] : []),
  ];
  const connection = await (dependencies.runRemote ?? runLogged)({
    command: ssh,
    args: sshArguments,
    displayCommand: `ssh [REDACTED TARGET] python3 -${options.deep ? " --deep" : ""}`,
    cwd: root,
    input: remoteScript,
    logPath,
    timeoutMs: options.deep ? 30_000 : 14_000,
    capture: true,
    sanitizeLogLine: sanitizeSshLogLine,
    sensitiveValues: [options.target, targetHost, targetUser],
  });
  appendLog(logPath, "[doctor] Remote output was not stored verbatim.\n");
  if (connection.status !== 0) {
    throw new ToolFailure(
      connection.timedOut ? "RPI_DOCTOR_TIMEOUT" : "RPI_DOCTOR_SSH",
      connection.timedOut ? "The bounded SSH diagnosis timed out." : "The single read-only SSH session failed.",
      options.deep
        ? "Check SSH access and inspect the detailed log, then retry the deep diagnosis."
        : "Check SSH access and the pinned host key, then rerun the same command.",
      logPath,
    );
  }
  const fingerprint = hostKeyFingerprint(connection.stderr);
  if (!fingerprint) {
    throw new ToolFailure(
      "RPI_DOCTOR_HOST_KEY",
      "SSH did not expose the verified server host-key fingerprint.",
      "Confirm OpenSSH is used and the target is present in known_hosts, then rerun the same command.",
      logPath,
    );
  }
  let evidence;
  try {
    evidence = JSON.parse(connection.stdout);
  } catch (error) {
    throw new ToolFailure(
      "RPI_DOCTOR_EVIDENCE",
      "The appliance did not return valid bounded diagnostic evidence.",
      "Inspect the detailed log, confirm Python 3 is installed, then rerun the same command.",
      logPath,
      { cause: error },
    );
  }
  let diagnosis;
  try {
    diagnosis = diagnoseEvidence(evidence);
  } catch (error) {
    throw new ToolFailure(
      "RPI_DOCTOR_EVIDENCE",
      error instanceof Error ? error.message : String(error),
      "Inspect the detailed log, then rerun the same command.",
      logPath,
    );
  }
  const receipt = {
    schema: "stugu-rpi-doctor/v1",
    result: diagnosis.result,
    mode: options.deep ? "deep" : "default",
    collectedAt: evidence.collectedAt,
    durationMs: Date.now() - startedAt,
    target: { selectorSha256, sshHostKeyFingerprint: fingerprint },
    identity: evidence.identity,
    summary: diagnosis.summary,
    checks: diagnosis.checks,
    evidenceSha256: sha256(canonicalJson(evidence)),
  };
  try {
    validateDoctorReceipt(receipt, { selectorSha256 });
  } catch (error) {
    throw new ToolFailure(
      "RPI_DOCTOR_IDENTITY",
      error instanceof Error ? error.message : String(error),
      "Run the deep diagnosis and inspect its detailed log.",
      logPath,
    );
  }
  const written = writeJsonReceipt(receiptOutputPath(env, selectorSha256), receipt);
  const print = options.json === "-" ? console.error : console.log;
  printSummary(receipt, print);
  print(`Receipt: ${written.path}`);
  if (options.json === "-") console.log(JSON.stringify(receipt, null, 2));
  else if (options.json) {
    const copy = writeJsonReceipt(outputCopyPath(options.json), receipt);
    console.log(`JSON copy: ${copy.path}`);
  }
  if (receipt.result === "failed") {
    throw new ToolFailure(
      "RPI_DOCTOR_UNHEALTHY",
      "The appliance has one or more failed health checks.",
      options.deep
        ? "Use the first failed check and detailed log to choose an explicitly authorized repair."
        : "npm run rpi:doctor -- --target <same-target> --deep",
      logPath,
    );
  }
  return { receipt, path: written.path };
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    appendLog(logPath, `${error instanceof Error ? error.stack : String(error)}\n`);
    throw new ToolFailure(
      "RPI_DOCTOR_INTERNAL",
      error instanceof Error ? error.message : String(error),
      "Inspect the detailed log, then rerun the same read-only diagnosis.",
      logPath,
      { cause: error },
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(failureText(error, {
      code: "RPI_DOCTOR_FAILED",
      next: "npm run rpi:doctor -- --target USER@HOST --deep",
    }));
    process.exitCode = 1;
  });
}
