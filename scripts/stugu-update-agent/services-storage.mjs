import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import {
  bounded,
  compose,
  readJson,
  removeFileDurable,
  runCommand,
  writeJson,
  writeTextAtomic,
  writeTextDurableAtomic,
} from "./configuration-request.mjs";
import { activeServices, exactApiVersion } from "./services-cloudflare.mjs";

export const STORAGE_REQUEST_SCHEMA = "stugu-storage-request/v1";
export const STORAGE_STATUS_SCHEMA = "stugu-storage-status/v1";
export const STORAGE_JOURNAL_SCHEMA = "stugu-storage-journal/v1";
export const STORAGE_JOURNAL_NAME = "storage-journal.json";

const DEFAULT_SOURCES = {
  timeseries: "stuga-timeseries-data",
  backups: "stuga-scheduled-backups",
};
const SOURCE_KEYS = {
  timeseries: "STUGA_TIMESERIES_DATA_SOURCE",
  backups: "STUGA_SCHEDULED_BACKUP_SOURCE",
};
const KIND_KEYS = {
  timeseries: "STUGA_TIMESERIES_STORAGE_KIND",
  backups: "STUGA_SCHEDULED_BACKUP_STORAGE_KIND",
};
const BACKUP_TARGET_ID_KEY = "STUGA_SCHEDULED_BACKUP_TARGET_ID";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JOURNAL_PHASES = new Set([
  "prepared",
  "mutation-active",
  "services-stopped",
  "timeseries-copied",
  "backups-copied",
  "settings-written",
  "verified",
  "rolling-back",
  "manual-intervention",
]);

function cloneSettings(settings) {
  return {
    timeseries: { ...settings.timeseries },
    backups: { ...settings.backups },
  };
}

