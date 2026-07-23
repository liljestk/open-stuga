#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_MIGRATION_CHUNK_BYTES,
  STUGA_MIGRATION_FORMAT,
  STUGA_MIGRATION_VERSION,
  assertMigrationId,
  assertReleaseVersion,
  assertSafeRelativePath,
  isSha256,
  pathWithin,
  portableEnvironmentFromFile,
  sha256Text,
  validatedChunkSize,
} from "./stuga-migration-common.mjs";
import {
  hardenPrivateDirectory,
  hardenPrivateFile,
  sha256File,
} from "./sqlite-snapshot-utils.mjs";

const MAX_DEPLOYMENT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DEPLOYMENT_TOTAL_BYTES = 256 * 1024 * 1024;
const SECRET_DIRECTORIES = ["cloudflare", "tapo-history-api", "tapo-history-runner"];
const FILE_CATEGORIES = new Set(["backup", "settings", "config", "secret"]);

function portable(path) {
  return path.split(sep).join("/");
}

function walkRegularFiles(root) {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) throw new Error(`Expected a directory: ${root}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const details = lstatSync(path);
      if (details.isSymbolicLink()) throw new Error(`Migration inputs cannot contain symbolic links: ${path}`);
      if (details.isDirectory()) visit(path);
      else if (details.isFile()) files.push(path);
      else throw new Error(`Migration input contains an unsupported entry: ${path}`);
    }
  };
  visit(root);
  return files;
}

function backupInputs(backupDirectory) {
  const root = resolve(backupDirectory);
  const manifestPath = join(root, "manifest.json");
  const sidecarPath = join(root, "manifest.sha256");
  if (!existsSync(manifestPath) || !existsSync(sidecarPath)) throw new Error("Backup manifest or checksum sidecar is missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.format !== "stuga-backup" || ![1, 2].includes(manifest?.version) || manifest?.verification?.status !== "passed") {
    throw new Error("Migration requires a successfully verified Stuga backup");
  }
  if (!Array.isArray(manifest.files)) throw new Error("Backup manifest has no file inventory");
  const expectedManifestHash = readFileSync(sidecarPath, "utf8").trim().split(/\s+/u)[0];
  if (!isSha256(expectedManifestHash)) throw new Error("Backup manifest checksum sidecar is malformed");
  const inputs = [
    { sourcePath: manifestPath, logicalPath: "backup/manifest.json", category: "backup" },
    { sourcePath: sidecarPath, logicalPath: "backup/manifest.sha256", category: "backup" },
  ];
  for (const record of manifest.files) {
    const recordPath = assertSafeRelativePath(record?.path, "Backup artifact path");
    const sourcePath = resolve(root, recordPath);
    if (!pathWithin(root, sourcePath)) throw new Error("Backup artifact escaped the backup directory");
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error(`Backup artifact is missing: ${recordPath}`);
    inputs.push({ sourcePath, logicalPath: `backup/${recordPath}`, category: "backup" });
  }
  return { root, manifest, expectedManifestHash, inputs };
}

function deploymentInputs({
  workspaceDirectory,
  settingsFile,
  configDirectory,
  secretsDirectory,
  secretDirectories,
}) {
  const inputs = [];
  if (settingsFile) {
    if (!existsSync(settingsFile) || !lstatSync(settingsFile).isFile() || lstatSync(settingsFile).isSymbolicLink()) {
      throw new Error(`Authoritative settings path is missing or not a regular file: ${settingsFile}`);
    }
    const generated = join(workspaceDirectory, "generated", `settings-${randomUUID()}.env`);
    hardenPrivateDirectory(dirname(generated));
    writeFileSync(generated, portableEnvironmentFromFile(settingsFile), { encoding: "utf8", flag: "wx", mode: 0o600 });
    hardenPrivateFile(generated);
    inputs.push({ sourcePath: generated, logicalPath: "deployment/settings.env", category: "settings" });
  }
  if (configDirectory) {
    if (!existsSync(configDirectory) || !lstatSync(configDirectory).isDirectory() || lstatSync(configDirectory).isSymbolicLink()) {
      throw new Error(`Authoritative config path is missing or not a real directory: ${configDirectory}`);
    }
    const root = resolve(configDirectory);
    for (const sourcePath of walkRegularFiles(root)) {
      const child = portable(relative(root, sourcePath));
      inputs.push({ sourcePath, logicalPath: `deployment/config/${assertSafeRelativePath(child)}`, category: "config" });
    }
  }
  const configuredSecretDirectories = secretDirectories
    ?? Object.fromEntries(SECRET_DIRECTORIES.map((name) => [name, secretsDirectory ? join(resolve(secretsDirectory), name) : undefined]));
  for (const name of SECRET_DIRECTORIES) {
    const configured = configuredSecretDirectories?.[name];
    if (!configured) continue;
    const directory = resolve(configured);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
      throw new Error(`Authoritative ${name} secret path is missing or not a real directory: ${directory}`);
    }
    for (const sourcePath of walkRegularFiles(directory)) {
      const child = portable(relative(directory, sourcePath));
      inputs.push({ sourcePath, logicalPath: `deployment/secrets/${name}/${assertSafeRelativePath(child)}`, category: "secret" });
    }
  }
  let total = 0;
  for (const input of inputs) {
    const size = statSync(input.sourcePath).size;
    if (size > MAX_DEPLOYMENT_FILE_BYTES) throw new Error(`Deployment file exceeds ${MAX_DEPLOYMENT_FILE_BYTES} bytes: ${input.logicalPath}`);
    total += size;
  }
  if (total > MAX_DEPLOYMENT_TOTAL_BYTES) throw new Error(`Deployment settings exceed ${MAX_DEPLOYMENT_TOTAL_BYTES} bytes`);
  return {
    inputs,
    deployment: {
      authoritativeEnvironment: Boolean(settingsFile),
      exactConfig: Boolean(configDirectory),
      exactSecretRoots: SECRET_DIRECTORIES.filter((name) => Boolean(configuredSecretDirectories?.[name])),
    },
  };
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function storeChunk(chunkDirectory, buffer) {
  const digest = createHash("sha256").update(buffer).digest("hex");
  const destination = join(chunkDirectory, digest);
  if (existsSync(destination)) {
    const details = statSync(destination);
    if (!details.isFile() || details.size !== buffer.length || await sha256File(destination) !== digest) {
      throw new Error(`Cached migration chunk is corrupt: ${digest}`);
    }
    return digest;
  }
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, buffer, { flag: "wx", mode: 0o600 });
  hardenPrivateFile(temporary);
  const descriptor = openSync(temporary, "r+");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, destination);
  fsyncDirectory(chunkDirectory);
  return digest;
}

async function describeInput(input, chunkDirectory, chunkSize) {
  const logicalPath = assertSafeRelativePath(input.logicalPath, "Migration file path");
  if (!FILE_CATEGORIES.has(input.category)) throw new Error(`Unsupported migration file category: ${input.category}`);
  const details = statSync(input.sourcePath);
  if (!details.isFile()) throw new Error(`Migration input is not a regular file: ${input.sourcePath}`);
  const fileHash = createHash("sha256");
  const chunks = [];
  const descriptor = openSync(input.sourcePath, "r");
  try {
    let position = 0;
    while (position < details.size) {
      const requested = Math.min(chunkSize, details.size - position);
      const buffer = Buffer.allocUnsafe(requested);
      const bytesRead = readSync(descriptor, buffer, 0, requested, position);
      if (bytesRead !== requested) throw new Error(`Short read while chunking ${logicalPath}`);
      const payload = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      fileHash.update(payload);
      const sha256 = await storeChunk(chunkDirectory, payload);
      chunks.push({ sha256, size: payload.length });
      position += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    path: logicalPath,
    category: input.category,
    size: details.size,
    sha256: fileHash.digest("hex"),
    chunks,
    sensitive: true,
  };
}

export function validateMigrationPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Migration plan must be an object");
  if (plan.format !== STUGA_MIGRATION_FORMAT || plan.version !== STUGA_MIGRATION_VERSION) {
    throw new Error("Unsupported migration plan format or version");
  }
  assertMigrationId(plan.id);
  if (!['seed', 'cutover'].includes(plan.phase)) throw new Error("Migration phase must be seed or cutover");
  assertReleaseVersion(plan.sourceVersion, "Source version");
  if (!isSha256(plan.backupManifestSha256)) throw new Error("Migration plan has an invalid backup manifest checksum");
  if (!Array.isArray(plan.files) || plan.files.length < 2) throw new Error("Migration plan has no file inventory");
  const paths = new Set();
  const chunkSizes = new Map();
  let totalBytes = 0;
  for (const file of plan.files) {
    const path = assertSafeRelativePath(file?.path, "Migration file path");
    if (paths.has(path)) throw new Error(`Migration plan contains a duplicate path: ${path}`);
    paths.add(path);
    if (!FILE_CATEGORIES.has(file?.category)) throw new Error(`Unsupported migration file category: ${file?.category}`);
    if (!Number.isSafeInteger(file?.size) || file.size < 0 || !isSha256(file?.sha256) || !Array.isArray(file?.chunks)) {
      throw new Error(`Migration file record is malformed: ${path}`);
    }
    let fileBytes = 0;
    for (const chunk of file.chunks) {
      if (!isSha256(chunk?.sha256) || !Number.isSafeInteger(chunk?.size) || chunk.size < 1) {
        throw new Error(`Migration chunk record is malformed: ${path}`);
      }
      const previousSize = chunkSizes.get(chunk.sha256);
      if (previousSize !== undefined && previousSize !== chunk.size) throw new Error(`Migration chunk size conflict: ${chunk.sha256}`);
      chunkSizes.set(chunk.sha256, chunk.size);
      fileBytes += chunk.size;
    }
    if (fileBytes !== file.size) throw new Error(`Migration chunks do not add up to file size: ${path}`);
    if (file.size === 0 && file.sha256 !== sha256Text("")) throw new Error(`Empty migration file has the wrong checksum: ${path}`);
    totalBytes += file.size;
  }
  if (!paths.has("backup/manifest.json") || !paths.has("backup/manifest.sha256")) {
    throw new Error("Migration plan does not include the backup manifest and checksum sidecar");
  }
  if (plan.totalBytes !== totalBytes) throw new Error("Migration plan total byte count is inconsistent");
  const uniqueChunkBytes = [...chunkSizes.values()].reduce((total, size) => total + size, 0);
  if (plan.uniqueChunkBytes !== uniqueChunkBytes) throw new Error("Migration plan unique chunk byte count is inconsistent");
  if (!Number.isSafeInteger(plan.estimatedRestoreBytes) || plan.estimatedRestoreBytes < totalBytes) {
    throw new Error("Migration plan restore byte estimate is invalid");
  }
  if (!Number.isSafeInteger(plan.estimatedDataBytes) || plan.estimatedDataBytes < 0
    || !Number.isSafeInteger(plan.estimatedDatabaseBytes) || plan.estimatedDatabaseBytes < 0
    || plan.estimatedRestoreBytes !== plan.estimatedDataBytes + plan.estimatedDatabaseBytes) {
    throw new Error("Migration plan split restore byte estimates are invalid");
  }
  if (plan.deployment !== undefined) {
    if (!plan.deployment || typeof plan.deployment !== "object" || Array.isArray(plan.deployment)
      || typeof plan.deployment.authoritativeEnvironment !== "boolean"
      || typeof plan.deployment.exactConfig !== "boolean"
      || !Array.isArray(plan.deployment.exactSecretRoots)
      || plan.deployment.exactSecretRoots.some((name) => !SECRET_DIRECTORIES.includes(name))) {
      throw new Error("Migration deployment inventory is malformed");
    }
  }
  return plan;
}

export async function createMigrationBundle({
  backupDirectory,
  workspaceDirectory,
  phase,
  sourceVersion,
  settingsFile,
  configDirectory,
  secretsDirectory,
  secretDirectories,
  chunkSize = DEFAULT_MIGRATION_CHUNK_BYTES,
  now = new Date(),
  id = randomUUID(),
}) {
  const migrationId = assertMigrationId(id);
  if (!['seed', 'cutover'].includes(phase)) throw new Error("Migration phase must be seed or cutover");
  assertReleaseVersion(sourceVersion, "Source version");
  const bytesPerChunk = validatedChunkSize(chunkSize);
  const workspace = hardenPrivateDirectory(resolve(workspaceDirectory));
  const chunkDirectory = hardenPrivateDirectory(join(workspace, "chunks"));
  const planDirectory = hardenPrivateDirectory(join(workspace, "plans"));
  const backup = backupInputs(backupDirectory);
  if (await sha256File(join(backup.root, "manifest.json")) !== backup.expectedManifestHash) {
    throw new Error("Backup manifest checksum mismatch");
  }
  const deployment = deploymentInputs({
    workspaceDirectory: workspace,
    settingsFile,
    configDirectory,
    secretsDirectory,
    secretDirectories,
  });
  const inputs = [
    ...backup.inputs,
    ...deployment.inputs,
  ];
  const files = [];
  for (const input of inputs.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))) {
    files.push(await describeInput(input, chunkDirectory, bytesPerChunk));
  }
  const uniqueChunks = new Map();
  for (const file of files) for (const chunk of file.chunks) uniqueChunks.set(chunk.sha256, chunk.size);
  const logicalTimescaleBytes = Number(backup.manifest?.sources?.timescale?.logicalBytes);
  const dumpBytes = backup.manifest.files
    .filter((file) => file.category === "timescale-pgdump")
    .reduce((total, file) => total + Number(file.size ?? 0), 0);
  const estimatedDatabaseBytes = Number.isSafeInteger(logicalTimescaleBytes) && logicalTimescaleBytes >= 0
    ? logicalTimescaleBytes
    : dumpBytes * 4;
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const estimatedDataBytes = totalBytes - dumpBytes;
  const plan = validateMigrationPlan({
    format: STUGA_MIGRATION_FORMAT,
    version: STUGA_MIGRATION_VERSION,
    id: migrationId,
    phase,
    sourceVersion,
    createdAt: now.toISOString(),
    sensitivity: "confidential-household-authentication-settings-and-telemetry-data",
    backupManifestSha256: backup.expectedManifestHash,
    chunkSize: bytesPerChunk,
    totalBytes,
    uniqueChunkBytes: [...uniqueChunks.values()].reduce((total, size) => total + size, 0),
    estimatedDataBytes,
    estimatedDatabaseBytes,
    estimatedRestoreBytes: estimatedDataBytes + estimatedDatabaseBytes,
    deployment: deployment.deployment,
    files,
  });
  const planPath = join(planDirectory, `${migrationId}.json`);
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(planPath, serialized, { encoding: "utf8", flag: "wx", flush: true, mode: 0o600 });
  hardenPrivateFile(planPath);
  fsyncDirectory(planDirectory);
  return { plan, planPath, planSha256: sha256Text(serialized), chunkDirectory };
}

export async function verifyAssembledMigrationBundle({ plan, outputDirectory }) {
  validateMigrationPlan(plan);
  const output = resolve(outputDirectory);
  for (const file of plan.files) {
    const path = resolve(output, file.path);
    if (!pathWithin(output, path) || !existsSync(path)) throw new Error(`Assembled migration file is missing: ${file.path}`);
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== file.size) {
      throw new Error(`Assembled migration file is invalid: ${file.path}`);
    }
    if (await sha256File(path) !== file.sha256) throw new Error(`Assembled migration checksum mismatch: ${file.path}`);
  }
  return { files: plan.files.length, totalBytes: plan.totalBytes };
}

export async function missingMigrationChunks(plan, chunkDirectory) {
  validateMigrationPlan(plan);
  const unique = new Map();
  for (const file of plan.files) for (const chunk of file.chunks) unique.set(chunk.sha256, chunk.size);
  const missing = [];
  for (const [sha256, size] of unique) {
    const path = join(resolve(chunkDirectory), sha256);
    if (!existsSync(path)) { missing.push(sha256); continue; }
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== size || await sha256File(path) !== sha256) {
      missing.push(sha256);
    }
  }
  return missing.sort();
}

export async function assembleMigrationBundle({ plan, chunkDirectory, outputDirectory }) {
  validateMigrationPlan(plan);
  const chunks = resolve(chunkDirectory);
  const output = resolve(outputDirectory);
  if (existsSync(output)) throw new Error(`Refusing to overwrite an existing migration staging directory: ${output}`);
  const temporary = `${output}.${process.pid}.${Date.now()}.assembling`;
  hardenPrivateDirectory(temporary);
  try {
    for (const file of plan.files) {
      const destination = resolve(temporary, file.path);
      if (!pathWithin(temporary, destination)) throw new Error(`Migration file escaped staging: ${file.path}`);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const descriptor = openSync(destination, "wx", 0o600);
      const fileHash = createHash("sha256");
      let size = 0;
      try {
        for (const chunk of file.chunks) {
          const chunkPath = join(chunks, chunk.sha256);
          const details = lstatSync(chunkPath);
          if (!details.isFile() || details.isSymbolicLink() || details.size !== chunk.size) throw new Error(`Migration chunk is missing or invalid: ${chunk.sha256}`);
          const payload = readFileSync(chunkPath);
          if (createHash("sha256").update(payload).digest("hex") !== chunk.sha256) throw new Error(`Migration chunk checksum mismatch: ${chunk.sha256}`);
          writeSync(descriptor, payload);
          fileHash.update(payload);
          size += payload.length;
        }
      } finally {
        closeSync(descriptor);
      }
      hardenPrivateFile(destination);
      if (size !== file.size || fileHash.digest("hex") !== file.sha256) throw new Error(`Reassembled migration file failed verification: ${file.path}`);
      const verificationDescriptor = openSync(destination, "r+");
      try { fsyncSync(verificationDescriptor); } finally { closeSync(verificationDescriptor); }
      fsyncDirectory(dirname(destination));
    }
    renameSync(temporary, output);
    fsyncDirectory(dirname(output));
    await verifyAssembledMigrationBundle({ plan, outputDirectory: output });
  } catch (error) {
    // The caller retains an incomplete directory for inspection; it is never
    // accepted as staged because the final atomic rename did not occur.
    throw error;
  }
  return { outputDirectory: output, files: plan.files.length, totalBytes: plan.totalBytes };
}
