#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { r2BackupConfiguration } from "./stugu-r2-backup/configuration.mjs";
import {
  findCompletedBackup,
  uploadVerifiedBackup,
} from "./stugu-r2-backup/transport.mjs";

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function verifiedBackupDirectories(backupRoot) {
  const root = resolve(backupRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^stugu-backup-\d{4}-\d{2}-\d{2}T/u.test(entry.name))
    .map((entry) => ({ name: entry.name, path: resolve(root, entry.name) }))
    .filter((entry) => entry.path.startsWith(`${root}${sep}`))
    .filter((entry) => {
      const manifest = readJson(join(entry.path, "manifest.json"));
      return manifest?.format === "stugu-backup" && manifest?.verification?.status === "passed";
    })
    .sort((left, right) => right.name.localeCompare(left.name));
}

export function retryDue(state, backupName, now, retryMinutes) {
  if (state?.state !== "failed" || state?.latestBackupName !== backupName || !state?.checkedAt) return true;
  const checkedAt = Date.parse(state.checkedAt);
  return !Number.isFinite(checkedAt) || now.getTime() - checkedAt >= retryMinutes * 60_000;
}

export async function replicateLatest({
  backupRoot,
  operationsDirectory,
  config,
  environment = process.env,
  now = new Date(),
  retryMinutes = 15,
  dependencies = {},
}) {
  const statusPath = join(resolve(operationsDirectory), "status.json");
  const current = readJson(statusPath);
  const latest = verifiedBackupDirectories(backupRoot)[0] ?? null;
  const base = {
    version: 1,
    provider: "cloudflare-r2",
    configured: true,
    schedulerHealthy: true,
    checkedAt: now.toISOString(),
    latestBackupName: latest?.name ?? null,
    latestUploadedBackupName: current?.latestUploadedBackupName ?? null,
    latestUploadedAt: current?.latestUploadedAt ?? null,
    objectKey: current?.objectKey ?? null,
    lastError: null,
  };
  if (!latest) {
    const status = { ...base, state: "idle", lastAction: "none" };
    atomicJson(statusPath, status);
    return status;
  }
  if (current?.state === "complete" && current.latestUploadedBackupName === latest.name) {
    const status = { ...base, state: "complete", lastAction: "current" };
    atomicJson(statusPath, status);
    return status;
  }
  if (!retryDue(current, latest.name, now, retryMinutes)) return current;
  atomicJson(statusPath, { ...base, state: "uploading" });
  try {
    const existing = await (dependencies.findCompletedBackup ?? findCompletedBackup)(
      config,
      latest.name,
      environment,
      dependencies,
    );
    const uploaded = existing ?? await (dependencies.uploadVerifiedBackup ?? uploadVerifiedBackup)(
      latest.path,
      config,
      environment,
      dependencies,
    );
    const status = {
      ...base,
      state: "complete",
      lastAction: existing ? "found" : "uploaded",
      latestUploadedBackupName: latest.name,
      latestUploadedAt: uploaded.uploadedAt ?? now.toISOString(),
      objectKey: uploaded.objectKey,
      encryptedBytes: uploaded.bytes,
      ciphertextSha256: uploaded.sha256,
      stagingCleanupWarning: uploaded.cleanupWarning ?? null,
    };
    atomicJson(statusPath, status);
    return status;
  } catch (error) {
    const status = {
      ...base,
      state: "failed",
      lastAction: "failed",
      schedulerHealthy: false,
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    };
    atomicJson(statusPath, status);
    return status;
  }
}

export async function main(environment = process.env) {
  const backupRoot = resolve(environment.BACKUP_DIRECTORY ?? "/app/backups");
  const operationsDirectory = resolve(
    environment.R2_BACKUP_OPERATIONS_DIRECTORY ?? "/app/runtime/r2-backup-operations",
  );
  const pollSeconds = boundedInteger(
    environment.STUGU_R2_POLL_INTERVAL_SECONDS,
    60,
    15,
    3_600,
    "STUGU_R2_POLL_INTERVAL_SECONDS",
  );
  const retryMinutes = boundedInteger(
    environment.STUGU_R2_RETRY_INTERVAL_MINUTES,
    15,
    1,
    1_440,
    "STUGU_R2_RETRY_INTERVAL_MINUTES",
  );
  const config = r2BackupConfiguration(environment);
  mkdirSync(operationsDirectory, { recursive: true, mode: 0o700 });
  let running = false;
  const work = async () => {
    if (running) return;
    running = true;
    try {
      const status = await replicateLatest({
        backupRoot,
        operationsDirectory,
        config,
        environment,
        now: new Date(),
        retryMinutes,
      });
      if (status.state === "failed") console.error(`R2 backup failed: ${status.lastError}`);
      else if (status.lastAction === "uploaded") console.log(`R2 backup uploaded: ${status.objectKey}`);
      else if (status.lastAction === "found") console.log(`R2 backup already present: ${status.objectKey}`);
    } catch (error) {
      console.error(`R2 backup scheduler check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  await work();
  const timer = setInterval(() => void work(), pollSeconds * 1_000);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`R2 backup scheduler failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
