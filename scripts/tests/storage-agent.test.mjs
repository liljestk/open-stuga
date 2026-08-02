import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readAgentConfig } from "../stugu-update-agent/configuration-request.mjs";
import {
  applyStorageRequest,
  publishStorageStatus,
  readStorageConfiguration,
  storageRevision,
  validatedStorageRequest,
  validatedStorageSettings,
  writeStorageConfiguration,
} from "../stugu-update-agent/services-storage.mjs";
import { pendingWork } from "../stugu-update-agent/update-loop.mjs";
import { assertStorageTarget } from "../stugu-storage-target.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-storage-agent-"));
  const operationsDirectory = join(directory, "operations");
  const allowedRoot = join(directory, "storage");
  mkdirSync(operationsDirectory);
  mkdirSync(allowedRoot);
  writeFileSync(join(directory, ".env"), "COMPOSE_PROFILES=self-update\n", "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    STUGA_STORAGE_ALLOWED_ROOTS: allowedRoot,
  }, directory, []);
  return { config, directory, operationsDirectory, allowedRoot };
}

function request(previous, target, id = "27974c49-f62e-4365-9ee7-802c7488557e") {
  return {
    schema: "stugu-storage-request/v1",
    id,
    requestedAt: "2026-08-02T10:00:00.000Z",
    expectedRevision: storageRevision(previous),
    previous,
    target,
  };
}

const managed = {
  timeseries: { kind: "managed", path: null },
  backups: { kind: "managed", path: null },
};

test("storage settings round-trip only bounded host paths through the persistent Compose env", (t) => {
  const { config, allowedRoot } = fixture(t);
  const settings = {
    timeseries: { kind: "local-path", path: join(allowedRoot, "telemetry") },
    backups: { kind: "nas-path", path: join(allowedRoot, "nas") },
  };
  assert.deepEqual(validatedStorageSettings(settings, config.storageAllowedRoots), settings);
  writeStorageConfiguration(config, settings, "37974c49-f62e-4365-9ee7-802c7488557e");
  assert.deepEqual(readStorageConfiguration(config).settings, settings);
  const environment = readFileSync(config.composeProfileEnvironmentFile, "utf8");
  assert.match(environment, /STUGA_TIMESERIES_DATA_SOURCE=/u);
  assert.match(environment, /STUGA_SCHEDULED_BACKUP_STORAGE_KIND=nas-path/u);
  assert.match(environment, /STUGA_SCHEDULED_BACKUP_TARGET_ID=37974c49/u);
  assert.throws(() => validatedStorageSettings({
    ...managed,
    backups: { kind: "local-path", path: join(allowedRoot, "..", "escape") },
  }, config.storageAllowedRoots), /allowlist|unsafe/u);
});

test("agent publishes current storage and recognizes queued storage work", (t) => {
  const { config, operationsDirectory } = fixture(t);
  publishStorageStatus(config);
  const status = JSON.parse(readFileSync(join(operationsDirectory, "storage-status.json"), "utf8"));
  assert.equal(status.schema, "stugu-storage-status/v1");
  assert.deepEqual(status.settings, managed);
  const queued = request(managed, { ...managed, backups: { kind: "local-path", path: join(config.storageAllowedRoots[0], "backups") } });
  assert.deepEqual(validatedStorageRequest(queued, config).target, queued.target);
  writeFileSync(join(operationsDirectory, `storage-request-${queued.id}.json`), JSON.stringify(queued));
  assert.equal(pendingWork(config).kind, "storage");
});

test("backup target sentinel fails closed when a configured NAS is absent or replaced", (t) => {
  const { allowedRoot } = fixture(t);
  const targetId = "37974c49-f62e-4365-9ee7-802c7488557e";
  assert.throws(() => assertStorageTarget(allowedRoot, targetId), /not mounted/u);
  writeFileSync(join(allowedRoot, ".stugu-storage-target.json"), JSON.stringify({
    schema: "stugu-storage-target/v1",
    targetId,
    kind: "backups",
  }));
  assert.doesNotThrow(() => assertStorageTarget(allowedRoot, targetId));
  assert.throws(() => assertStorageTarget(allowedRoot, "47974c49-f62e-4365-9ee7-802c7488557e"), /does not match/u);
});