export function storageRevision(settings) {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

function safeHostPath(value) {
  return typeof value === "string" && value.length >= 4 && value.length <= 500
    && value === value.trim()
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/u.test(value))
    && !/[\u0000-\u001f\u007f\s`$"'{}#=]/u.test(value)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)
    && value !== "/" && !/^[A-Za-z]:[\\/]?$/u.test(value);
}

function normalizedPath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function withinAllowedRoot(path, roots) {
  const candidate = normalizedPath(path);
  return roots.some((root) => {
    const allowed = normalizedPath(root);
    return candidate.startsWith(`${allowed}/`) && candidate !== allowed;
  });
}

function allowedRootFor(path, roots) {
  const candidate = normalizedPath(path);
  return roots
    .filter((root) => candidate.startsWith(`${normalizedPath(root)}/`))
    .sort((left, right) => normalizedPath(right).length - normalizedPath(left).length)[0] ?? null;
}

function validatedLocation(value, purpose, allowedRoots) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => key !== "kind" && key !== "path")) {
    throw new Error(`${purpose} storage is invalid`);
  }
  if (value.kind === "managed") {
    if (value.path !== null) throw new Error(`Managed ${purpose} storage cannot contain a path`);
    return { kind: "managed", path: null };
  }
  if ((value.kind !== "local-path" && value.kind !== "nas-path")
    || (purpose === "timeseries" && value.kind !== "local-path")
    || !safeHostPath(value.path)
    || !withinAllowedRoot(value.path, allowedRoots)) {
    throw new Error(`${purpose} storage path is outside the host storage allowlist or unsafe`);
  }
  // Host-installed agents can close symlink escapes before Docker sees the
  // path. Containerized agents additionally use create_host_path=false and
  // verify the daemon-reported mount after service recreation.
  if (existsSync(value.path)) {
    if (lstatSync(value.path).isSymbolicLink()
      || normalizedPath(realpathSync(value.path)) !== normalizedPath(resolve(value.path))) {
      throw new Error(`${purpose} storage path must not contain symbolic links`);
    }
  }
  return { kind: value.kind, path: value.path };
}

export function validatedStorageSettings(value, allowedRoots) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => key !== "timeseries" && key !== "backups")) {
    throw new Error("Storage settings are invalid");
  }
  const settings = {
    timeseries: validatedLocation(value.timeseries, "timeseries", allowedRoots),
    backups: validatedLocation(value.backups, "backups", allowedRoots),
  };
  if (settings.timeseries.path && settings.backups.path) {
    const timeseries = normalizedPath(settings.timeseries.path);
    const backups = normalizedPath(settings.backups.path);
    if (timeseries === backups || timeseries.startsWith(`${backups}/`) || backups.startsWith(`${timeseries}/`)) {
      throw new Error("Telemetry and recovery sets require separate directories");
    }
  }
  return settings;
}

function environmentDocument(config) {
  const path = config.composeProfileEnvironmentFile;
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error("The persistent Compose environment file is unavailable");
  }
  const metadata = statSync(path);
  if (metadata.size > 256 * 1024) throw new Error("The persistent Compose environment file is unexpectedly large");
  const source = readFileSync(path, "utf8");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const values = new Map();
  for (const [index, line] of lines.entries()) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    if (values.has(match[1])) throw new Error(`${match[1]} must be configured at most once`);
    const raw = match[2].trim();
    if (raw.startsWith("\"") || raw.startsWith("'") || raw.endsWith("\"") || raw.endsWith("'")) {
      throw new Error(`${match[1]} must use an unquoted value`);
    }
    values.set(match[1], { value: raw, index });
  }
  return { path, metadata, source, newline, lines, values };
}

function locationFromEnvironment(document, purpose, allowedRoots) {
  const source = document.values.get(SOURCE_KEYS[purpose])?.value || DEFAULT_SOURCES[purpose];
  const configuredKind = document.values.get(KIND_KEYS[purpose])?.value || "";
  if (source === DEFAULT_SOURCES[purpose]) return { kind: "managed", path: null };
  const kind = configuredKind || "local-path";
  return validatedLocation({ kind, path: source }, purpose, allowedRoots);
}

export function readStorageConfiguration(config) {
  const document = environmentDocument(config);
  const settings = {
    timeseries: locationFromEnvironment(document, "timeseries", config.storageAllowedRoots),
    backups: locationFromEnvironment(document, "backups", config.storageAllowedRoots),
  };
  return {
    document,
    settings,
    revision: storageRevision(settings),
    backupTargetId: document.values.get(BACKUP_TARGET_ID_KEY)?.value || null,
  };
}

function environmentValue(location, purpose) {
  return location.kind === "managed" ? DEFAULT_SOURCES[purpose] : location.path;
}

function setDocumentValue(document, key, value) {
  const entry = document.values.get(key);
  if (entry) {
    document.lines[entry.index] = `${key}=${value}`;
    return;
  }
  if (document.lines.length > 0 && document.lines.at(-1) !== "") document.lines.push("");
  document.lines.push(`${key}=${value}`);
}

export function writeStorageConfiguration(config, settings, backupTargetId = null) {
  const normalized = validatedStorageSettings(settings, config.storageAllowedRoots);
  if (backupTargetId !== null && backupTargetId !== "" && !UUID_PATTERN.test(backupTargetId)) {
    throw new Error("Backup storage target id is invalid");
  }
  const document = environmentDocument(config);
  setDocumentValue(document, SOURCE_KEYS.timeseries, environmentValue(normalized.timeseries, "timeseries"));
  setDocumentValue(document, KIND_KEYS.timeseries, normalized.timeseries.kind);
  setDocumentValue(document, SOURCE_KEYS.backups, environmentValue(normalized.backups, "backups"));
  setDocumentValue(document, KIND_KEYS.backups, normalized.backups.kind);
  setDocumentValue(document, BACKUP_TARGET_ID_KEY, normalized.backups.kind === "managed" ? "" : backupTargetId ?? "");
  const next = `${document.lines.join(document.newline)}${document.newline}`;
  if (next !== document.source) {
    writeTextDurableAtomic(document.path, next, document.metadata.mode & 0o777, document.metadata);
  }
  return normalized;
}

export function validatedStorageRequest(value, config) {
  if (!value || typeof value !== "object" || value.schema !== STORAGE_REQUEST_SCHEMA
    || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)
    || typeof value.requestedAt !== "string" || !Number.isFinite(Date.parse(value.requestedAt))
    || typeof value.expectedRevision !== "string" || !/^[0-9a-f]{64}$/u.test(value.expectedRevision)
    || Object.keys(value).some((key) => !["schema", "id", "requestedAt", "expectedRevision", "previous", "target"].includes(key))) {
    throw new Error("Unsupported storage request");
  }
  const previous = validatedStorageSettings(value.previous, config.storageAllowedRoots);
  const target = validatedStorageSettings(value.target, config.storageAllowedRoots);
  if (value.expectedRevision !== storageRevision(previous)) throw new Error("Storage request revision is invalid");
  return {
    id: value.id,
    requestedAt: new Date(value.requestedAt).toISOString(),
    expectedRevision: value.expectedRevision,
    previous,
    target,
  };
}

function operation(request, phase, detail, startedAt = null, completedAt = null) {
  return {
    id: request.id,
    phase,
    requestedAt: request.requestedAt,
    startedAt,
    completedAt,
    updatedAt: new Date().toISOString(),
    detail,
    previous: cloneSettings(request.previous),
    target: cloneSettings(request.target),
  };
}

function statusPath(config) {
  return join(config.operationsDirectory, "storage-status.json");
}

function journalPath(config) {
  return join(config.operationsDirectory, STORAGE_JOURNAL_NAME);
}

function writeStatus(config, settings, operationValue, configurationError = null) {
  writeJson(statusPath(config), {
    schema: STORAGE_STATUS_SCHEMA,
    settings,
    revision: storageRevision(settings),
    allowedRoots: config.storageAllowedRoots,
    configurationError,
    updatedAt: new Date().toISOString(),
    operation: operationValue,
  });
}

export function publishStorageStatus(config) {
  const existing = readJson(statusPath(config));
  try {
    const current = readStorageConfiguration(config);
    writeStatus(config, current.settings, existing?.operation ?? null);
  } catch (error) {
    writeStatus(
      config,
      existing?.settings ?? {
        timeseries: { kind: "managed", path: null },
        backups: { kind: "managed", path: null },
      },
      existing?.operation ?? null,
      error instanceof Error ? bounded(error.message) : "Storage configuration is invalid",
    );
  }
}

function sourceFor(location, purpose) {
  return location.kind === "managed" ? DEFAULT_SOURCES[purpose] : location.path;
}

function changed(request, purpose) {
  return JSON.stringify(request.previous[purpose]) !== JSON.stringify(request.target[purpose]);
}

function copyRequired(request, purpose) {
  return sourceFor(request.previous[purpose], purpose) !== sourceFor(request.target[purpose], purpose);
}

function volume(location, purpose, target, readOnly = false) {
  return {
    type: location.kind === "managed" ? "volume" : "bind",
    source: sourceFor(location, purpose),
    target,
    read_only: readOnly,
    ...(location.kind === "managed" ? {} : { bind: { create_host_path: false } }),
  };
}

function assertHelperMounts(inspected, expectedVolumes) {
  for (const expected of expectedVolumes) {
    const actual = inspected?.Mounts?.find((entry) => entry.Destination === expected.target);
    if (!actual || actual.RW !== !expected.read_only) {
      throw new Error(`Storage helper mount ${expected.target} is unavailable or has unsafe access`);
    }
    if (expected.type === "bind") {
      if (actual.Type !== "bind" || normalizedPath(actual.Source ?? "") !== normalizedPath(expected.source)) {
        throw new Error(`Storage helper mount ${expected.target} did not resolve to the allowed host path`);
      }
    } else if (actual.Type !== "volume"
      || (actual.Name !== expected.source && !actual.Name?.endsWith(`_${expected.source}`))) {
      throw new Error(`Storage helper mount ${expected.target} did not resolve to the managed volume`);
    }
  }
}

async function inspectContainer(commandRunner, containerId) {
  const output = await commandRunner("docker", ["inspect", containerId], { timeoutMs: 30_000 });
  const inspected = JSON.parse(output)?.[0];
  if (!inspected) throw new Error("Storage helper container inspection failed");
  return inspected;
}

async function stopHelperContainer(commandRunner, containerId) {
  try {
    await commandRunner("docker", ["kill", containerId], { timeoutMs: 30_000 });
  } catch {
    // A helper which already exited makes docker kill fail; inspect below is authoritative.
  }
  try {
    return (await inspectContainer(commandRunner, containerId)).State?.Running === false;
  } catch {
    return false;
  }
}

async function runStorageHelper(
  config,
  composeCommand,
  request,
  command,
  volumes,
  dependencies,
) {
  const overridePath = join(config.operationsDirectory, `storage-helper-${request.id}-${randomUUID()}.json`);
  writeTextAtomic(overridePath, `${JSON.stringify({
    services: { "stugu-storage-helper": { command, volumes } },
  }, null, 2)}\n`, 0o600);
  const commandRunner = dependencies.runCommand ?? runCommand;
  let containerId = null;
  let mayRemove = false;
  try {
    const prefix = [
      "--file", overridePath,
      "--profile", "maintenance",
    ];
    await composeCommand(config, [...prefix, "rm", "--force", "--stop", "stugu-storage-helper"], 120_000);
    await composeCommand(config, [
      ...prefix,
      "create", "--force-recreate", "--no-build", "stugu-storage-helper",
    ], 180_000);
    containerId = (await composeCommand(config, [...prefix, "ps", "-q", "stugu-storage-helper"], 30_000)).trim();
    if (!/^[a-f0-9]{12,64}$/iu.test(containerId)) throw new Error("Storage helper container is unavailable");
    mayRemove = true;
    assertHelperMounts(await inspectContainer(commandRunner, containerId), volumes);
    try {
      await commandRunner("docker", ["start", containerId], { timeoutMs: 30_000 });
      const exitCode = (await commandRunner("docker", ["wait", containerId], { timeoutMs: 24 * 60 * 60_000 })).trim();
      const output = await commandRunner("docker", ["logs", containerId], { timeoutMs: 30_000 });
      if (!/^\d+$/u.test(exitCode) || Number(exitCode) !== 0) {
        throw new Error(`Storage helper exited ${exitCode || "unexpectedly"}${output ? `: ${bounded(output)}` : ""}`);
      }
      return output ? JSON.parse(output) : null;
    } catch (error) {
      const stopped = await stopHelperContainer(commandRunner, containerId);
      mayRemove = stopped;
      if (error && typeof error === "object") error.processTreeTerminated = stopped;
      throw error;
    }
  } finally {
    if (containerId && mayRemove) {
      try {
        await commandRunner("docker", ["rm", "--force", containerId], { timeoutMs: 30_000 });
      } catch {
        // A stopped helper is harmless and the next invocation removes it through Compose.
      }
    }
    rmSync(overridePath, { force: true });
  }
}

async function validateHostLocation(config, composeCommand, request, location, dependencies) {
  const root = allowedRootFor(location.path, config.storageAllowedRoots);
  if (!root) throw new Error("Storage path is outside the host storage allowlist");
  const relativePath = relative(root, location.path).replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("../") || relativePath.includes("/../")) {
    throw new Error("Storage path cannot be the allowlist root or escape it");
  }
  await runStorageHelper(
    config,
    composeCommand,
    request,
    ["validate-host-path", request.id, location.kind, relativePath],
    [{
      type: "bind",
      source: root,
      target: "/allowed-root",
      read_only: true,
      bind: { create_host_path: false },
    }],
    dependencies,
  );
}

async function helper(
  config,
  composeCommand,
  request,
  action,
  purpose,
  source,
  target,
  dependencies,
  extra = null,
) {
  const volumes = [];
  if (source) volumes.push(volume(source, purpose, "/source", true));
  if (target) volumes.push(volume(target, purpose, "/target", false));
  return runStorageHelper(
    config,
    composeCommand,
    request,
    [action, request.id, action === "probe" ? target.kind : purpose, ...(extra ? [extra] : [])],
    volumes,
    dependencies,
  );
}

async function verifiedPreMoveBackup(config, composeCommand) {
  const output = await composeCommand(config, [
    "--profile", "maintenance", "run", "--rm", "--no-deps", "stugu-backup",
  ], 24 * 60 * 60_000);
  const match = /Verified backup created:\s+(\/app\/backups\/[A-Za-z0-9._-]+)/u.exec(output);
  if (!match) throw new Error("Verified backup did not report its recovery-set path");
  await composeCommand(config, [
    "--profile", "maintenance", "run", "--rm", "--no-deps",
    "--entrypoint", "node", "stugu-backup",
    "/app/scripts/stugu-restore-drill.mjs", match[1],
  ], 24 * 60 * 60_000);
  return basename(match[1]);
}

function writeJournal(config, value) {
  writeTextDurableAtomic(journalPath(config), `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

function validatedJournal(value, request, config) {
  if (!value || value.schema !== STORAGE_JOURNAL_SCHEMA || !JOURNAL_PHASES.has(value.phase)
    || value.requestId !== request.id || !Array.isArray(value.activeServices)
    || value.activeServices.some((entry) => typeof entry !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(entry))
    || value.requestFile !== `storage-request-${request.id}.json`
    || !Number.isSafeInteger(value.rollbackAttempts) || value.rollbackAttempts < 0 || value.rollbackAttempts > 3
    || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new Error("The interrupted storage journal is invalid");
  }
  const previous = validatedStorageSettings(value.previous, config.storageAllowedRoots);
  const target = validatedStorageSettings(value.target, config.storageAllowedRoots);
  if (JSON.stringify(previous) !== JSON.stringify(request.previous)
    || JSON.stringify(target) !== JSON.stringify(request.target)
    || (value.previousBackupTargetId !== null && !UUID_PATTERN.test(value.previousBackupTargetId))
    || (target.backups.kind === "managed"
      ? value.targetBackupTargetId !== null
      : !UUID_PATTERN.test(value.targetBackupTargetId))) {
    throw new Error("The interrupted storage journal does not match its request");
  }
  return { ...value, previous, target };
}

async function stopAffected(config, composeCommand, request, services) {
  const affected = [];
  // A recovery-set worker must never begin pg_dump while TimeDB is being
  // quiesced or copy into a backup target while that target is being moved.
  if (services.includes("stugu-r2-backup")) affected.push("stugu-r2-backup");
  if (services.includes("stugu-backup-scheduler")) affected.push("stugu-backup-scheduler");
  if (copyRequired(request, "timeseries")) affected.push("timescaledb");
  if (affected.length > 0) await composeCommand(config, ["stop", "--timeout", "120", ...affected], 180_000);
}

function parseControl(output) {
  const fields = Object.fromEntries(output.split(/\r?\n/u).flatMap((line) => {
    const separator = line.indexOf(":");
    return separator > 0 ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]] : [];
  }));
  return {
    systemIdentifier: fields["Database system identifier"],
    state: fields["Database cluster state"],
    catalogVersion: fields["Catalog version number"],
  };
}

