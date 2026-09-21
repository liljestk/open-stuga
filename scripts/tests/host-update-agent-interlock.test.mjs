import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readAgentConfig } from "../stugu-update-agent.mjs";
import { releaseEnvironment } from "../stugu-update-agent/configuration-request.mjs";
import {
  advanceSystemWorkflow,
  pendingSystemWorkflowRequest,
  prepareSystemWorkflow,
  readSystemWorkflowJournal,
  systemWorkflowPaths,
  validatedSystemWorkflowRequest,
} from "../stugu-update-agent/system-update-workflow.mjs";
import {
  acquireLock,
  heartbeat,
  hostUpdateInterlock,
  pendingWork,
  publishDockerHeartbeat,
  releaseLock,
} from "../stugu-update-agent/update-loop.mjs";

const workflowId = "60c53662-45b2-4e28-b1cf-dc90c52f7cb3";
const appId = "27974c49-f62e-4365-9ee7-802c7488557e";
const hostOperationId = "9cf2e0a6-c24c-4a64-97cb-f6bc97627490";

function appRequest(id = appId, requestedAt = "2026-08-04T08:00:00.000Z") {
  const version = "0.6.0";
  return {
    schema: "stugu-system-update-request/v3",
    id,
    version,
    tagName: `v${version}`,
    repository: "liljestk/open-stuga",
    requestedAt,
    previousVersion: "0.5.0",
    releaseManifestSchema: "stugu-release-manifest/v1",
    compatibility: { updateAgent: 3, compose: 2 },
    images: {
      api: `ghcr.io/liljestk/open-stuga-api:v${version}@sha256:${"a".repeat(64)}`,
      web: `ghcr.io/liljestk/open-stuga-web:v${version}@sha256:${"b".repeat(64)}`,
      backup: `ghcr.io/liljestk/open-stuga-backup:v${version}@sha256:${"c".repeat(64)}`,
      tapo: `ghcr.io/liljestk/open-stuga-tapo-export-runner:v${version}@sha256:${"d".repeat(64)}`,
      updateAgent: `ghcr.io/liljestk/open-stuga-update-agent:v${version}@sha256:${"e".repeat(64)}`,
      mqtt: `ghcr.io/liljestk/open-stuga-mqtt:v${version}@sha256:${"f".repeat(64)}`,
      nexus433: `ghcr.io/liljestk/open-stuga-nexus433:v${version}@sha256:${"0".repeat(64)}`,
    },
  };
}

function workflowRequest(app = appRequest()) {
  return {
    schema: "stugu-system-update-workflow-request/v1",
    id: workflowId,
    action: "update-everything",
    requestedAt: "2026-08-04T08:00:00.000Z",
    app,
    host: {
      version: "0.35.0",
      generation: 7,
      manifestSha256: "1".repeat(64),
    },
  };
}

function workflowFixture(t, app = appRequest()) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-system-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  const hostJournal = join(directory, "host-update-journal.json");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
    SYSTEM_UPDATE_RUNTIME: "raspberry-pi",
    STUGA_HOST_UPDATE_JOURNAL: hostJournal,
  }, directory, []);
  const paths = systemWorkflowPaths(config);
  mkdirSync(paths.inbox, { recursive: true });
  mkdirSync(paths.bridgeRequests, { recursive: true });
  mkdirSync(join(operationsDirectory, "host-bridge", "status"), { recursive: true });
  writeFileSync(config.factoryReleaseEnvFile, releaseEnvironment({
    ...appRequest(),
    version: "0.5.0",
    tagName: "v0.5.0",
    previousVersion: "0.4.0",
    images: Object.fromEntries(Object.entries(appRequest().images).map(([name, image]) => [
      name,
      image.replaceAll(":v0.6.0", ":v0.5.0"),
    ])),
  }), "utf8");
  writeFileSync(paths.bridgeStatus, JSON.stringify({
    schema: "stugu-host-update-bridge-status/v1",
    bridgeVersion: "1.0.0",
    available: true,
    currentGeneration: 6,
    phase: "idle",
    error: null,
    updatedAt: "2026-08-04T08:00:00.000Z",
  }));
  const request = workflowRequest(app);
  const requestPath = join(paths.inbox, `request-${request.id}.json`);
  writeFileSync(requestPath, JSON.stringify(request));
  const compose = async (_config, args) => {
    if (args[0] === "ps") return "api\nweb";
    if (args[0] === "exec") return "0.5.0";
    if (args.includes("stugu-backup")) {
      return `Verified backup created\nManifest SHA-256: ${"2".repeat(64)}\nFiles: 3`;
    }
    throw new Error(`Unexpected Compose call: ${args.join(" ")}`);
  };
  return { config, directory, operationsDirectory, paths, request, requestPath, compose };
}

