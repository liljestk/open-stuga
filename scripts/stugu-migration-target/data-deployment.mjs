import { spawn } from "node:child_process";

import { createPrivateKey, createPublicKey } from "node:crypto";

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";

import { dirname, join, relative, resolve, sep } from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assembleMigrationBundle,
  missingMigrationChunks,
  validateMigrationPlan,
  verifyAssembledMigrationBundle,
} from ".././stugu-migration-bundle.mjs";

import {
  assertMigrationId,
  assertReleaseVersion,
  assertSafeRelativePath,
  compareReleaseVersions,
  isSha256,
  mergePortableEnvironment,
  pathWithin,
  sha256Text,
} from ".././stugu-migration-common.mjs";

import {
  timescaleOwnershipValidationSql,
  timescalePreRestoreSql,
  verifyBackup,
} from ".././stugu-backup.mjs";

import { atomicJson, durableRemove, durableRename, environmentPath, psql, safeIdentifier, sqlIdentifier, sqlLiteral } from "./storage-preflight.mjs";

export const MAX_IN_PLACE_REPLACEMENT_BYTES = 16 * 1024 * 1024;

export function fsyncFile(path) {
  const descriptor = openSync(path, "r+");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function installAtomically(destination, mode, writeTemporary) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.copying`;
  try {
    writeTemporary(temporary);
    chmodSync(temporary, mode);
    fsyncFile(temporary);
    if (existsSync(destination)) {
      const details = lstatSync(destination);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error(`Migration target is not a regular file: ${destination}`);
      }
    }
    durableRename(temporary, destination);
  } catch (error) {
    if (existsSync(temporary)) {
      try { rmSync(temporary, { force: true }); } catch {}
    }
    throw error;
  }
}

function installInPlace(destination, contents, mode, atomicError) {
  if (!["EBUSY", "EROFS"].includes(atomicError?.code)) throw atomicError;
  if (contents.byteLength > MAX_IN_PLACE_REPLACEMENT_BYTES) {
    throw new Error(
      `Refusing non-atomic replacement larger than ${MAX_IN_PLACE_REPLACEMENT_BYTES} bytes: ${destination}`,
      { cause: atomicError },
    );
  }
  if (!existsSync(destination)) {
    throw new Error(`Read-only migration target does not already exist: ${destination}`, { cause: atomicError });
  }
  const before = lstatSync(destination);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Read-only migration target is not a regular file: ${destination}`, { cause: atomicError });
  }
  const descriptor = openSync(destination, "r+");
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Migration target changed before compatibility replacement: ${destination}`);
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, contents);
    chmodSync(destination, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (!readFileSync(destination).equals(contents)) {
    throw new Error(`Compatibility replacement verification failed: ${destination}`);
  }
}

export function replaceFileContents(
  destination,
  contents,
  mode = 0o600,
  { atomicInstaller = installAtomically } = {},
) {
  const payload = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  try {
    atomicInstaller(destination, mode, (temporary) => {
      writeFileSync(temporary, payload, { flag: "wx", mode });
    });
  } catch (error) {
    installInPlace(destination, payload, mode, error);
  }
}

export function copyVerified(source, destination, mode = 0o600) {
  try {
    installAtomically(destination, mode, (temporary) => copyFileSync(source, temporary));
  } catch (error) {
    if (!["EBUSY", "EROFS"].includes(error?.code)) throw error;
    const sourceDetails = lstatSync(source);
    if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) {
      throw new Error(`Migration source is not a regular file: ${source}`, { cause: error });
    }
    if (sourceDetails.size > MAX_IN_PLACE_REPLACEMENT_BYTES) {
      throw new Error(
        `Refusing non-atomic replacement larger than ${MAX_IN_PLACE_REPLACEMENT_BYTES} bytes: ${destination}`,
        { cause: error },
      );
    }
    installInPlace(destination, readFileSync(source), mode, error);
  }
}

export function ensureNoSymlinkParents(root, candidate) {
  if (!pathWithin(root, candidate)) throw new Error(`Target path escaped its root: ${candidate}`);
  const pathFromRoot = relative(root, candidate);
  let current = resolve(root);
  for (const segment of pathFromRoot.split(sep).slice(0, -1)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Target path contains a symbolic link: ${current}`);
  }
}

