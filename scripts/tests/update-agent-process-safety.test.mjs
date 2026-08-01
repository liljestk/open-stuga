import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyRequest,
  readAgentConfig,
  runCommand,
  validatedRequest,
} from "../stugu-update-agent.mjs";
import {
  removeFileDurable,
  releaseEnvironment as requestReleaseEnvironment,
  writeReleaseEnvironmentAtomic,
  writeTextDurableAtomic,
} from "../stugu-update-agent/configuration-request.mjs";
import {
  updateJournal,
  updateJournalPath,
  writeUpdateJournal,
} from "../stugu-update-agent/update-loop.mjs";

function updateRequest() {
  const version = "0.6.0";
  return {
    schema: "stugu-system-update-request/v3",
    id: "27974c49-f62e-4365-9ee7-802c7488557e",
    version,
    tagName: `v${version}`,
    repository: "liljestk/open-stuga",
    requestedAt: "2026-07-23T18:00:00.000Z",
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

function rollbackReleaseEnvironment(version) {
  return [
    "STUGA_RELEASE_ENV_SCHEMA=3",
    "STUGA_UPDATE_AGENT_CONTRACT=3",
    "STUGA_COMPOSE_CONTRACT=2",
    `STUGA_VERSION=${version}`,
    `STUGA_API_IMAGE=ghcr.io/liljestk/open-stuga-api:v${version}@sha256:${"1".repeat(64)}`,
    `STUGA_WEB_IMAGE=ghcr.io/liljestk/open-stuga-web:v${version}@sha256:${"2".repeat(64)}`,
    `STUGA_BACKUP_IMAGE=ghcr.io/liljestk/open-stuga-backup:v${version}@sha256:${"3".repeat(64)}`,
    `STUGA_TAPO_RUNNER_IMAGE=ghcr.io/liljestk/open-stuga-tapo-export-runner:v${version}@sha256:${"4".repeat(64)}`,
    `STUGA_UPDATE_AGENT_IMAGE=ghcr.io/liljestk/open-stuga-update-agent:v${version}@sha256:${"5".repeat(64)}`,
    `STUGA_MQTT_IMAGE=ghcr.io/liljestk/open-stuga-mqtt:v${version}@sha256:${"6".repeat(64)}`,
    `STUGA_NEXUS433_IMAGE=ghcr.io/liljestk/open-stuga-nexus433:v${version}@sha256:${"7".repeat(64)}`,
    "",
  ].join("\n");
}

test("durable atomic writes fsync data before rename and then flush renamed state", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-durable-atomic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  let opens = 0;
  writeTextDurableAtomic(join(directory, "journal.json"), "{}\n", 0o600, null, {
    openSync: () => {
      opens += 1;
      calls.push(opens === 1 ? "open-file" : "open-barrier");
      return opens;
    },
    writeFileSync: () => calls.push("write"),
    fchmodSync: () => calls.push("chmod"),
    fsyncSync: (descriptor) => calls.push(descriptor === 1 ? "fsync-file" : "fsync-barrier"),
    closeSync: (descriptor) => calls.push(descriptor === 1 ? "close-file" : "close-barrier"),
    renameSync: () => calls.push("rename"),
    rmSync: () => calls.push("remove"),
  });
  assert.deepEqual(calls, [
    "open-file",
    "write",
    "chmod",
    "fsync-file",
    "close-file",
    "rename",
    "open-barrier",
    "fsync-barrier",
    "close-barrier",
  ]);
});

test("durable removal unlinks the file before fsyncing its directory", {
  skip: process.platform === "win32",
}, () => {
  const calls = [];
  removeFileDurable("/unused/update-journal.json", {
    rmSync: () => calls.push("remove"),
    openSync: () => {
      calls.push("open-directory");
      return 1;
    },
    fsyncSync: () => calls.push("fsync-directory"),
    closeSync: () => calls.push("close-directory"),
  });
  assert.deepEqual(calls, [
    "remove",
    "open-directory",
    "fsync-directory",
    "close-directory",
  ]);
});

test("release environment writes are durable before recovery state can be removed", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-release-durable-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  let opens = 0;
  writeReleaseEnvironmentAtomic(join(directory, "release.env"), "STUGA_VERSION=1.0.0\n", {
    openSync: () => {
      opens += 1;
      calls.push(opens === 1 ? "open-file" : "open-barrier");
      return opens;
    },
    writeFileSync: () => calls.push("write"),
    fchmodSync: () => calls.push("chmod"),
    fchownSync: () => calls.push("chown"),
    fsyncSync: (descriptor) => calls.push(descriptor === 1 ? "fsync-file" : "fsync-barrier"),
    closeSync: (descriptor) => calls.push(descriptor === 1 ? "close-file" : "close-barrier"),
    renameSync: () => calls.push("rename"),
    rmSync: () => calls.push("remove"),
  });
  assert.ok(calls.indexOf("fsync-file") < calls.indexOf("rename"));
  assert.ok(calls.indexOf("rename") < calls.indexOf("fsync-barrier"));
});

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test("command timeout terminates the mutator process tree before rejecting", {
  timeout: 20_000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-command-timeout-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const parentPidPath = join(directory, "parent.pid");
  const childPidPath = join(directory, "child.pid");
  const childSource = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const parentSource = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));`,
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("\n");

  await assert.rejects(
    runCommand(process.execPath, ["-e", parentSource], {
      timeoutMs: 500,
      terminationGraceMs: 150,
      terminationWaitMs: 2_000,
    }),
    (error) => error?.code === "COMMAND_TIMEOUT"
      && error.processTreeTerminated === true,
  );

  const parentPid = Number(readFileSync(parentPidPath, "utf8"));
  const childPid = Number(readFileSync(childPidPath, "utf8"));
  t.after(() => {
    for (const pid of [parentPid, childPid]) {
      if (processIsAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });
  assert.equal(processIsAlive(parentPid), false);
  assert.equal(processIsAlive(childPid), false);
});

test("command timeout stays bounded when an escaped descendant retains output handles", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-command-escaped-output-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const escapedPidPath = join(directory, "escaped.pid");
  const escapedSource = "setInterval(() => {}, 1000);";
  const parentSource = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const escaped = spawn(process.execPath, ['-e', ${JSON.stringify(escapedSource)}], {`,
    "  detached: true,",
    "  stdio: ['ignore', process.stdout, process.stderr],",
    "});",
    `fs.writeFileSync(${JSON.stringify(escapedPidPath)}, String(escaped.pid));`,
    "escaped.unref();",
    "setInterval(() => {}, 1000);",
  ].join("\n");

  const startedAt = Date.now();
  await assert.rejects(
    runCommand(process.execPath, ["-e", parentSource], {
      timeoutMs: 500,
      terminationGraceMs: 150,
      terminationWaitMs: 500,
      terminationCloseWaitMs: 200,
    }),
    (error) => error?.code === "COMMAND_TIMEOUT"
      && error.processTreeTerminated === false
      && /inherited output handles/u.test(error.message),
  );
  assert.ok(Date.now() - startedAt < 5_000);

  const escapedPid = Number(readFileSync(escapedPidPath, "utf8"));
  assert.equal(processIsAlive(escapedPid), true);
  t.after(() => {
    if (processIsAlive(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch { /* already gone */ }
    }
  });
});