async function containerMount(config, composeCommand, service, destination, dependencies) {
  const containerId = (await composeCommand(config, ["ps", "-q", service], 30_000)).trim();
  if (!/^[a-f0-9]{12,64}$/iu.test(containerId)) throw new Error(`${service} container is unavailable`);
  const commandRunner = dependencies.runCommand ?? runCommand;
  const output = await commandRunner("docker", ["inspect", containerId], { timeoutMs: 30_000 });
  const inspected = JSON.parse(output);
  const mount = inspected?.[0]?.Mounts?.find((entry) => entry.Destination === destination);
  if (!mount) throw new Error(`${service} does not use the expected storage mount`);
  return mount;
}

function assertMount(location, mount) {
  if (location.kind === "managed") {
    if (mount.Type !== "volume") throw new Error("The running service did not use its managed storage volume");
    return;
  }
  if (mount.Type !== "bind" || normalizedPath(mount.Source ?? "") !== normalizedPath(location.path)) {
    throw new Error("The running service did not use the selected host storage path");
  }
}

async function startAndVerify(config, composeCommand, request, journal, dependencies) {
  if (copyRequired(request, "timeseries")) {
    await composeCommand(config, ["up", "--detach", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "600", "timescaledb"], 660_000);
    const mount = await containerMount(config, composeCommand, "timescaledb", "/var/lib/postgresql/data", dependencies);
    assertMount(request.target.timeseries, mount);
    const control = parseControl(await composeCommand(config, ["exec", "-T", "timescaledb", "pg_controldata", "/var/lib/postgresql/data"], 30_000));
    if (!journal.timeseriesControl?.systemIdentifier
      || control.systemIdentifier !== journal.timeseriesControl.systemIdentifier
      || control.catalogVersion !== journal.timeseriesControl.catalogVersion
      || control.state !== "in production") {
      throw new Error("The restarted TimescaleDB did not preserve the copied database identity");
    }
  }
  await composeCommand(config, ["up", "--detach", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "180", "api"], 240_000);
  if (changed(request, "timeseries")) {
    assertMount(
      request.target.timeseries,
      await containerMount(config, composeCommand, "api", "/app/timeseries-data", dependencies),
    );
  }
  if (changed(request, "backups")) {
    assertMount(
      request.target.backups,
      await containerMount(config, composeCommand, "api", "/app/backups", dependencies),
    );
  }
  const apiVersion = (await exactApiVersion(config, composeCommand)).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(apiVersion)) throw new Error("The recreated API did not report a valid version");
  const backupServices = journal.activeServices.filter((service) => service === "stugu-backup-scheduler" || service === "stugu-r2-backup");
  for (const service of backupServices) {
    await composeCommand(config, [
      "up", "--detach", "--no-deps",
      ...(changed(request, "backups") ? ["--force-recreate"] : []),
      service,
    ], 180_000);
  }
  if (changed(request, "backups")) {
    for (const service of backupServices) {
      const mount = await containerMount(config, composeCommand, service, "/app/backups", dependencies);
      assertMount(request.target.backups, mount);
    }
  }
}