function writeBridgeStatus(paths, phase, values = {}) {
  writeFileSync(paths.bridgeStatus, JSON.stringify({
    schema: "stugu-host-update-bridge-status/v1",
    bridgeVersion: "1.0.0",
    available: true,
    currentGeneration: phase === "complete" ? 7 : 6,
    requestId: null,
    workflowId,
    requestOperation: "stage",
    operationId: hostOperationId,
    intentId: workflowId,
    phase,
    detail: `Host phase ${phase}`,
    targetVersion: "0.35.0",
    targetGeneration: 7,
    manifestSha256: "1".repeat(64),
    error: null,
    updatedAt: new Date().toISOString(),
    ...values,
  }));
}

test("container mutations fail closed while a host-update journal is nonterminal", () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-host-update-interlock-"));
  try {
    const operationsDirectory = join(directory, "operations");
    const journalPath = join(directory, "host-journal.json");
    mkdirSync(operationsDirectory);
    writeFileSync(join(operationsDirectory, "request-test.json"), JSON.stringify({
      requestedAt: "2026-08-02T08:00:00.000Z",
    }));
    const config = readAgentConfig({
      STUGA_PROJECT_DIRECTORY: directory,
      SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
      SYSTEM_UPDATE_RUNTIME: "raspberry-pi",
      STUGA_HOST_UPDATE_JOURNAL: journalPath,
    }, directory);
    assert.equal(config.hostUpdateJournal, journalPath);
    writeFileSync(journalPath, JSON.stringify({
      schema: "stugu-host-update-journal/v1",
      phase: "installed",
    }));
    assert.equal(hostUpdateInterlock(config)?.reason, "host-update-active");
    assert.equal(pendingWork(config), null);
    writeFileSync(journalPath, JSON.stringify({
      schema: "stugu-host-update-journal/v1",
      phase: "complete",
    }));
    assert.equal(hostUpdateInterlock(config), null);
    assert.equal(pendingWork(config)?.kind, "update");
    writeFileSync(journalPath, "{");
    assert.equal(hostUpdateInterlock(config)?.reason, "host-update-active");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("container mutation lease is exclusive and releases only its own inode", () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-agent-lease-"));
  try {
    const config = { operationsDirectory: directory };
    const first = acquireLock(config);
    assert.ok(first);
    assert.match(
      readFileSync(join(directory, "agent.lock"), "ascii"),
      /^stugu-mutation-lock\/v1 container-updater (?:unknown|[0-9a-f-]+) [0-9]+\r?\n$/u,
    );
    assert.equal(acquireLock(config), null);
    releaseLock(first);
    assert.equal(existsSync(join(directory, "agent.lock")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed mutation-lease boot identity cannot trigger immediate reclaim", () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-agent-malformed-lease-"));
  try {
    const path = join(directory, "agent.lock");
    writeFileSync(path, `${"stugu-mutation-lock/v1"} host-updater deadbeef 7\n`);
    assert.equal(acquireLock({ operationsDirectory: directory }), null);
    assert.match(readFileSync(path, "ascii"), / deadbeef 7\r?\n$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unified workflow requests are strict and carry immutable app and host identities", (t) => {
  const fixture = workflowFixture(t);
  const parsed = validatedSystemWorkflowRequest(
    fixture.request,
    fixture.config,
    `request-${workflowId}.json`,
  );
  assert.equal(parsed.host.generation, 7);
  assert.equal(parsed.app.images.api, appRequest().images.api);
  assert.throws(
    () => validatedSystemWorkflowRequest({ ...fixture.request, device: "/dev/sda" }, fixture.config),
    /fields are unsupported/u,
  );
  assert.throws(
    () => validatedSystemWorkflowRequest({
      ...fixture.request,
      host: { ...fixture.request.host, manifestSha256: "A".repeat(64) },
    }, fixture.config),
    /manifest digest/u,
  );
  assert.throws(
    () => validatedSystemWorkflowRequest(fixture.request, fixture.config, `request-${appId}.json`),
    /filename/u,
  );
  assert.deepEqual(
    validatedSystemWorkflowRequest({
      schema: "stugu-system-update-workflow-request/v1",
      id: "194c45fe-42e9-46cf-89f8-12ed608695af",
      action: "retry-application",
      requestedAt: "2026-08-04T09:00:00.000Z",
      workflowId,
    }, fixture.config),
    {
      schema: "stugu-system-update-workflow-request/v1",
      id: "194c45fe-42e9-46cf-89f8-12ed608695af",
      action: "retry-application",
      requestedAt: "2026-08-04T09:00:00.000Z",
      workflowId,
    },
  );
});

test("invalid workflow request timestamps still publish a parseable failure", async (t) => {
  const fixture = workflowFixture(t);
  writeFileSync(fixture.requestPath, JSON.stringify({
    ...fixture.request,
    requestedAt: "not-a-time",
  }));

  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );

  const status = JSON.parse(readFileSync(fixture.paths.status, "utf8"));
  assert.equal(status.phase, "failed");
  assert.equal(status.error.code, "WORKFLOW_REQUEST_INVALID");
  assert.equal(status.requestedAt.endsWith("Z"), true);
  assert.equal(Number.isFinite(Date.parse(status.requestedAt)), true);
});

test("verified backup completes under the shared lease and host staging starts only after release", async (t) => {
  const fixture = workflowFixture(t);
  const pending = pendingSystemWorkflowRequest(fixture.config);
  assert.equal(pending.path, fixture.requestPath);
  const lock = acquireLock(fixture.config);
  assert.ok(lock);
  const backupTimeouts = [];
  await prepareSystemWorkflow(fixture.config, pending, {
    compose: async (config, args, timeoutMs) => {
      if (args.includes("stugu-backup")) backupTimeouts.push(timeoutMs);
      return fixture.compose(config, args, timeoutMs);
    },
  });
  assert.deepEqual(backupTimeouts, [24 * 60 * 60_000]);
  assert.equal(readSystemWorkflowJournal(fixture.config).phase, "backup-complete");
  assert.equal(existsSync(fixture.requestPath), false);
  assert.equal(readdirSync(fixture.paths.bridgeRequests).length, 0);
  assert.equal(existsSync(join(fixture.operationsDirectory, "agent.lock")), true);
  await advanceSystemWorkflow(fixture.config);
  assert.equal(readSystemWorkflowJournal(fixture.config).phase, "backup-complete");
  assert.equal(readdirSync(fixture.paths.bridgeRequests).length, 0);

  releaseLock(lock);
  await advanceSystemWorkflow(fixture.config);

  const journal = readSystemWorkflowJournal(fixture.config);
  assert.equal(journal.phase, "host-stage-requested");
  assert.equal(existsSync(join(fixture.operationsDirectory, "agent.lock")), false);
  const bridgeRequest = JSON.parse(readFileSync(
    join(fixture.paths.bridgeRequests, journal.bridgeRequestFile),
    "utf8",
  ));
  assert.deepEqual(bridgeRequest, {
    schema: "stugu-host-update-bridge-request/v1",
    id: journal.bridgeRequestId,
    requestedAt: journal.bridgeRequestedAt,
    operation: "stage",
    workflowId,
    channel: "stable",
    expectedVersion: "0.35.0",
    expectedGeneration: 7,
    expectedManifestSha256: "1".repeat(64),
  });
  const status = JSON.parse(readFileSync(fixture.paths.status, "utf8"));
  assert.equal(status.schema, "stugu-system-update-workflow-status/v1");
  assert.equal(status.backup.verified, true);
  assert.equal(status.backup.receipt.manifestSha256, "2".repeat(64));
  assert.ok(status.revision >= 4);
  assert.equal(status.cancellationEligible, false);
});

test("the agent waits for explicit activation and queues app only after exact host completion", async (t) => {
  const fixture = workflowFixture(t);
  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );
  await advanceSystemWorkflow(fixture.config);
  let journal = readSystemWorkflowJournal(fixture.config);
  rmSync(join(fixture.paths.bridgeRequests, journal.bridgeRequestFile));

  writeBridgeStatus(fixture.paths, "ready-to-restart");
  await advanceSystemWorkflow(fixture.config);
  journal = readSystemWorkflowJournal(fixture.config);
  assert.equal(journal.phase, "awaiting-restart");
  assert.equal(readdirSync(fixture.paths.bridgeRequests).length, 0);
  assert.equal(readdirSync(fixture.operationsDirectory).some((name) => /^request-.*\.json$/u.test(name)), false);
  let status = JSON.parse(readFileSync(fixture.paths.status, "utf8"));
  assert.equal(status.cancellationEligible, true);
  assert.equal(status.host.operationId, hostOperationId);

  writeBridgeStatus(fixture.paths, "verifying", { requestOperation: "activate" });
  await advanceSystemWorkflow(fixture.config);
  assert.equal(readSystemWorkflowJournal(fixture.config).phase, "host-verifying");
  assert.equal(readdirSync(fixture.paths.bridgeRequests).length, 0);
  assert.equal(readdirSync(fixture.operationsDirectory).some((name) => /^request-.*\.json$/u.test(name)), false);

  writeBridgeStatus(fixture.paths, "complete", { requestOperation: "activate" });
  await advanceSystemWorkflow(fixture.config);
  journal = readSystemWorkflowJournal(fixture.config);
  assert.equal(journal.phase, "application-queued");
  assert.equal(existsSync(join(fixture.operationsDirectory, `request-${appId}.json`)), true);
  status = JSON.parse(readFileSync(fixture.paths.status, "utf8"));
  assert.equal(status.host.targetGeneration, 7);
  assert.equal(status.app.operationId, appId);
});

test("host return and cancellation are terminal and never queue an application mutation", async (t) => {
  for (const phase of ["returned", "cancelled"]) {
    await t.test(phase, async (nested) => {
      const fixture = workflowFixture(nested);
      await prepareSystemWorkflow(
        fixture.config,
        pendingSystemWorkflowRequest(fixture.config),
        { compose: fixture.compose },
      );
      await advanceSystemWorkflow(fixture.config);
      const journal = readSystemWorkflowJournal(fixture.config);
      rmSync(join(fixture.paths.bridgeRequests, journal.bridgeRequestFile));
      writeBridgeStatus(fixture.paths, phase);
      await advanceSystemWorkflow(fixture.config);

      assert.equal(existsSync(fixture.paths.journal), false);
      assert.equal(existsSync(join(fixture.operationsDirectory, `request-${appId}.json`)), false);
      const status = JSON.parse(readFileSync(fixture.paths.status, "utf8"));
      assert.equal(status.phase, phase);
      assert.equal(status.error.code, phase === "returned" ? "HOST_UPDATE_RETURNED" : "HOST_UPDATE_CANCELLED");
    });
  }
});

test("a lost or mismatched native identity fails closed without app update", async (t) => {
  const fixture = workflowFixture(t);
  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );
  await advanceSystemWorkflow(fixture.config);
  const journal = readSystemWorkflowJournal(fixture.config);
  rmSync(join(fixture.paths.bridgeRequests, journal.bridgeRequestFile));
  writeBridgeStatus(fixture.paths, "ready-to-restart", {
    workflowId: "3da59bd7-3055-4521-af5b-297331881248",
    intentId: "3da59bd7-3055-4521-af5b-297331881248",
  });

  await advanceSystemWorkflow(fixture.config);

  assert.equal(readSystemWorkflowJournal(fixture.config).phase, "recovery-needed");
  assert.equal(existsSync(join(fixture.operationsDirectory, `request-${appId}.json`)), false);
  const status = JSON.parse(readFileSync(fixture.paths.status, "utf8"));
  assert.equal(status.recoveryRequired, true);
  assert.equal(status.error.code, "HOST_STATUS_IDENTITY_LOST");
});

test("native recovery-needed remains blocked and never queues the application", async (t) => {
  const fixture = workflowFixture(t);
  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );
  await advanceSystemWorkflow(fixture.config);
  const journal = readSystemWorkflowJournal(fixture.config);
  rmSync(join(fixture.paths.bridgeRequests, journal.bridgeRequestFile));
  writeBridgeStatus(fixture.paths, "recovery-needed", {
    detail: "Inactive slot reconciliation requires operator recovery",
    error: {
      code: "RECOVERY_NEEDED",
      message: "Inactive slot reconciliation requires operator recovery",
    },
  });

  await advanceSystemWorkflow(fixture.config);

  assert.equal(readSystemWorkflowJournal(fixture.config).phase, "recovery-needed");
  assert.equal(existsSync(join(fixture.operationsDirectory, `request-${appId}.json`)), false);
  assert.equal(JSON.parse(readFileSync(fixture.paths.status, "utf8")).recoveryRequired, true);
});