test("successful command completion stays bounded when a descendant retains output handles", {
  timeout: 15_000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-command-success-escaped-output-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const escapedPidPath = join(directory, "escaped.pid");
  const escapedSource = "setInterval(() => {}, 1000);";
  const parentSource = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const escaped = spawn(process.execPath, ['-e', ${JSON.stringify(escapedSource)}], {`,
    "  detached: true,",
    "  stdio: ['ignore', process.stdout, process.stderr],",
    "});",
    `fs.writeFileSync(${JSON.stringify(escapedPidPath)}, String(escaped.pid));`,
    "escaped.unref();",
    "process.stdout.write('complete');",
  ].join("\n");

  let escapedPid = null;
  try {
    const startedAt = Date.now();
    const output = await runCommand(process.execPath, ["-e", parentSource], {
      timeoutMs: 30_000,
      exitCloseWaitMs: 150,
    });
    escapedPid = Number(readFileSync(escapedPidPath, "utf8"));
    assert.equal(output, "complete");
    assert.ok(Date.now() - startedAt < 10_000);
    assert.equal(processIsAlive(escapedPid), true);
  } finally {
    if (escapedPid !== null && processIsAlive(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("Windows accepts nonzero taskkill status once the process is confirmed gone", {
  skip: process.platform !== "win32",
  timeout: 10_000,
}, async () => {
  let taskkillCalls = 0;
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      timeoutMs: 150,
      terminationCloseWaitMs: 1_000,
      taskkill: async (pid) => {
        taskkillCalls += 1;
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        return { error: null, status: 1 };
      },
      processExists: () => false,
    }),
    (error) => error?.code === "COMMAND_TIMEOUT"
      && error.processTreeTerminated === true,
  );
  assert.equal(taskkillCalls, 1);
});

test("restart during a recorded Compose mutation blocks automatic rollback", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-journal-active-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  const request = updateRequest();
  const requestPath = join(operationsDirectory, "request-active.json");
  const previousRelease = rollbackReleaseEnvironment(request.previousVersion);
  writeFileSync(config.factoryReleaseEnvFile, previousRelease, "utf8");
  writeFileSync(config.releaseEnvFile, requestReleaseEnvironment(request), "utf8");
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  writeUpdateJournal(
    config,
    updateJournal(
      config,
      validatedRequest(request, config),
      requestPath,
      previousRelease,
      ["api", "web"],
      "mutation-active",
      "candidate-start",
    ),
  );

  let composeCalled = false;
  await applyRequest(config, null, {
    compose: async () => {
      composeCalled = true;
      assert.fail("uncertain mutation recovery must not start another Compose process");
    },
  });

  assert.equal(composeCalled, false);
  assert.equal(JSON.parse(readFileSync(updateJournalPath(config), "utf8")).phase, "mutation-active");
  assert.equal(existsSync(requestPath), true);
  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.match(status.detail, /candidate-start/u);
});

test("cleanup failure after the durable commit retries finalization without rollback", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-commit-cleanup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  const request = updateRequest();
  const requestPath = join(operationsDirectory, "request-commit-cleanup.json");
  const previousRelease = rollbackReleaseEnvironment(request.previousVersion);
  const candidateRelease = requestReleaseEnvironment(request);
  writeFileSync(config.factoryReleaseEnvFile, previousRelease, "utf8");
  writeFileSync(requestPath, JSON.stringify(request), "utf8");

  let versionChecks = 0;
  const startedReleases = [];
  const compose = async (_config, args) => {
    if (args[0] === "ps") return "api\nweb";
    if (args[0] === "exec") {
      versionChecks += 1;
      return versionChecks === 1 ? request.previousVersion : request.version;
    }
    if (args.includes("stugu-backup") || args[0] === "pull") return "";
    if (args[0] === "up") {
      startedReleases.push(readFileSync(config.releaseEnvFile, "utf8"));
      return "";
    }
    assert.fail(`Unexpected Compose call: ${args.join(" ")}`);
  };

  await applyRequest(config, requestPath, {
    compose,
    removeFileDurable: () => {
      throw new Error("simulated post-commit cleanup failure");
    },
  });

  assert.equal(readFileSync(config.releaseEnvFile, "utf8"), candidateRelease);
  assert.equal(readFileSync(config.knownGoodReleaseEnvFile, "utf8"), candidateRelease);
  assert.equal(JSON.parse(readFileSync(updateJournalPath(config), "utf8")).phase, "verified");
  assert.equal(existsSync(requestPath), true);
  assert.deepEqual(startedReleases, [candidateRelease]);

  await applyRequest(config, null, { compose });

  assert.deepEqual(startedReleases, [candidateRelease, candidateRelease]);
  assert.equal(readFileSync(config.releaseEnvFile, "utf8"), candidateRelease);
  assert.equal(readFileSync(config.knownGoodReleaseEnvFile, "utf8"), candidateRelease);
  assert.equal(existsSync(requestPath), false);
  assert.equal(existsSync(updateJournalPath(config)), false);
  assert.equal(JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8")).phase, "complete");
});