async function rollback(config, composeCommand, request, journal, dependencies, failure) {
  const nextJournal = { ...journal, phase: "rolling-back", rollbackAttempts: journal.rollbackAttempts + 1, updatedAt: new Date().toISOString() };
  writeJournal(config, nextJournal);
  writeStatus(config, request.previous, operation(request, "rolling-back", "Restoring the previous storage configuration", journal.startedAt));
  try {
    writeStorageConfiguration(config, request.previous, journal.previousBackupTargetId ?? null);
    if (copyRequired(request, "timeseries")) {
      await composeCommand(config, ["up", "--detach", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "600", "timescaledb"], 660_000);
    }
    await composeCommand(config, ["up", "--detach", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "180", "api"], 240_000);
    for (const service of nextJournal.activeServices.filter((entry) => entry === "stugu-backup-scheduler" || entry === "stugu-r2-backup")) {
      await composeCommand(config, ["up", "--detach", "--no-deps", "--force-recreate", service], 180_000);
    }
    await exactApiVersion(config, composeCommand);
    await composeCommand(config, ["--profile", "maintenance", "rm", "--force", "--stop", "stugu-storage-helper"], 120_000);
    if (copyRequired(request, "timeseries")) {
      await helper(config, composeCommand, request, "reset", "timeseries", null, request.target.timeseries, dependencies);
    }
    if (copyRequired(request, "backups")) {
      await helper(config, composeCommand, request, "reset", "backups", null, request.target.backups, dependencies);
    }
    const completedAt = new Date().toISOString();
    writeStatus(config, request.previous, operation(request, "failed", `Storage change failed and was rolled back: ${bounded(failure)}`, journal.startedAt, completedAt));
    removeFileDurable(journalPath(config));
    removeFileDurable(join(config.operationsDirectory, journal.requestFile));
  } catch (rollbackError) {
    const detail = `Storage change failed (${bounded(failure)}); rollback needs operator attention (${bounded(rollbackError instanceof Error ? rollbackError.message : String(rollbackError))})`;
    if (nextJournal.rollbackAttempts >= 3) {
      writeJournal(config, { ...nextJournal, phase: "manual-intervention", detail, updatedAt: new Date().toISOString() });
      writeStatus(config, request.previous, operation(request, "manual-intervention", detail, journal.startedAt));
      return;
    }
    writeStatus(config, request.previous, operation(request, "rolling-back", detail, journal.startedAt));
  }
}