export function prepareDataSwap(paths, manifest, receipt) {
  const data = environmentPath("STUGA_TARGET_DATA_DIRECTORY", "/app/data");
  const stage = join(data, `.stugu-migration-stage-${paths.id}`);
  const rollback = join(data, `.stugu-migration-rollback-${paths.id}`);
  if (existsSync(stage) || existsSync(rollback)) throw new Error("Target data contains state from this migration already");
  mkdirSync(stage, { mode: 0o700 });
  mkdirSync(rollback, { mode: 0o700 });
  const category = (name) => manifest.files.find((file) => file.category === name);
  const copyCategory = (name, targetName) => {
    const record = category(name);
    if (!record) return false;
    copyVerified(resolve(paths.staged, "backup", assertSafeRelativePath(record.path)), join(stage, targetName));
    return true;
  };
  copyCategory("core-sqlite", "climate-twin.sqlite");
  copyCategory("spatial-sqlite", "experimental-spatial-layers.sqlite");
  copyCategory("integration-secrets", "integration-secrets.json");
  copyCategory("stuguby-identity", "stuguby-identity.json");
  const stagedAssets = join(stage, "assets");
  mkdirSync(stagedAssets, { mode: 0o700 });
  for (const record of manifest.files.filter((file) => file.category === "asset")) {
    const sourceRelative = assertSafeRelativePath(record.path);
    if (!sourceRelative.startsWith("assets/")) throw new Error("Backup asset path is outside the assets directory");
    const child = assertSafeRelativePath(sourceRelative.slice("assets/".length));
    copyVerified(resolve(paths.staged, "backup", sourceRelative), resolve(stagedAssets, child));
  }
  receipt.data = {
    data,
    stage,
    rollback,
    targets: [
      "climate-twin.sqlite",
      "climate-twin.sqlite-wal",
      "climate-twin.sqlite-shm",
      "integration-secrets.json",
      "stuguby-identity.json",
      "assets",
      "experimental-spatial-layers.sqlite",
      "experimental-spatial-layers.sqlite-wal",
      "experimental-spatial-layers.sqlite-shm",
    ],
    items: {},
  };
  atomicJson(paths.receipt, receipt);
  return { data, stage, rollback };
}

export function swapData(paths, receipt, { afterMutation = () => {} } = {}) {
  const { data, stage, rollback } = receipt.data;
  for (const name of receipt.data.targets) {
    const live = join(data, name);
    const old = join(rollback, name);
    const staged = join(stage, name);
    const item = receipt.data.items[name] ?? {
      original: existsSync(live),
      staged: existsSync(staged),
      phase: "prepared",
    };
    receipt.data.items[name] = item;
    atomicJson(paths.receipt, receipt);
    if (item.original && existsSync(live) && !existsSync(old)) {
      durableRename(live, old);
      afterMutation("old-moved", name);
    }
    item.phase = "old-moved";
    atomicJson(paths.receipt, receipt);
    item.phase = "installing";
    atomicJson(paths.receipt, receipt);
    if (item.staged && existsSync(staged)) {
      durableRename(staged, live);
      afterMutation("new-installed", name);
    }
    item.phase = "installed";
    atomicJson(paths.receipt, receipt);
  }
  receipt.dataSwapped = true;
  atomicJson(paths.receipt, receipt);
}

export function targetForDeploymentPath(logicalPath) {
  if (logicalPath === "deployment/settings.env") {
    return { kind: "environment", relativePath: "stugu.env", root: dirname(environmentPath("STUGA_TARGET_ENV_FILE", "/app/target-settings/stugu.env")), path: environmentPath("STUGA_TARGET_ENV_FILE", "/app/target-settings/stugu.env") };
  }
  if (logicalPath.startsWith("deployment/config/")) {
    const child = assertSafeRelativePath(logicalPath.slice("deployment/config/".length));
    const root = environmentPath("STUGA_TARGET_CONFIG_DIRECTORY", "/app/target-settings/config");
    return { kind: "config", relativePath: child, root, path: resolve(root, child) };
  }
  if (logicalPath.startsWith("deployment/secrets/")) {
    const child = assertSafeRelativePath(logicalPath.slice("deployment/secrets/".length));
    const allowed = ["cloudflare/", "r2/", "tapo-history-api/", "tapo-history-runner/"];
    if (!allowed.some((prefix) => child.startsWith(prefix))) throw new Error(`Unsupported deployment secret path: ${logicalPath}`);
    const root = environmentPath("STUGA_TARGET_SECRETS_DIRECTORY", "/app/target-settings/secrets");
    return { kind: "secret", relativePath: child, root, path: resolve(root, child) };
  }
  throw new Error(`Unsupported deployment path: ${logicalPath}`);
}

export function walkTargetFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const details = lstatSync(path);
      if (details.isSymbolicLink()) throw new Error(`Migration target contains a symbolic link: ${path}`);
      if (details.isDirectory()) visit(path);
      else if (details.isFile()) files.push(path);
      else throw new Error(`Migration target contains an unsupported entry: ${path}`);
    }
  };
  visit(root);
  return files;
}

