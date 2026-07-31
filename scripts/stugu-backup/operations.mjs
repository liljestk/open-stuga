import { spawn } from "node:child_process";

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { fileURLToPath } from "node:url";

import {
  assertSqliteCheck,
  createVerifiedSqliteSnapshot,
  hardenPrivateDirectory,
  hardenPrivateFile,
  inventorySqliteTables,
  openReadOnlySqlite,
  sha256File,
} from ".././sqlite-snapshot-utils.mjs";

import { assertReleaseVersion } from "../stugu-migration-common.mjs";

import { BACKUP_VERSION, assetRecords, copyAssets, describedFileRecord, ensureSnapshotStugubyAssets, fileRecord, help, parseBackupArgs, redact, requiredStugubyBlobs, sqliteInventory, sqliteTableRowCount, verifySnapshotStugubyAssetInventory, within } from "./configuration-files.mjs";

import { createTimescaleDump, runDirect } from "./commands-timescale.mjs";

function installedSourceVersion() {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const version = JSON.parse(readFileSync(packagePath, "utf8"))?.version;
  return assertReleaseVersion(version, "Running Stugu package version");
}

export async function verifyBackup(path, pgRestore = "pg_restore", env = process.env, { allowPending = false } = {}) {
  const candidate = resolve(path);
  const manifestPath = statSync(candidate).isDirectory() ? join(candidate, "manifest.json") : candidate;
  const root = dirname(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read backup manifest ${manifestPath}: ${error.message}`);
  }
  if (manifest?.format !== "stugu-backup" || ![1, BACKUP_VERSION].includes(manifest?.version)) {
    throw new Error(`Unsupported backup manifest: ${manifestPath}`);
  }
  if (manifest.sourceVersion !== undefined) {
    try {
      assertReleaseVersion(manifest.sourceVersion, "Backup manifest source version");
    } catch {
      throw new Error("Backup manifest has an invalid source version");
    }
  }
  if (!Array.isArray(manifest.files)) throw new Error("Backup manifest has no file inventory");
  if (!allowPending && manifest.verification?.status !== "passed") {
    throw new Error("Backup manifest is not marked as successfully verified");
  }
  if (basename(manifestPath) === "manifest.json") {
    const checksumPath = join(root, "manifest.sha256");
    if (!existsSync(checksumPath)) throw new Error("Backup manifest checksum sidecar is missing");
    const expectedChecksum = readFileSync(checksumPath, "utf8").trim().split(/\s+/u)[0];
    const actualChecksum = await sha256File(manifestPath);
    if (!/^[a-f0-9]{64}$/u.test(expectedChecksum) || expectedChecksum !== actualChecksum) {
      throw new Error("Backup manifest checksum mismatch");
    }
  }
  let totalBytes = 0;
  let coreSnapshotPath;
  const seenPaths = new Set();
  for (const record of manifest.files ?? []) {
    if (typeof record.path !== "string" || isAbsolute(record.path)) throw new Error("Manifest contains an unsafe file path");
    if (seenPaths.has(record.path)) throw new Error(`Manifest contains a duplicate file path: ${record.path}`);
    seenPaths.add(record.path);
    const artifact = resolve(root, record.path);
    if (!within(root, artifact)) throw new Error("Manifest contains a path outside the backup directory");
    const details = statSync(artifact);
    if (!details.isFile() || details.size !== record.size) throw new Error(`Backup size mismatch: ${record.path}`);
    const checksum = await sha256File(artifact);
    if (checksum !== record.sha256) throw new Error(`Backup checksum mismatch: ${record.path}`);
    totalBytes += details.size;
    if (record.category === "core-sqlite" || record.category === "spatial-sqlite") sqliteInventory(artifact);
    if (record.category === "core-sqlite") {
      if (coreSnapshotPath) throw new Error("Backup manifest contains more than one core SQLite snapshot");
      coreSnapshotPath = artifact;
    }
    if (record.category === "timescale-pgdump") {
      await runDirect(pgRestore, ["--list", artifact], env);
    }
  }
  if (!coreSnapshotPath) throw new Error("Backup manifest has no core SQLite snapshot");
  if (sqliteTableRowCount(coreSnapshotPath, "tracking_endpoints") > 0
    && !manifest.files.some((record) => record.category === "tracking-secret-key")) {
    throw new Error("Backup is missing the tracking secret key required by its encrypted endpoint identities");
  }
  verifySnapshotStugubyAssetInventory(coreSnapshotPath, manifest.files);
  return {
    status: "passed",
    verifiedAt: new Date().toISOString(),
    files: manifest.files.length,
    totalBytes,
    manifestPath,
  };
}

export async function createBackup(options, { afterCoreSnapshot, sourceVersion = installedSourceVersion() } = {}) {
  assertReleaseVersion(sourceVersion, "Backup source version");
  if (existsSync(options.output)) throw new Error(`Refusing to overwrite existing backup output: ${options.output}`);
  if (!existsSync(options.database)) throw new Error(`Core SQLite database does not exist: ${options.database}`);
  hardenPrivateDirectory(options.output);
  const incompletePath = join(options.output, "INCOMPLETE.json");
  writeFileSync(incompletePath, `${JSON.stringify({
    format: "stugu-backup-incomplete",
    startedAt: new Date().toISOString(),
    reason: "Backup creation or verification has not completed",
  }, null, 2)}\n`, { encoding: "utf8", flush: true, mode: 0o600 });
  hardenPrivateFile(incompletePath);

  const manifest = {
    format: "stugu-backup",
    version: BACKUP_VERSION,
    sourceVersion,
    createdAt: new Date().toISOString(),
    sensitivity: "confidential-household-authentication-and-telemetry-data",
    includesSecrets: options.includeSecrets,
    files: [],
    sources: {},
    verification: { status: "pending" },
  };

  // Copy the live asset tree before taking the SQLite snapshot. A concurrent
  // revoke may delete an old blob immediately after the snapshot; pre-copying
  // preserves that exact blob, while the snapshot-driven pass below fills any
  // files created during this first traversal.
  const assetDestination = join(options.output, "assets");
  const assetResult = await copyAssets(options.assets, assetDestination, options.output);

  const databaseDirectory = join(options.output, "databases");
  const coreDestination = join(databaseDirectory, "climate-twin.sqlite");
  const core = await createVerifiedSqliteSnapshot({
    sourcePath: options.database,
    destinationPath: coreDestination,
    hashSource: false,
    sourceImmutable: options.quiescedSqlite,
  });
  await afterCoreSnapshot?.({ snapshotPath: coreDestination });
  const requiredStugubyBlobCount = await ensureSnapshotStugubyAssets(
    coreDestination,
    options.assets,
    assetDestination,
  );
  manifest.files.push(describedFileRecord(options.output, core.snapshot, "core-sqlite"));
  manifest.sources.coreDatabase = {
    status: "included",
    originalPath: options.database,
    snapshotChecks: core.checks,
    inventory: sqliteInventory(coreDestination, { checkIntegrity: false }),
  };
  const copiedAssetRecords = await assetRecords(assetDestination, options.output);
  manifest.files.push(...copiedAssetRecords);
  manifest.sources.assets = {
    ...assetResult,
    files: copiedAssetRecords.length,
    bytes: copiedAssetRecords.reduce((total, record) => total + record.size, 0),
    requiredStugubyBlobs: requiredStugubyBlobCount,
    originalPath: options.assets,
  };

  if (existsSync(options.spatialDatabase)) {
    const spatialDestination = join(databaseDirectory, "experimental-spatial-layers.sqlite");
    const spatial = await createVerifiedSqliteSnapshot({
      sourcePath: options.spatialDatabase,
      destinationPath: spatialDestination,
      hashSource: false,
      sourceImmutable: options.quiescedSqlite,
    });
    manifest.files.push(describedFileRecord(options.output, spatial.snapshot, "spatial-sqlite"));
    manifest.sources.spatialDatabase = {
      status: "included",
      originalPath: options.spatialDatabase,
      snapshotChecks: spatial.checks,
      inventory: sqliteInventory(spatialDestination, { checkIntegrity: false }),
    };
  } else {
    manifest.sources.spatialDatabase = { status: "missing" };
  }

  if (existsSync(options.stugubyIdentityFile)) {
    if (!statSync(options.stugubyIdentityFile).isFile()) throw new Error("The Stuguby identity path is not a regular file");
    const identityDestination = join(options.output, "secrets", "stuguby-identity.json");
    mkdirSync(dirname(identityDestination), { recursive: true, mode: 0o700 });
    hardenPrivateDirectory(dirname(identityDestination));
    copyFileSync(options.stugubyIdentityFile, identityDestination);
    hardenPrivateFile(identityDestination);
    manifest.files.push(await fileRecord(options.output, identityDestination, "stuguby-identity"));
    manifest.sources.stugubyIdentity = { status: "included", sensitive: true, originalPath: options.stugubyIdentityFile };
  } else {
    manifest.sources.stugubyIdentity = { status: "missing", originalPath: options.stugubyIdentityFile };
  }

  const trackingEndpointCount = sqliteTableRowCount(coreDestination, "tracking_endpoints");
  if (existsSync(options.trackingSecretKeyFile)) {
    if (!statSync(options.trackingSecretKeyFile).isFile()) {
      throw new Error("The tracking secret key path is not a regular file");
    }
    const trackingKeyDestination = join(options.output, "secrets", "tracking-secret.key");
    mkdirSync(dirname(trackingKeyDestination), { recursive: true, mode: 0o700 });
    hardenPrivateDirectory(dirname(trackingKeyDestination));
    copyFileSync(options.trackingSecretKeyFile, trackingKeyDestination);
    hardenPrivateFile(trackingKeyDestination);
    manifest.files.push(await fileRecord(options.output, trackingKeyDestination, "tracking-secret-key"));
    manifest.sources.trackingSecretKey = {
      status: "included",
      sensitive: true,
      originalPath: options.trackingSecretKeyFile,
      encryptedEndpointRecords: trackingEndpointCount,
    };
  } else {
    if (trackingEndpointCount > 0) {
      throw new Error(
        "The core snapshot contains encrypted tracking endpoint identities but TRACKING_SECRET_KEY_FILE is missing",
      );
    }
    manifest.sources.trackingSecretKey = {
      status: "missing",
      originalPath: options.trackingSecretKeyFile,
      encryptedEndpointRecords: 0,
    };
  }

  if (options.includeSecrets) {
    if (!existsSync(options.secretsFile)) {
      throw new Error("--include-secrets was requested, but the integration secrets file does not exist");
    }
    if (!statSync(options.secretsFile).isFile()) throw new Error("The integration secrets path is not a regular file");
    const secretDestination = join(options.output, "secrets", "integration-secrets.json");
    mkdirSync(dirname(secretDestination), { recursive: true });
    copyFileSync(options.secretsFile, secretDestination);
    try {
      chmodSync(secretDestination, 0o600);
    } catch {
      // Windows ACLs are inherited from the destination directory.
    }
    manifest.files.push(await fileRecord(options.output, secretDestination, "integration-secrets"));
    manifest.sources.integrationSecrets = { status: "included", sensitive: true };
  } else {
    manifest.sources.integrationSecrets = { status: "excluded", reason: "Requires --include-secrets" };
  }

  if (options.includeTimescale) {
    const dumpDestination = join(databaseDirectory, "telemetry.pgdump");
    const ownershipValidationDestination = join(options.output, "restore", "validate-timescale-ownership.sql");
    manifest.sources.timescale = await createTimescaleDump(
      options,
      dumpDestination,
      ownershipValidationDestination,
    );
    manifest.files.push(await fileRecord(options.output, dumpDestination, "timescale-pgdump"));
    manifest.files.push(await fileRecord(
      options.output,
      ownershipValidationDestination,
      "timescale-ownership-validation",
    ));
  } else {
    manifest.sources.timescale = { status: "excluded", reason: "Requires --include-timescale" };
  }

  const pendingManifest = join(options.output, "manifest.pending.json");
  writeFileSync(pendingManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8", flush: true, mode: 0o600,
  });
  hardenPrivateFile(pendingManifest);
  const verification = await verifyBackup(pendingManifest, options.pgRestore, process.env, { allowPending: true });
  manifest.verification = {
    status: "passed",
    verifiedAt: verification.verifiedAt,
    files: verification.files,
    totalBytes: verification.totalBytes,
  };
  manifest.completedAt = new Date().toISOString();
  const manifestPath = join(options.output, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8", flush: true, mode: 0o600,
  });
  hardenPrivateFile(manifestPath);
  const manifestChecksum = await sha256File(manifestPath);
  const manifestChecksumPath = join(options.output, "manifest.sha256");
  writeFileSync(manifestChecksumPath, `${manifestChecksum}  manifest.json\n`, {
    encoding: "utf8",
    flush: true,
    mode: 0o600,
  });
  hardenPrivateFile(manifestChecksumPath);
  unlinkSync(pendingManifest);
  unlinkSync(incompletePath);
  console.log(`Verified backup created: ${options.output}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Manifest SHA-256: ${manifestChecksum}`);
  console.log(`Files: ${verification.files}; bytes: ${verification.totalBytes}`);
  console.log(`Secrets: ${options.includeSecrets ? "included by explicit request" : "excluded"}`);
  console.log(`Timescale: ${options.includeTimescale ? "included and catalog-verified" : "excluded"}`);
  return manifest;
}

export async function main() {
  let options;
  try {
    options = parseBackupArgs(process.argv.slice(2));
    if (options.help) {
      console.log(help());
      return;
    }
    if (options.verify) {
      const verification = await verifyBackup(options.verify, options.pgRestore);
      console.log(`Backup verification passed: ${verification.manifestPath}`);
      console.log(`Files: ${verification.files}; bytes: ${verification.totalBytes}`);
      return;
    }
    await createBackup(options);
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), process.env);
    console.error(`Backup failed: ${message}`);
    process.exitCode = 1;
  }
}
