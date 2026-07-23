#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createMigrationBundle,
  validateMigrationPlan,
} from "./stuga-migration-bundle.mjs";
import {
  assertReleaseVersion,
  assertMigrationId,
  compareReleaseVersions,
  isSha256,
  parseEnvironmentAssignments,
  validatedChunkSize,
} from "./stuga-migration-common.mjs";
import { hardenPrivateDirectory, hardenPrivateFile, sha256File } from "./sqlite-snapshot-utils.mjs";

const CUTOVER_FREE_SPACE_HEADROOM = 1024 * 1024 * 1024;

function help() {
  return `Live Stuga system-to-system migration

Usage:
  node scripts/stuga-live-migrate.mjs seed --target stuga@host --identity-file <private-key> [options]
  node scripts/stuga-live-migrate.mjs cutover --target stuga@host --identity-file <private-key> [options]
  node scripts/stuga-live-migrate.mjs status --target stuga@host --identity-file <private-key> --migration-id <uuid>

Phases:
  seed       Create a verified online snapshot and pre-stage content-addressed chunks while the source stays live.
  cutover    Stop source writers, create a final verified snapshot, transfer only missing chunks, apply on target,
             health-check the target, and leave the source stopped. A failed target apply rolls back and restarts source.
  status     Query a target migration receipt without changing either system.

Required:
  --target <user@host>       SSH target; normally stuga@stuga.local
  --identity-file <path>     Recovery SSH private key

Options:
  --ssh-port <port>          SSH port (default: 22)
  --known-hosts <path>       Dedicated known_hosts file
  --accept-new-host-key      Explicitly trust and record a previously unseen target key
  --backup <directory>       Reuse a verified backup for seed only
  --backup-root <directory>  Compose backup bind directory (default: STUGA_BACKUP_DIRECTORY or ./backups)
  --workspace <directory>    Private chunk cache (default: <backup-root>/.live-migration)
  --settings-file <file>     Source deployment environment (default: ./.env)
  --config-directory <dir>   Source config directory (default: ./config)
  --secrets-directory <dir>  Source secrets root (default: ./secrets; only known runtime directories migrate)
  --no-deployment-settings   Migrate application data/integration secrets but no host deployment overlay
  --chunk-size <bytes>       65536..16777216 (default: 4194304)
  --project-directory <dir>  Source Compose project (default: current directory)
  --compose-file <file>      Compose file (default: <project>/docker-compose.yml)
  --migration-id <uuid>      Required only for status
  -h, --help                 Show this help

SSH encrypts the transfer. Chunks, plans, backups, and rollback data remain confidential household data at rest;
protect both disks and keep the private key outside the target image.
`;
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function safeSshTarget(value) {
  if (typeof value !== "string" || value.startsWith("-") || value.includes(" ") || value.includes("\0")) {
    throw new Error("--target must be a safe SSH user/host without spaces or options");
  }
  if (!/^(?:[A-Za-z_][A-Za-z0-9_.-]{0,63}@)?(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.%]+\])$/u.test(value)) {
    throw new Error("--target must look like user@hostname, an IP address, or a bracketed IPv6 address");
  }
  return value;
}

function packageVersion(projectDirectory) {
  const manifest = JSON.parse(readFileSync(join(projectDirectory, "package.json"), "utf8"));
  return assertReleaseVersion(manifest.version, "Source version");
}