test("host completion cannot release app update with the wrong running generation", async (t) => {
  const fixture = workflowFixture(t);
  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );
  await advanceSystemWorkflow(fixture.config);
  const journal = readSystemWorkflowJournal(fixture.config);
  rmSync(join(fixture.paths.bridgeRequests, journal.bridgeRequestFile));
  writeBridgeStatus(fixture.paths, "complete", { currentGeneration: 6 });

  await advanceSystemWorkflow(fixture.config);

  assert.equal(readSystemWorkflowJournal(fixture.config).phase, "recovery-needed");
  assert.equal(existsSync(join(fixture.operationsDirectory, `request-${appId}.json`)), false);
  assert.equal(JSON.parse(readFileSync(fixture.paths.status, "utf8")).error.code, "HOST_GENERATION_MISMATCH");
});

test("a host-only workflow completes without manufacturing an app operation", async (t) => {
  const fixture = workflowFixture(t, null);
  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );
  await advanceSystemWorkflow(fixture.config);
  const journal = readSystemWorkflowJournal(fixture.config);
  rmSync(join(fixture.paths.bridgeRequests, journal.bridgeRequestFile));
  writeBridgeStatus(fixture.paths, "complete");

  await advanceSystemWorkflow(fixture.config);

  assert.equal(existsSync(fixture.paths.journal), false);
  assert.equal(readdirSync(fixture.operationsDirectory).some((name) => /^request-.*\.json$/u.test(name)), false);
  const status = JSON.parse(readFileSync(fixture.paths.status, "utf8"));
  assert.equal(status.phase, "complete");
  assert.equal(status.app, null);
});