test("agent refuses to move recovery sets from external storage without a mount sentinel", async (t) => {
  const { config, operationsDirectory, allowedRoot } = fixture(t);
  const external = join(allowedRoot, "legacy-backups");
  mkdirSync(external);
  const previous = { ...managed, backups: { kind: "local-path", path: external } };
  writeStorageConfiguration(config, previous, null);
  const queued = request(previous, managed);
  const requestPath = join(operationsDirectory, `storage-request-${queued.id}.json`);
  writeFileSync(requestPath, JSON.stringify(queued));

  await applyStorageRequest(config, requestPath, {
    compose: async () => { throw new Error("Compose must not run before the sentinel check"); },
  });

  const status = JSON.parse(readFileSync(join(operationsDirectory, "storage-status.json"), "utf8"));
  assert.equal(status.operation.phase, "failed");
  assert.ok(status.operation.completedAt);
  assert.match(status.operation.detail, /mount sentinel/u);
  assert.equal(pendingWork(config), null);
});

test("agent resumes an interrupted rollback and restores the previous configuration", async (t) => {
  const { config, operationsDirectory, allowedRoot } = fixture(t);
  const external = join(allowedRoot, "backups");
  mkdirSync(external);
  const previous = { ...managed, backups: { kind: "local-path", path: external } };
  const target = { ...managed, backups: { kind: "nas-path", path: external } };
  const previousTargetId = "37974c49-f62e-4365-9ee7-802c7488557e";
  const targetTargetId = "47974c49-f62e-4365-9ee7-802c7488557e";
  writeStorageConfiguration(config, target, targetTargetId);
  const queued = request(previous, target);
  const requestFile = `storage-request-${queued.id}.json`;
  writeFileSync(join(operationsDirectory, requestFile), JSON.stringify(queued));
  writeFileSync(join(operationsDirectory, "storage-journal.json"), JSON.stringify({
    schema: "stugu-storage-journal/v1",
    request: queued,
    requestId: queued.id,
    requestFile,
    previous,
    target,
    phase: "rolling-back",
    activeServices: ["api"],
    previousBackupTargetId: previousTargetId,
    targetBackupTargetId: targetTargetId,
    verifiedBackup: "stugu-backup-test",
    timeseriesControl: null,
    rollbackAttempts: 1,
    startedAt: "2026-08-02T10:00:01.000Z",
    updatedAt: "2026-08-02T10:00:02.000Z",
    detail: "interrupted test rollback",
  }));

  await applyStorageRequest(config, null, {
    compose: async (_config, args) => (args[0] === "exec" && args.includes("api") ? "0.28.0" : ""),
  });

  const current = readStorageConfiguration(config);
  assert.deepEqual(current.settings, previous);
  assert.equal(current.backupTargetId, previousTargetId);
  const status = JSON.parse(readFileSync(join(operationsDirectory, "storage-status.json"), "utf8"));
  assert.equal(status.operation.phase, "failed");
  assert.ok(status.operation.completedAt);
  assert.equal(pendingWork(config), null);
});