export function parseLiveMigrationArgs(argv, environment = process.env, cwd = process.cwd()) {
  const options = {
    phase: argv[0],
    acceptNewHostKey: false,
    deploymentSettings: true,
    help: false,
    explicit: new Set(),
  };
  if (options.phase === "-h" || options.phase === "--help" || options.phase === undefined) options.help = true;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--accept-new-host-key") options.acceptNewHostKey = true;
    else if (argument === "--no-deployment-settings") options.deploymentSettings = false;
    else if (["--target", "--identity-file", "--ssh-port", "--known-hosts", "--backup", "--backup-root", "--workspace",
      "--settings-file", "--config-directory", "--secrets-directory", "--chunk-size", "--project-directory", "--compose-file",
      "--migration-id"].includes(argument)) {
      const key = {
        "--target": "target", "--identity-file": "identityFile", "--ssh-port": "sshPort", "--known-hosts": "knownHosts",
        "--backup": "backup", "--backup-root": "backupRoot", "--workspace": "workspace", "--settings-file": "settingsFile",
        "--config-directory": "configDirectory", "--secrets-directory": "secretsDirectory", "--chunk-size": "chunkSize",
        "--project-directory": "projectDirectory", "--compose-file": "composeFile", "--migration-id": "migrationId",
      }[argument];
      options[key] = valueAfter(argv, index, argument);
      options.explicit.add(key);
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!["seed", "cutover", "status"].includes(options.phase)) throw new Error("First argument must be seed, cutover, or status");
  options.target = safeSshTarget(options.target);
  if (!options.identityFile) throw new Error("--identity-file is required");
  options.identityFile = resolve(cwd, options.identityFile);
  if (!existsSync(options.identityFile) || !statSync(options.identityFile).isFile()) throw new Error("SSH identity file does not exist or is not a regular file");
  options.sshPort = Number(options.sshPort ?? 22);
  if (!Number.isInteger(options.sshPort) || options.sshPort < 1 || options.sshPort > 65_535) throw new Error("--ssh-port must be from 1 to 65535");
  if (options.knownHosts) {
    options.knownHosts = resolve(cwd, options.knownHosts);
    mkdirSync(dirname(options.knownHosts), { recursive: true });
  }
  options.projectDirectory = resolve(cwd, options.projectDirectory ?? ".");
  options.composeFile = resolve(options.projectDirectory, options.composeFile ?? "docker-compose.yml");
  options.backupRoot = resolve(options.projectDirectory, options.backupRoot ?? environment.STUGA_BACKUP_DIRECTORY ?? "./backups");
  options.workspace = resolve(options.projectDirectory, options.workspace ?? join(options.backupRoot, ".live-migration"));
  options.settingsFile = resolve(options.projectDirectory, options.settingsFile ?? ".env");
  options.configDirectory = resolve(options.projectDirectory, options.configDirectory ?? "config");
  options.secretsDirectory = resolve(options.projectDirectory, options.secretsDirectory ?? "secrets");
  options.chunkSize = validatedChunkSize(options.chunkSize);
  if (options.backup) options.backup = resolve(options.projectDirectory, options.backup);
  if (options.phase === "cutover" && options.backup) throw new Error("Cutover always creates a fresh snapshot after stopping source writers; --backup is seed-only");
  if (options.phase !== "status") {
    if (!existsSync(options.composeFile)) throw new Error("Compose file does not exist");
    options.sourceVersion = packageVersion(options.projectDirectory);
  } else if (!options.migrationId) throw new Error("status requires --migration-id");
  else options.migrationId = assertMigrationId(options.migrationId);
  return options;
}

function run(executable, arguments_, { cwd, env = process.env, stream = false, stdin = "ignore" } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: [stdin, "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); if (stream) process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stream) process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) accept({ stdout, stderr });
      else reject(new Error(`${executable} exited with ${code}: ${stderr.trim().slice(0, 2_000) || stdout.trim().slice(0, 2_000)}`));
    });
  });
}

function sshOptions(options) {
  const strict = options.acceptNewHostKey ? "accept-new" : "yes";
  return [
    "-p", String(options.sshPort),
    "-i", options.identityFile,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", `StrictHostKeyChecking=${strict}`,
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    ...(options.knownHosts ? ["-o", `UserKnownHostsFile=${options.knownHosts}`] : []),
  ];
}

function parseLastJson(output, label) {
  const lines = String(output).trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* Compose may emit progress before the final machine result. */ }
  }
  throw new Error(`${label} did not return JSON`);
}

async function remoteJson(options, command, { stream = false } = {}) {
  const result = await run("ssh", [...sshOptions(options), options.target, ...command], { cwd: options.projectDirectory, stream });
  return parseLastJson(result.stdout, `Remote ${command.join(" ")}`);
}

function composeArguments(options, ...arguments_) {
  return ["compose", "--project-directory", options.projectDirectory, "--file", options.composeFile, ...arguments_];
}

function composeBindSource(configuration, serviceName, target) {
  const volumes = configuration?.services?.[serviceName]?.volumes;
  if (!Array.isArray(volumes)) return undefined;
  const volume = volumes.find((entry) => entry?.type === "bind" && entry?.target === target);
  return typeof volume?.source === "string" && volume.source ? resolve(volume.source) : undefined;
}