test("an uncertain backup is durable recovery state and never reaches the bridge", async (t) => {
  const fixture = workflowFixture(t);
  const uncertainCompose = async (config, args) => {
    if (!args.includes("stugu-backup")) return fixture.compose(config, args);
    const error = new Error("backup command timed out");
    error.code = "COMMAND_TIMEOUT";
    error.processTreeTerminated = false;
    throw error;
  };

  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: uncertainCompose },
  );
  await advanceSystemWorkflow(fixture.config);

  assert.equal(readSystemWorkflowJournal(fixture.config).phase, "recovery-needed");
  assert.equal(readdirSync(fixture.paths.bridgeRequests).length, 0);
  assert.equal(JSON.parse(readFileSync(fixture.paths.status, "utf8")).error.code, "BACKUP_STATE_UNCERTAIN");
});

test("stage enqueue replays the same bounded intent after a crash", async (t) => {
  const fixture = workflowFixture(t);
  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );
  await advanceSystemWorkflow(fixture.config);
  const journal = readSystemWorkflowJournal(fixture.config);
  const requestPath = join(fixture.paths.bridgeRequests, journal.bridgeRequestFile);
  const expected = readFileSync(requestPath, "utf8");
  rmSync(requestPath);
  writeFileSync(fixture.paths.journal, JSON.stringify({
    ...journal,
    phase: "host-stage-queueing",
  }));

  await advanceSystemWorkflow(fixture.config);

  assert.equal(readFileSync(requestPath, "utf8"), expected);
  assert.equal(readSystemWorkflowJournal(fixture.config).bridgeRequestId, journal.bridgeRequestId);
});

