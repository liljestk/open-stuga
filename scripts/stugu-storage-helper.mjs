#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const SOURCE = "/source";
const TARGET = "/target";
const ALLOWED_ROOT = "/allowed-root";
const MARKER = join(TARGET, ".stugu-storage-copy.json");
const MAX_OUTPUT = 16 * 1024;
const NETWORK_FILESYSTEMS = /^(?:nfs\d*|cifs|smb\d*|fuse(?:\..*)?|sshfs|ceph|glusterfs|lustre|9p|overlay)$/iu;

function command(commandName, args) {
  return execFileSync(commandName, args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
  }).trim();
}

function uuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value ?? "")) {
    throw new Error("Storage operation id is invalid");
  }
  return value;
}

function kind(value) {
  if (value !== "timeseries" && value !== "backups") throw new Error("Storage copy kind is invalid");
  return value;
}

function locationKind(value) {
  if (value !== "local-path" && value !== "nas-path") throw new Error("Storage location kind is invalid");
  return value;
}

function directory(path, label) {
  if (!existsSync(path) || !lstatSync(path).isDirectory() || realpathSync(path) !== path) {
    throw new Error(`${label} is not a canonical directory mount`);
  }
}

function durableText(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, text, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directoryDescriptor = openSync(dirname(path), "r");
  try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
}

function marker() {
  if (!existsSync(MARKER)) return null;
  try { return JSON.parse(readFileSync(MARKER, "utf8")); } catch { return null; }
}

function writeMarker(operationId, copyKind, phase) {
  durableText(MARKER, `${JSON.stringify({
    schema: "stugu-storage-copy/v1",
    operationId,
    kind: copyKind,
    phase,
    updatedAt: new Date().toISOString(),
  })}\n`);
}

function validatedMarker(operationId, copyKind, requiredPhase = null) {
  const value = marker();
  if (!value || value.schema !== "stugu-storage-copy/v1"
    || value.operationId !== operationId || value.kind !== copyKind
    || (value.phase !== "copying" && value.phase !== "complete" && value.phase !== "applied")
    || (requiredPhase && value.phase !== requiredPhase)) {
    throw new Error("Storage target is not owned by this operation");
  }
  return value;
}

function assertFilesystemKind(path, requestedKind) {
  const type = filesystemType(path);
  const network = NETWORK_FILESYSTEMS.test(type);
  if (requestedKind === "nas-path" && !network) {
    throw new Error(`NAS target is not mounted (filesystem is ${type})`);
  }
  if (requestedKind === "local-path" && network) {
    throw new Error(`Local storage target resolves to network filesystem ${type}`);
  }
  return { filesystemType: type, network };
}

function validateHostPath(requestedKind, relativePath) {
  directory(ALLOWED_ROOT, "Storage allowlist root");
  if (typeof relativePath !== "string" || !relativePath
    || relativePath.startsWith("/") || relativePath.startsWith("\\")
    || relativePath.split(/[\\/]/u).some((entry) => !entry || entry === "." || entry === "..")) {
    throw new Error("Storage host path is not a safe allowlist-relative directory");
  }
  const candidate = resolve(ALLOWED_ROOT, relativePath);
  if (!candidate.startsWith(`${ALLOWED_ROOT}/`)) throw new Error("Storage host path escapes its allowlist root");
  directory(candidate, "Storage host path");
  return assertFilesystemKind(candidate, requestedKind);
}

function filesystemType(path) {
  return command("stat", ["-f", "-c", "%T", path]).toLowerCase();
}

function probe(operationId, requestedKind) {
  directory(TARGET, "Storage target");
  const filesystem = assertFilesystemKind(TARGET, requestedKind);
  const probePath = join(TARGET, `.stugu-storage-probe-${operationId}`);
  const descriptor = openSync(probePath, "wx", 0o600);
  try {
    writeFileSync(descriptor, "probe\n", "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
    rmSync(probePath, { force: true });
  }
  command("sync", ["-f", TARGET]);
  return filesystem;
}

function assertSourceSentinel(copyKind, targetId) {
  if (copyKind !== "backups") throw new Error("Only recovery-set storage uses a mount sentinel");
  uuid(targetId);
  directory(SOURCE, "Storage source");
  let sentinel;
  try {
    sentinel = JSON.parse(readFileSync(join(SOURCE, ".stugu-storage-target.json"), "utf8"));
  } catch {
    throw new Error("Configured backup storage is not mounted");
  }
  if (sentinel?.schema !== "stugu-storage-target/v1"
    || sentinel.targetId !== targetId || sentinel.kind !== "backups") {
    throw new Error("Mounted backup storage does not match the configured target");
  }
  return { sentinel: true };
}

function pgControl(path) {
  const output = command("pg_controldata", [path]);
  const fields = Object.fromEntries(output.split(/\r?\n/u).flatMap((line) => {
    const separator = line.indexOf(":");
    return separator > 0 ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]] : [];
  }));
  const systemIdentifier = fields["Database system identifier"];
  const state = fields["Database cluster state"];
  const checkpoint = fields["Latest checkpoint location"];
  const catalogVersion = fields["Catalog version number"];
  if (!systemIdentifier || !state || !checkpoint || !catalogVersion) {
    throw new Error("PostgreSQL control data is incomplete");
  }
  return { systemIdentifier, state, checkpoint, catalogVersion };
}

