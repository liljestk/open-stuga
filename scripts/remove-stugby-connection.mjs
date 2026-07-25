#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const maximumCapturedBytes = 1024 * 1024;
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

const usage = `Usage:
  npm run stugby:remove -- \\
    --id <stugby-uuid> \\
    --name "<exact Stugby name>" \\
    --confirm <same-stugby-uuid> \\
    [--detach-links] \\
    [--container-cli docker|podman]

This maintenance command is only for an orphaned or broken Stugby that cannot
be removed through Stuga. It creates a verified full backup, stops SQLite
writers, removes the exact Stugby record, preserves Home and Property rows, and
restarts the services it stopped.

--detach-links is required when a matching Home or Property still carries
Stugby metadata. It clears that metadata; it does not delete those records.
An adopted Property must be permanently disconnected through Stuga first.
`;

const inspectionProgram = String.raw`
import { DatabaseSync } from "node:sqlite";

const id = process.env.TARGET_STUGBY_ID;
const expectedName = process.env.TARGET_STUGBY_NAME;
const database = new DatabaseSync("/app/data/climate-twin.sqlite", { readOnly: true });
try {
  database.exec("PRAGMA busy_timeout = 10000");
  const target = database.prepare(
    "SELECT id,name,is_coordinator AS isCoordinator,local_member_state AS localState FROM stugby_federations WHERE id=?",
  ).get(id);
  if (!target) throw new Error("The exact Stugby id was not found");
  if (target.name !== expectedName) throw new Error("The Stugby name does not match the expected name");
  const adoption = database.prepare(
    "SELECT state,local_property_id AS localPropertyId FROM stugby_property_adoptions WHERE stugby_id=?",
  ).get(id) ?? null;
  const result = {
    target,
    adoption,
    members: Number(database.prepare(
      "SELECT COUNT(*) AS count FROM stugby_members WHERE stugby_id=?",
    ).get(id).count),
    grants: Number(database.prepare(
      "SELECT COUNT(*) AS count FROM stugby_share_grants WHERE stugby_id=?",
    ).get(id).count),
    legacyGrants: Number(database.prepare(
      "SELECT COUNT(*) AS count FROM stugby_share_grants WHERE stugby_id=? AND json_type(grant_json,'$.housePolicy') IS NULL",
    ).get(id).count),
    linkedProperties: Number(database.prepare(
      "SELECT COUNT(*) AS count FROM properties WHERE stugby_json IS NOT NULL AND json_extract(stugby_json,'$.stugbyId')=?",
    ).get(id).count),
    linkedHomes: Number(database.prepare(
      "SELECT COUNT(*) AS count FROM houses WHERE stugby_json IS NOT NULL AND json_extract(stugby_json,'$.stugbyId')=?",
    ).get(id).count),
  };
  console.log(JSON.stringify(result));
} finally {
  database.close();
}
`;

const cleanupProgram = String.raw`
import { DatabaseSync } from "node:sqlite";
import { StugbyStore } from "/app/apps/api/dist/stugby/store.js";

const id = process.env.TARGET_STUGBY_ID;
const expectedName = process.env.TARGET_STUGBY_NAME;
const database = new DatabaseSync("/app/data/climate-twin.sqlite");
try {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000");
  const store = new StugbyStore(database, "stugby-maintenance");
  const target = store.getStugby(id);
  if (!target) throw new Error("The exact Stugby id was not found after stopping the API");
  if (target.name !== expectedName) throw new Error("The Stugby name changed after inspection");
  const adoption = store.getPropertyAdoption(id);
  if (adoption?.state === "adopted") {
    throw new Error("An adopted Property must be permanently disconnected before removing this Stugby");
  }

  const detachedProperties = Number(database.prepare(
    "UPDATE properties SET stugby_json=NULL WHERE stugby_json IS NOT NULL AND json_extract(stugby_json,'$.stugbyId')=?",
  ).run(id).changes);
  const detachedHomes = Number(database.prepare(
    "UPDATE houses SET stugby_json=NULL WHERE stugby_json IS NOT NULL AND json_extract(stugby_json,'$.stugbyId')=?",
  ).run(id).changes);
  const queuedBlobs = store.deleteStugby(id).length;

  const remaining = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM stugby_federations WHERE id=?",
  ).get(id).count);
  const integrity = database.prepare("PRAGMA quick_check").get().quick_check;
  if (remaining !== 0) throw new Error("The Stugby record still exists after cleanup");
  if (integrity !== "ok") throw new Error("SQLite quick_check failed after cleanup");

  console.log(JSON.stringify({
    removed: { id: target.id, name: target.name },
    detachedProperties,
    detachedHomes,
    queuedBlobs,
    integrity,
  }));
} finally {
  database.close();
}
`;