test("journaled storage change restore-tests, copies, inspects real mounts, and completes", async (t) => {
  const { config, operationsDirectory, allowedRoot } = fixture(t);
  const target = {
    timeseries: { kind: "local-path", path: join(allowedRoot, "telemetry") },
    backups: { kind: "nas-path", path: join(allowedRoot, "nas") },
  };
  const queued = request(managed, target);
  const requestPath = join(operationsDirectory, `storage-request-${queued.id}.json`);
  writeFileSync(requestPath, JSON.stringify(queued));
  const calls = [];
  const helperCommands = [];
  let helperDefinition = null;
  const control = {
    systemIdentifier: "7557330594888761327",
    state: "shut down",
    checkpoint: "0/7000060",
    catalogVersion: "202406281",
  };
  const compose = async (_config, args) => {
    calls.push(args);
    const overrideIndex = args.indexOf("--file");
    if (overrideIndex >= 0 && args.includes("create") && args.includes("stugu-storage-helper")) {
      helperDefinition = JSON.parse(readFileSync(args[overrideIndex + 1], "utf8")).services["stugu-storage-helper"];
      helperCommands.push(helperDefinition.command);
      return "";
    }
    if (args.includes("stugu-storage-helper") && args.includes("rm")) return "";
    if (args.includes("stugu-storage-helper") && args.includes("ps") && args.includes("-q")) return "cccccccccccc";
    if (args.includes("stugu-backup") && !args.includes("--entrypoint")) {
      return "Verified backup created: /app/backups/stugu-backup-2026-08-02T10-00-00-000Z\n";
    }
    if (args.includes("--entrypoint")) return "{}";
    if (args[0] === "ps" && args.includes("--services")) return "api\nweb\nstugu-backup-scheduler\nstugu-r2-backup\n";
    if (args[0] === "ps" && args[1] === "-q") {
      return {
        timescaledb: "aaaaaaaaaaaa",
        api: "bbbbbbbbbbbb",
        "stugu-backup-scheduler": "dddddddddddd",
        "stugu-r2-backup": "eeeeeeeeeeee",
      }[args[2]];
    }
    if (args[0] === "exec" && args.includes("pg_controldata")) {
      return [
        `Database system identifier: ${control.systemIdentifier}`,
        "Database cluster state: in production",
        `Catalog version number: ${control.catalogVersion}`,
      ].join("\n");
    }
    if (args[0] === "exec" && args.includes("api")) return "0.28.0";
    return "";
  };
  const inspect = async (_command, args) => {
    if (args[0] === "start" || args[0] === "rm" || args[0] === "kill") return "";
    if (args[0] === "wait") return "0";
    if (args[0] === "logs") {
      const [action, , purpose] = helperDefinition.command;
      if (action === "copy" && purpose === "timeseries") {
        return JSON.stringify({ source: { control }, target: { control } });
      }
      return "{}";
    }
    if (args[0] === "inspect" && args[1] === "cccccccccccc") {
      return JSON.stringify([{
        State: { Running: false },
        Mounts: helperDefinition.volumes.map((entry) => ({
          Destination: entry.target,
          Type: entry.type,
          Source: entry.source,
          Name: entry.type === "volume" ? `test_${entry.source}` : undefined,
          RW: !entry.read_only,
        })),
      }]);
    }
    const containerId = args[1];
    const mounts = containerId === "aaaaaaaaaaaa"
      ? [{ Destination: "/var/lib/postgresql/data", Type: "bind", Source: target.timeseries.path }]
      : containerId === "bbbbbbbbbbbb"
        ? [
          { Destination: "/app/timeseries-data", Type: "bind", Source: target.timeseries.path },
          { Destination: "/app/backups", Type: "bind", Source: target.backups.path },
        ]
        : [{ Destination: "/app/backups", Type: "bind", Source: target.backups.path }];
    return JSON.stringify([{ Mounts: mounts }]);
  };

  await applyStorageRequest(config, requestPath, { compose, runCommand: inspect });

  const current = readStorageConfiguration(config);
  assert.deepEqual(current.settings, target);
  assert.match(current.backupTargetId, /^[0-9a-f-]{36}$/u);
  assert.equal(JSON.parse(readFileSync(join(operationsDirectory, "storage-status.json"), "utf8")).operation.phase, "complete");
  assert.equal(pendingWork(config), null);
  assert.ok(calls.some((args) => args[0] === "stop" && args.includes("timescaledb") && args.includes("stugu-backup-scheduler")));
  assert.ok(calls.some((args) => args.some((argument) => argument.includes("stugu-restore-drill.mjs"))), JSON.stringify(calls));
  assert.ok(helperCommands.some((args) => args[0] === "complete" && args.includes("timeseries")));
  assert.ok(helperCommands.some((args) => args[0] === "complete" && args.includes("backups")));
});