export async function applyStorageRequest(config, requestPath, dependencies = {}) {
  const composeCommand = dependencies.compose ?? compose;
  const rawJournal = readJson(journalPath(config));
  const raw = rawJournal?.request ?? (requestPath ? readJson(requestPath) : null);
  const fallbackSettings = () => {
    try {
      return readStorageConfiguration(config).settings;
    } catch {
      return cloneSettings({
        timeseries: { kind: "managed", path: null },
        backups: { kind: "managed", path: null },
      });
    }
  };
  let request;
  try {
    request = validatedStorageRequest(raw, config);
  } catch (error) {
    const completedAt = new Date().toISOString();
    const fallback = fallbackSettings();
    const detail = error instanceof Error ? bounded(error.message) : "Storage request is invalid";
    if (rawJournal) {
      writeJournal(config, {
        ...(typeof rawJournal === "object" && rawJournal ? rawJournal : {}),
        schema: STORAGE_JOURNAL_SCHEMA,
        phase: "manual-intervention",
        detail: `Interrupted storage request is invalid; operator recovery is required: ${detail}`,
        updatedAt: completedAt,
      });
    }
    writeStatus(config, fallback, {
      id: typeof raw?.id === "string" ? raw.id : randomUUID(),
      phase: rawJournal ? "manual-intervention" : "failed",
      requestedAt: typeof raw?.requestedAt === "string" ? raw.requestedAt : completedAt,
      startedAt: null,
      completedAt: rawJournal ? null : completedAt,
      updatedAt: completedAt,
      detail,
      previous: fallback,
      target: fallback,
    });
    if (requestPath && !rawJournal) removeFileDurable(requestPath);
    return;
  }

  let journal;
  try {
    journal = rawJournal ? validatedJournal(rawJournal, request, config) : null;
  } catch (error) {
    const detail = `Interrupted storage journal is invalid; operator recovery is required: ${bounded(error instanceof Error ? error.message : String(error))}`;
    const updatedAt = new Date().toISOString();
    writeJournal(config, { ...rawJournal, schema: STORAGE_JOURNAL_SCHEMA, phase: "manual-intervention", detail, updatedAt });
    const fallback = fallbackSettings();
    writeStatus(config, fallback, operation(request, "manual-intervention", detail));
    return;
  }
  const startedAt = journal?.startedAt ?? new Date().toISOString();
  const setPhase = (phase, detail) => writeStatus(
    config,
    phase === "complete" ? request.target : request.previous,
    operation(
      request,
      phase,
      detail,
      startedAt,
      phase === "complete" || phase === "failed" ? new Date().toISOString() : null,
    ),
  );
  try {
    if (journal?.phase === "manual-intervention") return;
    if (journal?.phase === "rolling-back") {
      await rollback(config, composeCommand, request, journal, dependencies, journal.detail ?? "Interrupted storage change");
      return;
    }
    if (!journal) {
      const current = readStorageConfiguration(config);
      if (current.revision !== request.expectedRevision || JSON.stringify(current.settings) !== JSON.stringify(request.previous)) {
        throw new Error("Storage configuration changed after this request was queued");
      }
      if (copyRequired(request, "backups")
        && request.previous.backups.kind !== "managed"
        && !current.backupTargetId) {
        throw new Error("Configured external backup storage has no mount sentinel; initialize it before moving recovery sets");
      }
      setPhase("validating", "Validating storage mounts and capacity");
      for (const purpose of ["timeseries", "backups"]) {
        const source = request.previous[purpose];
        const target = request.target[purpose];
        if (source.kind !== "managed" && changed(request, purpose)) {
          await validateHostLocation(config, composeCommand, request, source, dependencies);
        }
        if (target.kind !== "managed" && changed(request, purpose)) {
          await validateHostLocation(config, composeCommand, request, target, dependencies);
          await helper(config, composeCommand, request, "probe", purpose, null, target, dependencies);
        }
      }
      if (copyRequired(request, "backups") && request.previous.backups.kind !== "managed") {
        await helper(
          config,
          composeCommand,
          request,
          "source-sentinel",
          "backups",
          request.previous.backups,
          null,
          dependencies,
          current.backupTargetId,
        );
      }
      setPhase("backing-up", "Creating and restore-testing a complete recovery set");
      const backup = await verifiedPreMoveBackup(config, composeCommand);
      const services = await activeServices(config, composeCommand);
      journal = {
        schema: STORAGE_JOURNAL_SCHEMA,
        request,
        requestId: request.id,
        requestFile: basename(requestPath),
        previous: request.previous,
        target: request.target,
        phase: "prepared",
        activeServices: services,
        previousBackupTargetId: current.backupTargetId,
        targetBackupTargetId: request.target.backups.kind === "managed" ? null : randomUUID(),
        verifiedBackup: backup,
        timeseriesControl: null,
        rollbackAttempts: 0,
        startedAt,
        updatedAt: new Date().toISOString(),
      };
      writeJournal(config, journal);
    }

    if (journal.phase === "prepared" || journal.phase === "mutation-active") {
      setPhase("quiescing", "Pausing storage writers and cleanly stopping TimescaleDB when needed");
      journal = { ...journal, phase: "mutation-active", updatedAt: new Date().toISOString() };
      writeJournal(config, journal);
      await stopAffected(config, composeCommand, request, journal.activeServices);
      journal = { ...journal, phase: "services-stopped", updatedAt: new Date().toISOString() };
      writeJournal(config, journal);
    }

    if (journal.phase === "services-stopped") {
      setPhase("copying", "Copying telemetry storage with PostgreSQL identity checks");
      let copyResult = null;
      if (copyRequired(request, "timeseries")) {
        copyResult = await helper(config, composeCommand, request, "copy", "timeseries", request.previous.timeseries, request.target.timeseries, dependencies);
      }
      journal = {
        ...journal,
        phase: "timeseries-copied",
        timeseriesControl: copyResult?.source?.control ?? journal.timeseriesControl,
        updatedAt: new Date().toISOString(),
      };
      writeJournal(config, journal);
    }

    if (journal.phase === "timeseries-copied") {
      if (copyRequired(request, "backups")) {
        setPhase("copying", "Copying verified recovery sets to the selected storage");
        await helper(config, composeCommand, request, "copy", "backups", request.previous.backups, request.target.backups, dependencies);
      }
      journal = { ...journal, phase: "backups-copied", updatedAt: new Date().toISOString() };
      writeJournal(config, journal);
    }

    if (journal.phase === "backups-copied") {
      setPhase("applying", "Applying the persistent storage configuration");
      writeStorageConfiguration(config, request.target, journal.targetBackupTargetId);
      journal = { ...journal, phase: "settings-written", updatedAt: new Date().toISOString() };
      writeJournal(config, journal);
    }

    if (journal.phase === "settings-written") {
      setPhase("verifying", "Starting services and verifying their real mounts and database identity");
      await startAndVerify(config, composeCommand, request, journal, dependencies);
      journal = { ...journal, phase: "verified", updatedAt: new Date().toISOString() };
      writeJournal(config, journal);
    }

    if (journal.phase === "verified") {
      if (copyRequired(request, "timeseries")) {
        await helper(config, composeCommand, request, "complete", "timeseries", null, request.target.timeseries, dependencies);
      }
      if (copyRequired(request, "backups")) {
        await helper(config, composeCommand, request, "complete", "backups", null, request.target.backups, dependencies, journal.targetBackupTargetId);
      } else if (changed(request, "backups") && request.target.backups.kind !== "managed") {
        await helper(config, composeCommand, request, "sentinel", "backups", null, request.target.backups, dependencies, journal.targetBackupTargetId);
      }
      setPhase("complete", "Storage configuration applied and verified");
      removeFileDurable(journalPath(config));
      removeFileDurable(join(config.operationsDirectory, journal.requestFile));
      publishStorageStatus(config);
    }
  } catch (error) {
    const detail = error instanceof Error ? bounded(error.message) : "Storage change failed";
    if (!journal || journal.phase === "prepared") {
      setPhase("failed", detail);
      const effectiveRequestPath = requestPath
        ?? (journal?.requestFile ? join(config.operationsDirectory, journal.requestFile) : null);
      if (effectiveRequestPath) removeFileDurable(effectiveRequestPath);
      if (journal) removeFileDurable(journalPath(config));
      return;
    }
    if (error?.processTreeTerminated === false) {
      const manualDetail = `Storage command termination is uncertain; preserving both locations for operator recovery: ${detail}`;
      writeJournal(config, { ...journal, phase: "manual-intervention", detail: manualDetail, updatedAt: new Date().toISOString() });
      writeStatus(config, fallbackSettings(), operation(request, "manual-intervention", manualDetail, startedAt));
      return;
    }
    await rollback(config, composeCommand, request, journal, dependencies, detail);
  }
}

export function storageJournalNeedsManualIntervention(config) {
  const journal = readJson(journalPath(config));
  return journal?.schema === STORAGE_JOURNAL_SCHEMA && journal.phase === "manual-intervention"
    ? typeof journal.detail === "string" ? journal.detail : "Storage recovery needs operator attention"
    : null;
}