const verificationProgram = String.raw`
import { DatabaseSync } from "node:sqlite";

const id = process.env.TARGET_STUGBY_ID;
const database = new DatabaseSync("/app/data/climate-twin.sqlite", { readOnly: true });
try {
  database.exec("PRAGMA busy_timeout = 10000");
  const result = {
    stugbys: Number(database.prepare(
      "SELECT COUNT(*) AS count FROM stugby_federations WHERE id=?",
    ).get(id).count),
    grants: Number(database.prepare(
      "SELECT COUNT(*) AS count FROM stugby_share_grants WHERE stugby_id=?",
    ).get(id).count),
    propertyLinks: Number(database.prepare(
      "SELECT COUNT(*) AS count FROM properties WHERE stugby_json IS NOT NULL AND json_extract(stugby_json,'$.stugbyId')=?",
    ).get(id).count),
    homeLinks: Number(database.prepare(
      "SELECT COUNT(*) AS count FROM houses WHERE stugby_json IS NOT NULL AND json_extract(stugby_json,'$.stugbyId')=?",
    ).get(id).count),
    integrity: database.prepare("PRAGMA quick_check").get().quick_check,
  };
  if (result.stugbys || result.grants || result.propertyLinks || result.homeLinks || result.integrity !== "ok") {
    throw new Error("Post-restart verification failed");
  }
  console.log(JSON.stringify(result));
} finally {
  database.close();
}
`;

export function parseRemoveStugbyArgs(argv, root = scriptRoot) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      id: { type: "string" },
      name: { type: "string" },
      confirm: { type: "string" },
      "detach-links": { type: "boolean", default: false },
      "container-cli": { type: "string", default: "docker" },
      "project-directory": { type: "string", default: root },
      "compose-file": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };

  const id = values.id?.trim().toLowerCase();
  const name = values.name?.trim();
  const confirmation = values.confirm?.trim().toLowerCase();
  if (!id || !uuidPattern.test(id)) throw new Error("--id must be an exact Stugby UUID");
  if (!name || name.length > 200) throw new Error("--name must be the exact Stugby name");
  if (confirmation !== id) throw new Error("--confirm must repeat the exact Stugby UUID");
  if (!["docker", "podman"].includes(values["container-cli"])) {
    throw new Error("--container-cli must be docker or podman");
  }

  const projectDirectory = resolve(values["project-directory"]);
  const composeFile = resolve(projectDirectory, values["compose-file"] ?? "docker-compose.yml");
  if (!existsSync(composeFile)) throw new Error(`Compose file not found: ${composeFile}`);
  return {
    id,
    name,
    detachLinks: values["detach-links"],
    containerCli: values["container-cli"],
    projectDirectory,
    composeFile,
  };
}

function appendBounded(chunks, chunk, state) {
  state.bytes += chunk.length;
  if (state.bytes > maximumCapturedBytes) {
    throw new Error("Command output exceeded the maintenance safety limit");
  }
  chunks.push(chunk);
}

