import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseRemoveStugbyArgs,
  removeStugbyConnection,
} from "../remove-stugby-connection.mjs";

const stugbyId = "270f37d6-42ba-42ae-bf30-583a695cd3d5";

function temporaryProject(t) {
  const directory = mkdtempSync(join(tmpdir(), "stuga-remove-stugby-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "docker-compose.yml"), "services: {}\n");
  return directory;
}

function options(overrides = {}) {
  return {
    id: stugbyId,
    name: "My Stugby",
    detachLinks: true,
    containerCli: "docker",
    projectDirectory: "/stuga",
    composeFile: "/stuga/docker-compose.yml",
    ...overrides,
  };
}

function commandKind(arguments_) {
  if (arguments_[0] === "exec") return "exec";
  if (arguments_[0] === "inspect") return "inspect";
  const composeCommand = arguments_.slice(arguments_.indexOf("--file") + 2);
  if (composeCommand[0] === "ps" && composeCommand.includes("--services")) return "services";
  if (composeCommand[0] === "ps" && composeCommand.includes("--quiet")) return "api-container";
  if (composeCommand[0] === "--profile") return "backup";
  if (composeCommand[0] === "stop") return "stop";
  if (composeCommand[0] === "run") return "cleanup";
  if (composeCommand[0] === "start" && composeCommand.includes("api")) return "start-api";
  if (composeCommand[0] === "start" && composeCommand.includes("stuga-backup-scheduler")) {
    return "start-scheduler";
  }
  throw new Error(`Unexpected command: ${arguments_.join(" ")}`);
}

function mockRuntime({
  linkedHomes = 1,
  linkedProperties = 0,
  cleanupFailure = null,
  stopFailure = null,
} = {}) {
  const calls = [];
  let execCalls = 0;
  const inspection = {
    target: {
      id: stugbyId,
      name: "My Stugby",
      isCoordinator: 0,
      localState: "active",
    },
    adoption: null,
    members: 2,
    grants: 2,
    legacyGrants: 2,
    linkedProperties,
    linkedHomes,
  };
  const cleanup = {
    removed: { id: stugbyId, name: "My Stugby" },
    detachedProperties: linkedProperties,
    detachedHomes: linkedHomes,
    queuedBlobs: 0,
    integrity: "ok",
  };
  const verification = {
    stugbys: 0,
    grants: 0,
    propertyLinks: 0,
    homeLinks: 0,
    integrity: "ok",
  };
  return {
    calls,
    async runCommand(command, arguments_, commandOptions = {}) {
      const kind = commandKind(arguments_);
      calls.push({ command, arguments_, commandOptions, kind });
      if (kind === "services") return { stdout: "api\nweb\nstuga-backup-scheduler\n", stderr: "" };
      if (kind === "api-container") return { stdout: "api-container-id\n", stderr: "" };
      if (kind === "exec") {
        execCalls += 1;
        return {
          stdout: `${JSON.stringify(execCalls === 1 ? inspection : verification)}\n`,
          stderr: "",
        };
      }
      if (kind === "cleanup") {
        if (cleanupFailure) throw cleanupFailure;
        return { stdout: `${JSON.stringify(cleanup)}\n`, stderr: "" };
      }
      if (kind === "stop" && stopFailure) throw stopFailure;
      if (kind === "inspect") return { stdout: "healthy\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
}

test("CLI requires matching identity, name, and confirmation", (t) => {
  const project = temporaryProject(t);
  assert.throws(
    () => parseRemoveStugbyArgs([
      "--id", stugbyId,
      "--name", "My Stugby",
      "--confirm", "170f37d6-42ba-42ae-bf30-583a695cd3d5",
      "--project-directory", project,
    ]),
    /--confirm must repeat the exact Stugby UUID/u,
  );
  assert.throws(
    () => parseRemoveStugbyArgs([
      "--id", "not-an-id",
      "--name", "My Stugby",
      "--confirm", "not-an-id",
      "--project-directory", project,
    ]),
    /--id must be an exact Stugby UUID/u,
  );

  const parsed = parseRemoveStugbyArgs([
    "--id", stugbyId,
    "--name", "My Stugby",
    "--confirm", stugbyId,
    "--detach-links",
    "--project-directory", project,
  ]);
  assert.equal(parsed.id, stugbyId);
  assert.equal(parsed.name, "My Stugby");
  assert.equal(parsed.detachLinks, true);
  assert.equal(parsed.composeFile, join(project, "docker-compose.yml"));
});

test("cleanup backs up before stopping and verifies after restart", async () => {
  const runtime = mockRuntime();
  const result = await removeStugbyConnection(options(), {
    runCommand: runtime.runCommand,
    sleep: async () => {},
    write: () => {},
  });
  const kinds = runtime.calls.map((call) => call.kind);
  assert.ok(kinds.indexOf("backup") < kinds.indexOf("stop"));
  assert.ok(kinds.indexOf("stop") < kinds.indexOf("cleanup"));
  assert.ok(kinds.indexOf("cleanup") < kinds.indexOf("start-api"));
  assert.ok(kinds.lastIndexOf("exec") > kinds.indexOf("start-api"));
  assert.ok(kinds.indexOf("start-scheduler") > kinds.indexOf("start-api"));
  assert.equal(result.cleanup.detachedHomes, 1);

  const stop = runtime.calls.find((call) => call.kind === "stop");
  assert.ok(stop.arguments_.indexOf("stuga-backup-scheduler") < stop.arguments_.indexOf("api"));
  const cleanup = runtime.calls.find((call) => call.kind === "cleanup");
  assert.match(cleanup.commandOptions.input, /PRAGMA foreign_keys = ON/u);
  assert.match(cleanup.commandOptions.input, /UPDATE houses SET stugby_json=NULL/u);
  assert.match(cleanup.commandOptions.input, /store\.deleteStugby\(id\)/u);
});

test("linked records require an explicit detach acknowledgement", async () => {
  const runtime = mockRuntime({ linkedHomes: 1 });
  await assert.rejects(
    removeStugbyConnection(options({ detachLinks: false }), {
      runCommand: runtime.runCommand,
      sleep: async () => {},
      write: () => {},
    }),
    /rerun with --detach-links/u,
  );
  assert.equal(runtime.calls.some((call) => call.kind === "backup"), false);
  assert.equal(runtime.calls.some((call) => call.kind === "stop"), false);
});

test("a cleanup failure still restarts every stopped service", async () => {
  const runtime = mockRuntime({ cleanupFailure: new Error("simulated cleanup failure") });
  await assert.rejects(
    removeStugbyConnection(options(), {
      runCommand: runtime.runCommand,
      sleep: async () => {},
      write: () => {},
    }),
    /simulated cleanup failure/u,
  );
  const kinds = runtime.calls.map((call) => call.kind);
  assert.ok(kinds.includes("start-api"));
  assert.ok(kinds.includes("start-scheduler"));
  assert.equal(kinds.filter((kind) => kind === "exec").length, 1);
});

test("a partial Compose stop failure still attempts to restart every writer", async () => {
  const runtime = mockRuntime({ stopFailure: new Error("simulated partial stop failure") });
  await assert.rejects(
    removeStugbyConnection(options(), {
      runCommand: runtime.runCommand,
      sleep: async () => {},
      write: () => {},
    }),
    /simulated partial stop failure/u,
  );
  const kinds = runtime.calls.map((call) => call.kind);
  assert.ok(kinds.includes("start-api"));
  assert.ok(kinds.includes("start-scheduler"));
  assert.equal(kinds.includes("cleanup"), false);
});

test("an adopted Property is never removed by the maintenance path", async () => {
  const runtime = mockRuntime();
  const originalRun = runtime.runCommand;
  runtime.runCommand = async (command, arguments_, commandOptions) => {
    const result = await originalRun(command, arguments_, commandOptions);
    if (commandKind(arguments_) !== "exec") return result;
    const inspection = JSON.parse(result.stdout);
    inspection.adoption = { state: "adopted", localPropertyId: "property-1" };
    return { stdout: `${JSON.stringify(inspection)}\n`, stderr: "" };
  };
  await assert.rejects(
    removeStugbyConnection(options(), {
      runCommand: runtime.runCommand,
      sleep: async () => {},
      write: () => {},
    }),
    /permanently disconnect it through Stuga first/u,
  );
  assert.equal(runtime.calls.some((call) => call.kind === "backup"), false);
});
