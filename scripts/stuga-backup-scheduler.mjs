#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { restoreDrill } from "./stuga-restore-drill.mjs";

const operationsDirectory = resolve(process.env.BACKUP_OPERATIONS_DIRECTORY ?? "/app/runtime/backup-operations");
const backupRoot = resolve(process.env.BACKUP_DIRECTORY ?? "/app/backups");
const intervalHours = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS ?? 24));
const restoreDrillDays = Math.max(1, Number(process.env.RESTORE_DRILL_INTERVAL_DAYS ?? 30));
const retentionCount = Math.max(2, Number(process.env.BACKUP_RETENTION_COUNT ?? 30));
const pollMs = 15_000;

mkdirSync(operationsDirectory, { recursive: true, mode: 0o700 });
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function status() {
  return readJson(join(operationsDirectory, "status.json")) ?? {
    version: 1, available: true, schedulerHealthy: true, requestId: null, state: "idle",
    requestedAt: null, completedAt: null, backupPath: null, lastError: null,
    latestVerifiedBackupAt: null, latestRestoreDrillAt: null,
  };
}

function runBackup(output) {
  const args = [
    "/app/scripts/stuga-backup.mjs",
    "--database", "/app/data/climate-twin.sqlite",
    "--assets", "/app/data/assets",
    "--spatial-db", "/app/data/experimental-spatial-layers.sqlite",
    "--include-timescale", "--include-secrets",
    "--secrets-file", "/app/data/integration-secrets.json",
    "--output", output,
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.trim().slice(0, 2_000) || `Backup exited with ${code}`)));
  });
}

function runVerify(output) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["/app/scripts/stuga-backup.mjs", "--verify", output], {
      env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.trim().slice(0, 2_000) || `Verification exited with ${code}`)));
  });
}

function safeBackupDirectories() {
  return readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^stuga-backup-\d{4}-\d{2}-\d{2}T/.test(entry.name)
      && existsSync(join(backupRoot, entry.name, "manifest.json")))
    .map((entry) => ({ name: entry.name, path: resolve(backupRoot, entry.name) }))
    .filter((entry) => entry.path.startsWith(`${backupRoot}${sep}`))
    .sort((left, right) => right.name.localeCompare(left.name));
}

function pruneOldBackups() {
  for (const entry of safeBackupDirectories().slice(retentionCount)) rmSync(entry.path, { recursive: true, force: true });
}

function requestFiles() {
  return readdirSync(operationsDirectory)
    .filter((name) => /^[0-9a-f-]{36}\.request\.json$/.test(name))
    .sort();
}

let running = false;
async function work() {
  if (running) return;
  const current = status();
  const requestName = requestFiles()[0] ?? null;
  const due = !current.latestVerifiedBackupAt
    || Date.now() - Date.parse(current.latestVerifiedBackupAt) >= intervalHours * 3_600_000;
  if (!requestName && !due) {
    atomicJson(join(operationsDirectory, "status.json"), { ...current, schedulerHealthy: true });
    return;
  }
  running = true;
  const request = requestName ? readJson(join(operationsDirectory, requestName)) : null;
  const requestId = request?.requestId ?? `scheduled-${Date.now()}`;
  const requestedAt = request?.requestedAt ?? new Date().toISOString();
  const outputName = `stuga-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const output = resolve(backupRoot, outputName);
  if (!output.startsWith(`${backupRoot}${sep}`) || basename(output) !== outputName) throw new Error("Unsafe backup output path");
  atomicJson(join(operationsDirectory, "status.json"), {
    ...current, version: 1, available: true, schedulerHealthy: true, requestId,
    state: "running", requestedAt, completedAt: null, backupPath: null, lastError: null,
  });
  try {
    await runBackup(output);
    await runVerify(output);
    const verifiedAt = new Date().toISOString();
    let latestRestoreDrillAt = current.latestRestoreDrillAt ?? null;
    const drillDue = !latestRestoreDrillAt
      || Date.now() - Date.parse(latestRestoreDrillAt) >= restoreDrillDays * 86_400_000;
    if (drillDue) {
      await restoreDrill(output);
      latestRestoreDrillAt = new Date().toISOString();
    }
    atomicJson(join(operationsDirectory, "status.json"), {
      ...current, version: 1, available: true, schedulerHealthy: true, requestId,
      state: "complete", requestedAt, completedAt: verifiedAt, backupPath: outputName, lastError: null,
      latestVerifiedBackupAt: verifiedAt, latestRestoreDrillAt,
    });
    pruneOldBackups();
  } catch (error) {
    atomicJson(join(operationsDirectory, "status.json"), {
      ...current, version: 1, available: true, schedulerHealthy: true, requestId,
      state: "failed", requestedAt, completedAt: new Date().toISOString(), backupPath: null,
      lastError: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
    });
  } finally {
    if (requestName) {
      try { unlinkSync(join(operationsDirectory, requestName)); } catch { /* A later scan safely ignores a missing request. */ }
    }
    running = false;
  }
}

await work();
const timer = setInterval(() => void work(), pollMs);
const stop = () => { clearInterval(timer); process.exit(0); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