export function runProcess(command, arguments_, {
  cwd = scriptRoot,
  input,
  capture = false,
} = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: [
        input === undefined ? "ignore" : "pipe",
        capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });
    const stdout = [];
    const stderr = [];
    const outputState = { bytes: 0 };
    const errorState = { bytes: 0 };
    child.stdout?.on("data", (chunk) => {
      try {
        appendBounded(stdout, chunk, outputState);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.stderr?.on("data", (chunk) => {
      try {
        appendBounded(stderr, chunk, errorState);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.on("error", reject);
    child.on("close", (status) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (status === 0) {
        accept({ stdout: stdoutText, stderr: stderrText });
        return;
      }
      reject(new Error(
        `${command} ${arguments_.join(" ")} failed with exit code ${status}${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
      ));
    });
    if (input !== undefined) {
      child.stdin.on("error", reject);
      child.stdin.end(input);
    }
  });
}

function composeArguments(options, ...arguments_) {
  return [
    "compose",
    "--project-directory",
    options.projectDirectory,
    "--file",
    options.composeFile,
    ...arguments_,
  ];
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function runningApiContainer(options, runCommand) {
  const result = await runCommand(options.containerCli, composeArguments(
    options,
    "ps",
    "--status",
    "running",
    "--quiet",
    "api",
  ), { cwd: options.projectDirectory, capture: true });
  const containers = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (containers.length !== 1) throw new Error("Exactly one running Stuga API container is required");
  return containers[0];
}

async function executeInApi(options, runCommand, container, program) {
  return runCommand(options.containerCli, [
    "exec",
    "-i",
    "-e",
    `TARGET_STUGBY_ID=${options.id}`,
    "-e",
    `TARGET_STUGBY_NAME=${options.name}`,
    container,
    "node",
    "--no-warnings",
    "--input-type=module",
  ], {
    cwd: options.projectDirectory,
    input: program,
    capture: true,
  });
}

async function waitForApi(options, runCommand, sleep) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const container = await runningApiContainer(options, runCommand);
      const status = await runCommand(options.containerCli, [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        container,
      ], { cwd: options.projectDirectory, capture: true });
      if (["healthy", "running"].includes(status.stdout.trim())) return container;
      if (status.stdout.trim() === "unhealthy") throw new Error("Stuga API became unhealthy after restart");
    } catch (error) {
      if (attempt === 59) throw error;
    }
    await sleep(1_000);
  }
  throw new Error("Stuga API did not become healthy after restart");
}

export async function removeStugbyConnection(options, {
  runCommand = runProcess,
  sleep = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds)),
  write = (message) => process.stdout.write(`${message}\n`),
} = {}) {
  const runningServicesResult = await runCommand(options.containerCli, composeArguments(
    options,
    "ps",
    "--status",
    "running",
    "--services",
  ), { cwd: options.projectDirectory, capture: true });
  const runningServices = new Set(
    runningServicesResult.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
  );
  const schedulerWasRunning = runningServices.has("stuga-backup-scheduler");
  const apiContainer = await runningApiContainer(options, runCommand);
  const inspectionResult = await executeInApi(options, runCommand, apiContainer, inspectionProgram);
  const inspection = parseJsonOutput(inspectionResult.stdout, "Stugby inspection");
  if (inspection.adoption?.state === "adopted") {
    throw new Error("The Stugby has an adopted Property; permanently disconnect it through Stuga first");
  }
  if ((inspection.linkedProperties > 0 || inspection.linkedHomes > 0) && !options.detachLinks) {
    throw new Error(
      `The Stugby has ${inspection.linkedProperties} linked Properties and ${inspection.linkedHomes} linked Homes; rerun with --detach-links to preserve those records and clear only their Stugby metadata`,
    );
  }

  write(`Target verified: ${inspection.target.name} (${inspection.target.id})`);
  write(
    `Stored state: ${inspection.members} members, ${inspection.grants} grants (${inspection.legacyGrants} legacy), `
    + `${inspection.linkedProperties} linked Properties, ${inspection.linkedHomes} linked Homes`,
  );
  write("Creating and verifying a complete backup under backups/...");
  await runCommand(options.containerCli, composeArguments(
    options,
    "--profile",
    "maintenance",
    "run",
    "--rm",
    "-T",
    "stuga-backup",
  ), { cwd: options.projectDirectory });
  write("Backup verified. Treat it as sensitive and keep an encrypted off-host copy.");

  const servicesToStop = [...(schedulerWasRunning ? ["stuga-backup-scheduler"] : []), "api"];
  let stopped = false;
  let operationError;
  let cleanup;
  let verification;
  try {
    write(`Stopping SQLite writers: ${servicesToStop.join(", ")}`);
    // A Compose stop can partially succeed before reporting a later failure.
    // From this point onward, always attempt to restore the original services.
    stopped = true;
    await runCommand(options.containerCli, composeArguments(options, "stop", ...servicesToStop), {
      cwd: options.projectDirectory,
    });
    const cleanupResult = await runCommand(options.containerCli, composeArguments(
      options,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "node",
      "-e",
      `TARGET_STUGBY_ID=${options.id}`,
      "-e",
      `TARGET_STUGBY_NAME=${options.name}`,
      "api",
      "--no-warnings",
      "--input-type=module",
    ), {
      cwd: options.projectDirectory,
      input: cleanupProgram,
      capture: true,
    });
    cleanup = parseJsonOutput(cleanupResult.stdout, "Stugby cleanup");
  } catch (error) {
    operationError = error;
  }

  let restartError;
  if (stopped) {
    try {
      write("Restarting Stuga API...");
      await runCommand(options.containerCli, composeArguments(options, "start", "api"), {
        cwd: options.projectDirectory,
      });
      const restartedApi = await waitForApi(options, runCommand, sleep);
      if (!operationError) {
        const verificationResult = await executeInApi(
          options,
          runCommand,
          restartedApi,
          verificationProgram,
        );
        verification = parseJsonOutput(verificationResult.stdout, "Post-restart verification");
      }
    } catch (error) {
      restartError = error;
    }
    if (schedulerWasRunning) {
      try {
        await runCommand(options.containerCli, composeArguments(
          options,
          "start",
          "stuga-backup-scheduler",
        ), { cwd: options.projectDirectory });
      } catch (error) {
        restartError = restartError
          ? new Error(`${errorMessage(restartError)}; backup scheduler restart failed: ${errorMessage(error)}`)
          : error;
      }
    }
  }

  if (operationError) {
    if (restartError) {
      throw new Error(
        `${errorMessage(operationError)}; service restart also failed: ${errorMessage(restartError)}`,
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (restartError) throw restartError;
  write(
    `Removed ${cleanup.removed.name}; detached ${cleanup.detachedProperties} Properties and `
    + `${cleanup.detachedHomes} Homes without deleting them.`,
  );
  write("SQLite integrity and post-restart checks passed.");
  return { inspection, cleanup, verification };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseRemoveStugbyArgs(argv);
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  await removeStugbyConnection(options);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Stugby removal failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
