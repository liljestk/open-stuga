#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

function requiredPath(value, label) {
  const path = resolve(value ?? "");
  if (!value || !existsSync(path)) throw new Error(`${label} does not exist`);
  return path;
}

function safeIdentifier(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} failed with exit code ${code}: ${stderr.trim().slice(0, 2_000)}`));
    });
  });
}

export async function restoreDrill(backupDirectory, environment = process.env) {
  const directory = requiredPath(backupDirectory, "Backup directory");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest?.format !== "stuga-backup" || manifest?.version !== 2) throw new Error("Unsupported backup manifest");
  const dumpFile = manifest.files?.find((file) => file.category === "timescale-pgdump")?.path;
  if (typeof dumpFile !== "string") throw new Error("Backup does not include a TimescaleDB dump");
  const dump = requiredPath(join(directory, dumpFile), "TimescaleDB dump");
  const passwordFile = requiredPath(environment.TIMESERIES_ADMIN_PASSWORD_FILE ?? "", "TimescaleDB admin password file");
  const password = readFileSync(passwordFile, "utf8").trim();
  if (!password) throw new Error("TimescaleDB admin password file is empty");
  const host = environment.TIMESERIES_HOST ?? "timescaledb";
  const port = String(Number(environment.TIMESERIES_PORT ?? 5432));
  const adminDatabase = safeIdentifier(environment.TIMESERIES_DATABASE ?? "stuga", "TimescaleDB database");
  const adminUser = safeIdentifier(environment.TIMESERIES_ADMIN_USER ?? "stuga_admin", "TimescaleDB admin user");
  const drillDatabase = safeIdentifier(`stuga_drill_${randomBytes(8).toString("hex")}`, "Restore drill database");
  const childEnv = { ...environment, PGPASSWORD: password };
  const connection = ["-h", host, "-p", port, "-U", adminUser];
  let created = false;
  try {
    await run("createdb", [...connection, "-T", "template0", drillDatabase], childEnv);
    created = true;
    await run("psql", [...connection, "-d", drillDatabase, "-v", "ON_ERROR_STOP=1", "-c",
      "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();"], childEnv);
    await run("pg_restore", [...connection, "-d", drillDatabase, "--exit-on-error", dump], childEnv);
    await run("psql", [...connection, "-d", drillDatabase, "-v", "ON_ERROR_STOP=1", "-c",
      "SELECT timescaledb_post_restore(); ANALYZE; SELECT COUNT(*) FROM telemetry.measurement_samples;"], childEnv);
    return { database: drillDatabase, restoredAt: new Date().toISOString() };
  } finally {
    if (created) {
      await run("dropdb", [...connection, "--force", drillDatabase], childEnv).catch((error) => {
        throw new Error(`Restore drill completed but cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    // The password is scoped to the child environment and is never returned or logged.
    void adminDatabase;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const backupDirectory = process.argv[2];
  restoreDrill(backupDirectory).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