test("application failure can retry only by reusing the embedded signed target", async (t) => {
  const fixture = workflowFixture(t);
  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );
  await advanceSystemWorkflow(fixture.config);
  let journal = readSystemWorkflowJournal(fixture.config);
  rmSync(join(fixture.paths.bridgeRequests, journal.bridgeRequestFile));
  writeBridgeStatus(fixture.paths, "complete");
  await advanceSystemWorkflow(fixture.config);
  rmSync(join(fixture.operationsDirectory, `request-${appId}.json`));
  writeFileSync(join(fixture.operationsDirectory, "status.json"), JSON.stringify({
    id: appId,
    phase: "failed",
    detail: "Candidate health check failed; previous application release restored.",
  }));
  await advanceSystemWorkflow(fixture.config);
  assert.equal(readSystemWorkflowJournal(fixture.config).phase, "application-failed");
  assert.equal(JSON.parse(readFileSync(fixture.paths.status, "utf8")).host.phase, "complete");

  const retryId = "194c45fe-42e9-46cf-89f8-12ed608695af";
  writeFileSync(join(fixture.paths.inbox, `request-${retryId}.json`), JSON.stringify({
    schema: "stugu-system-update-workflow-request/v1",
    id: retryId,
    action: "retry-application",
    requestedAt: "2026-08-04T09:00:00.000Z",
    workflowId,
  }));
  await advanceSystemWorkflow(fixture.config);

  journal = readSystemWorkflowJournal(fixture.config);
  assert.equal(journal.phase, "application-queued");
  assert.equal(journal.request.app.id, retryId);
  const retried = JSON.parse(readFileSync(join(fixture.operationsDirectory, `request-${retryId}.json`), "utf8"));
  assert.equal(retried.id, retryId);
  assert.deepEqual(retried.images, appRequest().images);
  assert.equal(existsSync(join(fixture.operationsDirectory, `request-${appId}.json`)), false);
});