export function applyDeploymentFile(paths, receipt, target, source, { authoritativeEnvironment = false } = {}) {
  ensureNoSymlinkParents(target.root, target.path);
  const rollbackName = `${receipt.settings.length.toString().padStart(5, "0")}.bin`;
  const rollbackPath = join(paths.settingsRollback, rollbackName);
  const existed = existsSync(target.path);
  if (existed) {
    const details = lstatSync(target.path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Migration target is not a regular file: ${target.path}`);
    copyVerified(target.path, rollbackPath);
  }
  const settingsRecord = {
    kind: target.kind,
    relativePath: target.relativePath,
    existed,
    rollbackName,
    phase: "prepared",
  };
  receipt.settings.push(settingsRecord);
  atomicJson(paths.receipt, receipt);
  settingsRecord.phase = "applying";
  atomicJson(paths.receipt, receipt);
  if (source === null) {
    durableRemove(target.path, { force: true });
  } else if (target.kind === "environment") {
    const current = existed ? readFileSync(target.path, "utf8") : "";
    const merged = mergePortableEnvironment(
      current,
      readFileSync(source, "utf8"),
      undefined,
      { authoritative: authoritativeEnvironment },
    );
    replaceFileContents(target.path, merged);
  } else {
    copyVerified(source, target.path);
  }
  settingsRecord.phase = "applied";
  atomicJson(paths.receipt, receipt);
}

export function applyDeploymentSettings(paths, plan, receipt) {
  const deploymentFiles = plan.files.filter((file) => file.path.startsWith("deployment/"));
  receipt.settings = [];
  const desiredTargets = new Set(deploymentFiles.map((file) => targetForDeploymentPath(file.path).path));
  if (plan.deployment?.exactConfig) {
    const root = environmentPath("STUGA_TARGET_CONFIG_DIRECTORY", "/app/target-settings/config");
    for (const path of walkTargetFiles(root)) {
      if (desiredTargets.has(path)) continue;
      const child = assertSafeRelativePath(relative(root, path).split(sep).join("/"));
      applyDeploymentFile(paths, receipt, {
        kind: "config", relativePath: child, root, path,
      }, null);
    }
  }
  for (const name of plan.deployment?.exactSecretRoots ?? []) {
    const secretsRoot = environmentPath("STUGA_TARGET_SECRETS_DIRECTORY", "/app/target-settings/secrets");
    const root = join(secretsRoot, name);
    for (const path of walkTargetFiles(root)) {
      if (desiredTargets.has(path)) continue;
      const child = assertSafeRelativePath(relative(secretsRoot, path).split(sep).join("/"));
      applyDeploymentFile(paths, receipt, {
        kind: "secret", relativePath: child, root: secretsRoot, path,
      }, null);
    }
  }
  for (const file of deploymentFiles) {
    const target = targetForDeploymentPath(file.path);
    const source = resolve(paths.staged, file.path);
    applyDeploymentFile(paths, receipt, target, source, {
      authoritativeEnvironment: plan.deployment?.authoritativeEnvironment === true,
    });
  }
  receipt.settingsApplied = true;
  atomicJson(paths.receipt, receipt);
}

export function deploymentTargetFromReceipt(record) {
  if (record.kind === "environment" && record.relativePath === "stugu.env") return targetForDeploymentPath("deployment/settings.env").path;
  if (record.kind === "config") return targetForDeploymentPath(`deployment/config/${assertSafeRelativePath(record.relativePath)}`).path;
  if (record.kind === "secret") return targetForDeploymentPath(`deployment/secrets/${assertSafeRelativePath(record.relativePath)}`).path;
  throw new Error("Migration receipt has an unsafe settings record");
}

export async function swapDatabases(configuration, paths, receipt) {
  const target = safeIdentifier(receipt.targetDatabase, "Target database");
  const candidate = safeIdentifier(receipt.candidateDatabase, "Candidate database");
  const rollback = safeIdentifier(receipt.rollbackDatabase, "Rollback database");
  receipt.databaseSwapStarted = true;
  receipt.databasePhase = "renaming-old";
  atomicJson(paths.receipt, receipt);
  await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} WITH ALLOW_CONNECTIONS false;`);
  await psql(configuration, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN (${sqlLiteral(target)}, ${sqlLiteral(candidate)}) AND pid <> pg_backend_pid();`);
  await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} RENAME TO ${sqlIdentifier(rollback)};`);
  receipt.databasePhase = "old-renamed";
  atomicJson(paths.receipt, receipt);
  try {
    receipt.databasePhase = "installing-candidate";
    atomicJson(paths.receipt, receipt);
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(candidate)} RENAME TO ${sqlIdentifier(target)};`);
  } catch (error) {
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(rollback)} RENAME TO ${sqlIdentifier(target)};`).catch(() => {});
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} WITH ALLOW_CONNECTIONS true;`).catch(() => {});
    throw error;
  }
  receipt.databaseSwapped = true;
  receipt.databasePhase = "installed";
  atomicJson(paths.receipt, receipt);
}