async function resolveComposeDeploymentInputs(options) {
  const result = await run("docker", composeArguments(options, "config", "--format", "json"), {
    cwd: options.projectDirectory,
  });
  let configuration;
  try {
    configuration = JSON.parse(result.stdout);
  } catch {
    throw new Error("Docker Compose did not return its resolved JSON configuration");
  }
  if (!options.explicit.has("backupRoot")) {
    options.backupRoot = composeBindSource(configuration, "stuga-backup", "/app/backups") ?? options.backupRoot;
    if (!options.explicit.has("workspace")) options.workspace = resolve(options.backupRoot, ".live-migration");
  }
  if (!options.explicit.has("configDirectory")) {
    options.configDirectory = composeBindSource(configuration, "api", "/app/config") ?? options.configDirectory;
  }
  if (options.explicit.has("secretsDirectory")) {
    options.secretDirectories = Object.fromEntries([
      ["cloudflare", join(options.secretsDirectory, "cloudflare")],
      ["tapo-history-api", join(options.secretsDirectory, "tapo-history-api")],
      ["tapo-history-runner", join(options.secretsDirectory, "tapo-history-runner")],
    ]);
  } else {
    options.secretDirectories = {
      cloudflare: composeBindSource(configuration, "api", "/run/secrets/cloudflare")
        ?? join(options.secretsDirectory, "cloudflare"),
      "tapo-history-api": composeBindSource(configuration, "api", "/run/secrets/tapo-history")
        ?? join(options.secretsDirectory, "tapo-history-api"),
      "tapo-history-runner": composeBindSource(configuration, "tapo-export-runner", "/run/secrets/tapo-history")
        ?? join(options.secretsDirectory, "tapo-history-runner"),
    };
  }
  return configuration;
}

async function assertRunningSourceVersion(options, { runCommand = run } = {}) {
  const controllerVersion = options.sourceVersion;
  const result = await runCommand("docker", composeArguments(
    options,
    "exec",
    "--no-TTY",
    "api",
    "node",
    "-p",
    "require('/app/apps/api/package.json').version",
  ), { cwd: options.projectDirectory });
  const runningVersion = assertReleaseVersion(result.stdout.trim(), "Running source version");
  if (compareReleaseVersions(runningVersion, controllerVersion) > 0) {
    throw new Error(`Running source Stuga ${runningVersion} is newer than controller ${controllerVersion}`);
  }
  options.controllerVersion = controllerVersion;
  options.sourceVersion = runningVersion;
  return runningVersion;
}

function backupDirectories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^stuga-backup-\d{4}-\d{2}-\d{2}T/u.test(entry.name))
    .map((entry) => resolve(root, entry.name));
}

async function createComposeBackup(options) {
  mkdirSync(options.backupRoot, { recursive: true });
  const before = new Set(backupDirectories(options.backupRoot));
  const result = await run("docker", composeArguments(options, "--profile", "maintenance", "run", "--rm", "stuga-backup"), {
    cwd: options.projectDirectory,
    stream: true,
  });
  const match = /Verified backup created:\s+\/app\/backups\/([^\s/]+)\s*$/mu.exec(result.stdout);
  const candidates = backupDirectories(options.backupRoot).filter((path) => !before.has(path));
  const selected = match ? resolve(options.backupRoot, match[1]) : candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  if (!selected || !existsSync(join(selected, "manifest.json"))) throw new Error("Compose backup completed but its verified output could not be located");
  return selected;
}

async function verifyBackupSidecar(backup) {
  const manifest = join(backup, "manifest.json");
  const sidecar = join(backup, "manifest.sha256");
  if (!existsSync(manifest) || !existsSync(sidecar)) throw new Error("Backup manifest or checksum sidecar is missing");
  const expected = readFileSync(sidecar, "utf8").trim().split(/\s+/u)[0];
  if (!isSha256(expected) || await sha256File(manifest) !== expected) throw new Error("Backup manifest checksum mismatch");
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  if (parsed?.verification?.status !== "passed") throw new Error("Backup is not marked verified");
  return parsed;
}