test("application success completes the durable parent workflow across agent restarts", async (t) => {
  const fixture = workflowFixture(t);
  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );
  await advanceSystemWorkflow(fixture.config);
  let journal = readSystemWorkflowJournal(fixture.config);
  rmSync(join(fixture.paths.bridgeRequests, journal.bridgeRequestFile));
  writeBridgeStatus(fixture.paths, "verifying", { requestOperation: "activate" });
  await advanceSystemWorkflow(fixture.config);

  // A fresh config object models the update agent reconnecting after reboot.
  const restartedConfig = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: fixture.directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: fixture.operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
    SYSTEM_UPDATE_RUNTIME: "raspberry-pi",
    STUGA_HOST_UPDATE_JOURNAL: join(fixture.directory, "host-update-journal.json"),
  }, fixture.directory, []);
  writeBridgeStatus(fixture.paths, "complete", { requestOperation: "activate" });
  await advanceSystemWorkflow(restartedConfig);
  journal = readSystemWorkflowJournal(restartedConfig);
  assert.equal(journal.phase, "application-queued");
  rmSync(join(fixture.operationsDirectory, `request-${appId}.json`));
  writeFileSync(join(fixture.operationsDirectory, "status.json"), JSON.stringify({
    id: appId,
    phase: "complete",
    detail: "Stugu 0.6.0 is healthy",
  }));
  await advanceSystemWorkflow(restartedConfig);

  assert.equal(existsSync(fixture.paths.journal), false);
  const status = JSON.parse(readFileSync(fixture.paths.status, "utf8"));
  assert.equal(status.phase, "complete");
  assert.equal(status.completedAt !== null, true);
  assert.equal(status.app.phase, "complete");
});