function bytes(path) {
  const value = Number(command("du", ["-s", "-B1", path]).split(/\s/u)[0]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Storage size could not be measured");
  return value;
}

function availableBytes(path) {
  const lines = command("df", ["-P", "-B1", path]).split(/\r?\n/u);
  const columns = lines.at(-1)?.trim().split(/\s+/u) ?? [];
  const value = Number(columns[3]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Target free space could not be measured");
  return value;
}

function inspectSource(copyKind) {
  directory(SOURCE, "Storage source");
  const metadata = statSync(SOURCE);
  const result = {
    bytes: bytes(SOURCE),
    device: metadata.dev,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o777,
    filesystemType: filesystemType(SOURCE),
  };
  if (copyKind !== "timeseries") return result;
  const control = pgControl(SOURCE);
  if (control.state !== "shut down") throw new Error(`PostgreSQL source is not cleanly shut down (${control.state})`);
  return { ...result, control };
}

function ensureTargetOwned(operationId, copyKind) {
  const current = marker();
  const entries = readdirSync(TARGET).filter((name) => name !== ".stugu-storage-copy.json");
  if (!current) {
    if (entries.length > 0) throw new Error("Storage target must be empty before its first copy");
    writeMarker(operationId, copyKind, "copying");
    return;
  }
  validatedMarker(operationId, copyKind);
}

function copy(operationId, copyKind) {
  directory(SOURCE, "Storage source");
  directory(TARGET, "Storage target");
  ensureTargetOwned(operationId, copyKind);
  const source = inspectSource(copyKind);
  const required = Math.ceil(source.bytes * 1.2);
  const available = availableBytes(TARGET);
  if (available < required) {
    throw new Error(`Storage target needs ${required} free bytes but has ${available}`);
  }
  const args = copyKind === "timeseries"
    ? ["-aHAX", "--numeric-ids", "--delete", "--fsync"]
    : ["-a", "--numeric-ids", "--delete", "--fsync", "--no-owner", "--no-group"];
  args.push("--exclude=.stugu-storage-*", `${SOURCE}/`, `${TARGET}/`);
  command("rsync", args);
  if (copyKind === "timeseries") {
    chownSync(TARGET, source.uid, source.gid);
    chmodSync(TARGET, 0o700);
  }
  command("sync", ["-f", TARGET]);
  const targetControl = copyKind === "timeseries" ? pgControl(TARGET) : null;
  if (source.control && (targetControl?.systemIdentifier !== source.control.systemIdentifier
    || targetControl.checkpoint !== source.control.checkpoint
    || targetControl.catalogVersion !== source.control.catalogVersion
    || targetControl.state !== "shut down")) {
    throw new Error("Copied PostgreSQL control identity does not match the clean source");
  }
  writeMarker(operationId, copyKind, "complete");
  return { source, target: { bytes: bytes(TARGET), control: targetControl } };
}

function verifyCopy(operationId, copyKind) {
  validatedMarker(operationId, copyKind, "complete");
  const source = inspectSource(copyKind);
  const targetControl = copyKind === "timeseries" ? pgControl(TARGET) : null;
  if (source.control && (targetControl?.systemIdentifier !== source.control.systemIdentifier
    || targetControl.checkpoint !== source.control.checkpoint
    || targetControl.catalogVersion !== source.control.catalogVersion)) {
    throw new Error("Storage copy identity verification failed");
  }
  return { source, target: { bytes: bytes(TARGET), control: targetControl } };
}

function reset(operationId, copyKind) {
  if (!existsSync(MARKER)) return { reset: false };
  validatedMarker(operationId, copyKind);
  for (const entry of readdirSync(TARGET)) rmSync(join(TARGET, entry), { recursive: true, force: true });
  command("sync", ["-f", TARGET]);
  return { reset: true };
}

function complete(operationId, copyKind, targetId) {
  const current = validatedMarker(operationId, copyKind);
  if (current.phase === "applied") return { complete: true };
  if (current.phase !== "complete") throw new Error("Storage copy is not ready to complete");
  if (targetId) {
    uuid(targetId);
    durableText(join(TARGET, ".stugu-storage-target.json"), `${JSON.stringify({
      schema: "stugu-storage-target/v1",
      targetId,
      kind: copyKind,
      createdAt: new Date().toISOString(),
    })}\n`);
  }
  writeMarker(operationId, copyKind, "applied");
  command("sync", ["-f", TARGET]);
  return { complete: true };
}

function writeTargetSentinel(copyKind, targetId) {
  uuid(targetId);
  directory(TARGET, "Storage target");
  durableText(join(TARGET, ".stugu-storage-target.json"), `${JSON.stringify({
    schema: "stugu-storage-target/v1",
    targetId,
    kind: copyKind,
    createdAt: new Date().toISOString(),
  })}\n`);
  command("sync", ["-f", TARGET]);
  return { sentinel: true };
}

const [action, rawOperationId, rawKind, extra] = process.argv.slice(2);
const operationId = uuid(rawOperationId);
let result;
if (action === "validate-host-path") result = validateHostPath(locationKind(rawKind), extra);
else if (action === "probe") result = probe(operationId, locationKind(rawKind));
else {
  const copyKind = kind(rawKind);
  if (action === "inspect-source") result = inspectSource(copyKind);
  else if (action === "source-sentinel") result = assertSourceSentinel(copyKind, extra);
  else if (action === "copy") result = copy(operationId, copyKind);
  else if (action === "verify-copy") result = verifyCopy(operationId, copyKind);
  else if (action === "reset") result = reset(operationId, copyKind);
  else if (action === "complete") result = complete(operationId, copyKind, extra ?? null);
  else if (action === "sentinel") result = writeTargetSentinel(copyKind, extra);
  else throw new Error("Unsupported storage helper action");
}
process.stdout.write(`${JSON.stringify(result)}\n`);