async function runningComposeServices(options) {
  const result = await run("docker", composeArguments(options, "ps", "--services", "--filter", "status=running"), { cwd: options.projectDirectory });
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean);
}

async function stopSourceWriters(options, {
  listRunning = runningComposeServices,
  runCommand = run,
  restart = restartSource,
} = {}) {
  const running = await listRunning(options);
  const ingress = ["cloudflared", "web"].filter((service) => running.includes(service));
  const mutators = [
    "api",
    "stuga-backup-scheduler",
    "tapo-export-runner",
    "telemetry-migrate",
    "timeseries-credential-reconcile",
  ].filter((service) => running.includes(service));
  if (!mutators.includes("api")) throw new Error("The source API is not running under this Compose project; refusing an uncoordinated cutover");
  const cutoverServices = [...ingress, ...mutators];
  try {
    if (ingress.length > 0) {
      await runCommand("docker", composeArguments(options, "stop", "--timeout", "30", ...ingress), {
        cwd: options.projectDirectory,
        stream: true,
      });
    }
    await runCommand("docker", composeArguments(options, "stop", "--timeout", "30", ...mutators), {
      cwd: options.projectDirectory,
      stream: true,
    });
    const stillRunning = await listRunning(options);
    if (cutoverServices.some((service) => stillRunning.includes(service))) {
      throw new Error("One or more source cutover services did not stop cleanly");
    }
    return { writers: cutoverServices, running };
  } catch (error) {
    const afterFailure = await listRunning(options).catch(() => []);
    const stopped = cutoverServices.filter((service) => !afterFailure.includes(service));
    let recoveryError;
    try {
      await restart(options, stopped);
    } catch (restartError) {
      recoveryError = restartError;
    }
    if (recoveryError) {
      throw new Error(`Source quiescence failed and partial-stop recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
    }
    throw error;
  }
}

async function restartSource(options, services) {
  if (!services?.length) return;
  await run("docker", composeArguments(options, "up", "--detach", "--wait", "--wait-timeout", "600", ...services), {
    cwd: options.projectDirectory,
    stream: true,
  });
}

function unquotedEnvironmentValue(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  return trimmed;
}

function effectiveSettingsFile(options, runningServices) {
  if (!options.deploymentSettings) return undefined;
  if (!existsSync(options.settingsFile)
    || !lstatSync(options.settingsFile).isFile()
    || lstatSync(options.settingsFile).isSymbolicLink()) {
    throw new Error(`Authoritative settings path is missing or not a regular file: ${options.settingsFile}`);
  }
  const original = readFileSync(options.settingsFile, "utf8");
  const configured = unquotedEnvironmentValue(parseEnvironmentAssignments(original).get("COMPOSE_PROFILES"));
  const profiles = new Set(configured.split(/[\s,]+/u).filter(Boolean));
  if (runningServices.includes("cloudflared")) profiles.add("cloudflare");
  if (runningServices.includes("tapo-export-runner")) profiles.add("tapo-history");
  const generated = join(options.workspace, "generated", `source-settings-${Date.now()}-${process.pid}.env`);
  hardenPrivateDirectory(dirname(generated));
  const profileLine = profiles.size > 0 ? `\nCOMPOSE_PROFILES=${[...profiles].sort().join(",")}\n` : "";
  writeFileSync(generated, `${original.replace(/\s*$/u, "")}\n${profileLine}`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  hardenPrivateFile(generated);
  return generated;
}

function assertRemoteDirectory(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || !/^\/[A-Za-z0-9._/-]+$/u.test(value)
    || value.split("/").some((part) => part === "..")) throw new Error(`${label} returned by target is unsafe`);
  return value.replace(/\/$/u, "");
}

function sftpQuote(value) {
  if (value.includes('"') || value.includes("\n") || value.includes("\r")) throw new Error("SFTP path contains unsupported characters");
  return `"${value.replaceAll("\\", "/")}"`;
}

async function sftpBatch(options, commands, workspace) {
  const batch = join(workspace, `sftp-${Date.now()}-${process.pid}.txt`);
  writeFileSync(batch, `${commands.join("\n")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  hardenPrivateFile(batch);
  const args = sshOptions(options);
  const portIndex = args.indexOf("-p");
  args[portIndex] = "-P";
  try {
    await run("sftp", ["-b", batch, ...args, options.target], { cwd: options.projectDirectory, stream: true });
  } finally {
    if (existsSync(batch)) unlinkSync(batch);
  }
}

async function uploadPlan(options, target, bundle) {
  const incoming = assertRemoteDirectory(target.incomingDirectory, "Incoming directory");
  const remote = `${incoming}/${bundle.plan.id}.json`;
  const temporary = `${remote}.${process.pid}.upload`;
  await sftpBatch(options, [
    `put ${sftpQuote(bundle.planPath)} ${sftpQuote(temporary)}`,
    `-rm ${sftpQuote(remote)}`,
    `rename ${sftpQuote(temporary)} ${sftpQuote(remote)}`,
  ], options.workspace);
}

async function uploadMissingChunks(options, target, bundle, missing, { transfer = sftpBatch } = {}) {
  const chunks = assertRemoteDirectory(target.chunkDirectory, "Chunk directory");
  const planChunks = new Map(bundle.plan.files.flatMap((file) => file.chunks.map((chunk) => [chunk.sha256, chunk.size])));
  if (!Array.isArray(missing) || missing.some((digest) => !isSha256(digest) || !planChunks.has(digest))) {
    throw new Error("Target requested a chunk that is not in the migration plan");
  }
  if (missing.length === 0) return;
  const commands = [];
  for (const digest of missing) {
    const local = join(bundle.chunkDirectory, digest);
    const details = existsSync(local) ? lstatSync(local) : null;
    if (!details?.isFile() || details.isSymbolicLink() || details.size !== planChunks.get(digest) || await sha256File(local) !== digest) {
      throw new Error(`Local migration chunk failed verification before upload: ${digest}`);
    }
    const remote = `${chunks}/${digest}`;
    const temporary = `${remote}.${bundle.plan.id}.upload`;
    commands.push(`put ${sftpQuote(local)} ${sftpQuote(temporary)}`);
    commands.push(`-rm ${sftpQuote(remote)}`);
    commands.push(`rename ${sftpQuote(temporary)} ${sftpQuote(remote)}`);
  }
  await transfer(options, commands, options.workspace);
}

function assertTargetCapacity(target, plan) {
  validateMigrationPlan(plan);
  const number = (value, label) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Target preflight returned invalid ${label}`);
    return parsed;
  };
  const devices = new Map();
  const add = (label, device, free, required) => {
    if (typeof device !== "string" || !device) throw new Error(`Target preflight returned invalid ${label} device`);
    const capacity = devices.get(device) ?? {
      labels: [],
      freeBytes: number(free, `${label} free bytes`),
      requiredBytes: 0,
    };
    capacity.labels.push(label);
    capacity.freeBytes = Math.min(capacity.freeBytes, number(free, `${label} free bytes`));
    capacity.requiredBytes += required;
    devices.set(device, capacity);
  };
  const targetSafetyBackupBytes = number(target.currentDataBytes, "current data bytes")
    + number(target.currentDatabaseBytes, "current database bytes");
  add("migration", target.migrationDevice, target.migrationFreeBytes, plan.totalBytes * 2 + targetSafetyBackupBytes);
  add("application data", target.dataDevice, target.dataFreeBytes, plan.estimatedDataBytes);
  add("TimescaleDB", target.timeseriesDevice, target.timeseriesFreeBytes, plan.estimatedDatabaseBytes);
  for (const capacity of devices.values()) {
    const requiredWithHeadroom = capacity.requiredBytes + CUTOVER_FREE_SPACE_HEADROOM;
    if (capacity.freeBytes < requiredWithHeadroom) {
      throw new Error(`Target preflight reports insufficient ${capacity.labels.join("/")} free space; need at least ${requiredWithHeadroom} bytes`);
    }
  }
  return devices;
}

async function stageBundle(options, target, bundle) {
  assertTargetCapacity(target, bundle.plan);
  await uploadPlan(options, target, bundle);
  let missingResult = await remoteJson(options, ["stugactl", "migration", "missing", bundle.plan.id, bundle.planSha256]);
  process.stdout.write(`Target needs ${missingResult.missing.length} chunk(s), ${missingResult.missingBytes} byte(s).\n`);
  await uploadMissingChunks(options, target, bundle, missingResult.missing);
  missingResult = await remoteJson(options, ["stugactl", "migration", "missing", bundle.plan.id, bundle.planSha256]);
  if (missingResult.missing.length !== 0) throw new Error("Target still reports missing chunks after transfer");
  return remoteJson(options, ["stugactl", "migration", "assemble", bundle.plan.id, bundle.planSha256], { stream: true });
}

async function targetStatus(options, id) {
  return remoteJson(options, ["stugactl", "migration", "status", id]);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseLiveMigrationArgs(argv);
  if (options.help) { process.stdout.write(help()); return; }
  if (options.phase === "status") {
    process.stdout.write(`${JSON.stringify(await targetStatus(options, options.migrationId), null, 2)}\n`);
    return;
  }
  await resolveComposeDeploymentInputs(options);
  hardenPrivateDirectory(options.workspace);
  await assertRunningSourceVersion(options);
  const target = await remoteJson(options, ["stugactl", "migration", "init"]);
  if (target.format !== "stuga-migration-preflight" || target.version !== 1) {
    throw new Error("Target does not expose a compatible migration receiver");
  }
  if (compareReleaseVersions(options.sourceVersion, target.targetVersion) > 0) {
    throw new Error(`Target Stuga ${target.targetVersion} is older than source ${options.sourceVersion}`);
  }
  let stoppedServices = [];
  let sourceRunningServices = [];
  let backup;
  try {
    if (options.phase === "cutover") {
      const sourceState = await stopSourceWriters(options);
      stoppedServices = sourceState.writers;
      sourceRunningServices = sourceState.running;
    } else {
      sourceRunningServices = await runningComposeServices(options);
    }
    backup = options.backup ?? await createComposeBackup(options);
    await verifyBackupSidecar(backup);
    const bundle = await createMigrationBundle({
      backupDirectory: backup,
      workspaceDirectory: options.workspace,
      phase: options.phase,
      sourceVersion: options.sourceVersion,
      settingsFile: effectiveSettingsFile(options, sourceRunningServices),
      configDirectory: options.deploymentSettings ? options.configDirectory : undefined,
      secretsDirectory: options.deploymentSettings ? options.secretsDirectory : undefined,
      secretDirectories: options.deploymentSettings ? options.secretDirectories : undefined,
      chunkSize: options.chunkSize,
    });
    process.stdout.write(`Migration ${bundle.plan.id}: ${bundle.plan.files.length} files, ${bundle.plan.totalBytes} bytes, ${bundle.plan.uniqueChunkBytes} unique chunk bytes.\n`);
    await stageBundle(options, target, bundle);
    if (options.phase === "seed") {
      process.stdout.write(`Seed ${bundle.plan.id} is staged and verified; the source remains online.\n`);
      return;
    }
    try {
      await remoteJson(options, ["stugactl", "migration", "apply", bundle.plan.id, bundle.planSha256], { stream: true });
      process.stdout.write(`Cutover ${bundle.plan.id} committed on the target. Source writers remain stopped.\n`);
    } catch (error) {
      let status;
      let statusQueried = false;
      try {
        status = await targetStatus(options, bundle.plan.id);
        statusQueried = true;
      } catch { /* Fail closed below. */ }
      const targetState = status?.receipt?.status;
      if (statusQueried && targetState === "rolled-back") {
        await restartSource(options, stoppedServices);
        stoppedServices = [];
        throw new Error(`Target cutover failed or rolled back; source writers were restarted. ${error instanceof Error ? error.message : String(error)}`);
      }
      stoppedServices = [];
      throw new Error(`Target cutover ended in state '${targetState}'. Source writers remain stopped to prevent split-brain; inspect migration ${bundle.plan.id}.`);
    }
  } catch (error) {
    if (options.phase === "cutover" && stoppedServices.length > 0) {
      await restartSource(options, stoppedServices).catch((restartError) => {
        throw new Error(`Migration failed and source restart also failed: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
      });
    }
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Live migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  effectiveSettingsFile,
  main as runLiveMigration,
  safeSshTarget,
  assertTargetCapacity,
  assertRunningSourceVersion,
  stopSourceWriters,
  uploadMissingChunks,
};