test("Raspberry Pi heartbeats advertise the bounded unified host capability", (t) => {
  const fixture = workflowFixture(t);
  heartbeat(fixture.config, false, "Host probation in progress", "host-update-active");
  const value = JSON.parse(readFileSync(join(fixture.operationsDirectory, "agent-status.json"), "utf8"));
  assert.equal(value.agentVersion, "3.1.0");
  assert.equal(value.ready, false);
  assert.equal(value.systemUpdateReason, "host-update-active");
  assert.equal(value.capabilities.includes("unified-host-update-v1"), true);
});

test("an active unified workflow publishes a fresh busy heartbeat while remaining observable", async (t) => {
  const fixture = workflowFixture(t);
  await prepareSystemWorkflow(
    fixture.config,
    pendingSystemWorkflowRequest(fixture.config),
    { compose: fixture.compose },
  );
  const availability = await publishDockerHeartbeat(fixture.config, {
    runCommand: async () => "28.0.0",
  });
  const value = JSON.parse(readFileSync(join(fixture.operationsDirectory, "agent-status.json"), "utf8"));
  assert.deepEqual(availability, {
    ready: false,
    detail: "The unified system update is active; other mutations are paused.",
    dockerReady: true,
    workflowActive: true,
  });
  assert.equal(value.ready, false);
  assert.equal(value.systemUpdateReason, "system-update-workflow-active");
  assert.equal(value.capabilities.includes("unified-host-update-v1"), true);
});

test("invalid workflow journals remain visibly recovery-blocked", async (t) => {
  for (const kind of ["malformed", "oversized", "invalid-timestamps", "symlink"]) {
    await t.test(kind, async (nested) => {
      const fixture = workflowFixture(nested);
      rmSync(fixture.requestPath);
      if (kind === "malformed") writeFileSync(fixture.paths.journal, "{");
      else if (kind === "oversized") writeFileSync(fixture.paths.journal, "x".repeat(70 * 1024));
      else if (kind === "invalid-timestamps") {
        writeFileSync(fixture.paths.journal, JSON.stringify({
          id: workflowId,
          startedAt: "not-a-time",
          request: {
            id: workflowId,
            requestedAt: "also-not-a-time",
            host: fixture.request.host,
          },
        }));
      }
      else {
        const target = join(fixture.directory, "foreign-journal.json");
        writeFileSync(target, JSON.stringify({ schema: "untrusted" }));
        try {
          symlinkSync(target, fixture.paths.journal, "file");
        } catch (error) {
          if (error?.code === "EPERM") {
            nested.skip("File symlinks require Windows developer mode");
            return;
          }
          throw error;
        }
      }

      await advanceSystemWorkflow(fixture.config);

      assert.equal(existsSync(fixture.paths.journal), true);
      assert.equal(pendingWork(fixture.config), null);
      const status = JSON.parse(readFileSync(fixture.paths.status, "utf8"));
      assert.equal(status.phase, "recovery-needed");
      assert.equal(status.recoveryRequired, true);
      assert.equal(status.error.code, "WORKFLOW_JOURNAL_INVALID");
      assert.equal(status.requestedAt.endsWith("Z"), true);
      assert.equal(status.startedAt.endsWith("Z"), true);
      assert.equal(Number.isFinite(Date.parse(status.requestedAt)), true);
      assert.equal(Number.isFinite(Date.parse(status.startedAt)), true);
    });
  }
});
