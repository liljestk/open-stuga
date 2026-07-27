import { createHash, randomUUID } from "node:crypto";

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { hostname } from "node:os";

import { dirname, resolve } from "node:path";

import { pathToFileURL } from "node:url";

import {
  assertSqliteCheck,
  createVerifiedSqliteSnapshot,
  describeFile,
  hardenPrivateFile,
  openReadOnlySqlite,
  quoteSqliteIdentifier,
} from ".././sqlite-snapshot-utils.mjs";

import { acquireCheckpointLock, destinationFingerprint, inventoryTelemetrySource, legacyDestinationFingerprint, loadPgClient, printInventory, redactConnectionText, sourceBlockers, writeManifest } from "./source-state.mjs";

import { buildOrLoadManifest, migrateTables, verifyAllTables } from "./transfer.mjs";

import { DESTINATION_FINGERPRINT_VERSION, help, parseMigrationArgs } from "./configuration.mjs";

import { ensureAndRefreshMeasurementAggregates, provisionDestination, requireTimescaleDestination, validateDestinationSchema } from "./destination-schema.mjs";

export async function runDryMigration(options) {
  if (!existsSync(options.source)) throw new Error(`SQLite source does not exist: ${options.source}`);
  const database = openReadOnlySqlite(options.source);
  try {
    assertSqliteCheck(database, "quick_check");
    assertSqliteCheck(database, "integrity_check");
    const inventory = inventoryTelemetrySource(database);
    printInventory(inventory);
    const blockers = sourceBlockers(inventory);
    if (blockers.length > 0) throw new Error(`Migration preflight blocked:\n  - ${blockers.join("\n  - ")}`);
    console.log("Dry run passed. No snapshot, checkpoint, or destination changes were made.");
    return inventory;
  } finally {
    database.close();
  }
}

export async function runMigration(options) {
  if (options.dryRun) return runDryMigration(options);
  let releaseLock = () => undefined;
  let client;
  let database;
  let advisoryLockHeld = false;
  const interrupted = { requested: false };
  const onInterrupt = () => { interrupted.requested = true; };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    client = await loadPgClient(options.pgClientConfig);
    const fingerprint = await destinationFingerprint(client, options.schema);
    const advisory = await client.query(
      "SELECT pg_try_advisory_lock(hashtext('stugu-telemetry-migration'), hashtext($1)) AS acquired",
      [options.schema],
    );
    if (!advisory.rows[0]?.acquired) {
      throw new Error("Another telemetry migration or verification is active on this destination schema");
    }
    advisoryLockHeld = true;
    releaseLock = acquireCheckpointLock(options.checkpoint, {
      destinationFingerprint: fingerprint,
      advisoryLockHeld,
    });

    const manifest = await buildOrLoadManifest(options);
    printInventory(manifest.inventory);
    if (manifest.blockers.length > 0) {
      throw new Error(`Migration preflight blocked:\n  - ${manifest.blockers.join("\n  - ")}`);
    }
    database = openReadOnlySqlite(options.snapshot);
    let upgradeFingerprintAfterVerification = false;
    if (manifest.destinationFingerprint) {
      const fingerprintVersion = Number(manifest.destinationFingerprintVersion ?? 1);
      if (fingerprintVersion === DESTINATION_FINGERPRINT_VERSION) {
        if (manifest.destinationFingerprint !== fingerprint) {
          throw new Error("The checkpoint belongs to a different PostgreSQL destination");
        }
      } else if (fingerprintVersion === 1) {
        const legacyFingerprint = await legacyDestinationFingerprint(client, options.schema);
        if (manifest.destinationFingerprint === legacyFingerprint || manifest.destinationFingerprint === fingerprint) {
          manifest.destinationFingerprint = fingerprint;
          manifest.destinationFingerprintVersion = DESTINATION_FINGERPRINT_VERSION;
        } else if (options.verifyOnly && manifest.state === "complete") {
          // A v1 fingerprint included the server's transport address. When a
          // container was recreated, exact read-only verification of a complete
          // import is the safe proof needed to bind it to the durable v2 ID.
          upgradeFingerprintAfterVerification = true;
        } else {
          throw new Error(
            "The legacy checkpoint destination changed; run --verify-only against a complete import before resuming",
          );
        }
      } else {
        throw new Error(`Unsupported destination fingerprint version: ${fingerprintVersion}`);
      }
    } else {
      manifest.destinationFingerprint = fingerprint;
      manifest.destinationFingerprintVersion = DESTINATION_FINGERPRINT_VERSION;
    }
    if (!upgradeFingerprintAfterVerification) writeManifest(options.checkpoint, manifest);

    if (options.verifyOnly) {
      const timescale = await requireTimescaleDestination(client, options.schema);
      await validateDestinationSchema(client, options.schema);
      manifest.destinationTimescale = {
        ...timescale,
        validatedAt: new Date().toISOString(),
      };
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        manifest.verification = {
          status: "passed",
          verifiedAt: new Date().toISOString(),
          tables: await verifyAllTables(client, database, options, manifest.inventory),
        };
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      if (upgradeFingerprintAfterVerification) {
        manifest.destinationFingerprint = fingerprint;
        manifest.destinationFingerprintVersion = DESTINATION_FINGERPRINT_VERSION;
      }
      writeManifest(options.checkpoint, manifest);
      console.log("Destination verification passed; no destination changes were made.");
      return manifest;
    }
    const timescale = await provisionDestination(client, options.schema, options.maintenanceTimeoutMs);
    await validateDestinationSchema(client, options.schema);
    manifest.destinationTimescale = {
      ...timescale,
      maintenanceTimeoutMs: options.maintenanceTimeoutMs,
      validatedAt: new Date().toISOString(),
    };
    writeManifest(options.checkpoint, manifest);
    await migrateTables(client, database, options, manifest, interrupted);
    manifest.verification = {
      status: "passed",
      verifiedAt: new Date().toISOString(),
      tables: await verifyAllTables(client, database, options, manifest.inventory),
    };
    writeManifest(options.checkpoint, manifest);
    manifest.aggregateRefresh = {
      status: "passed",
      refreshedAt: new Date().toISOString(),
      aggregates: await ensureAndRefreshMeasurementAggregates(
        client,
        options.schema,
        manifest.inventory.measurement_samples,
        options.maintenanceTimeoutMs,
      ),
    };
    manifest.state = "complete";
    manifest.completedAt = new Date().toISOString();
    writeManifest(options.checkpoint, manifest);
    console.log(`Migration complete. Checkpoint retained at ${options.checkpoint}`);
    console.log(`Consistent source snapshot retained at ${options.snapshot}`);
    return manifest;
  } catch (error) {
    const message = redactConnectionText(error instanceof Error ? error.message : String(error), options.connectionSecrets);
    throw new Error(message, { cause: error });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    try {
      database?.close();
    } catch {
      // Preserve an earlier migration failure.
    }
    releaseLock();
    try {
      if (advisoryLockHeld) {
        await client?.query("SELECT pg_advisory_unlock(hashtext('stugu-telemetry-migration'), hashtext($1))", [options.schema]);
      }
    } catch {
      // The server releases session advisory locks on disconnect.
    }
    try {
      await client?.end();
    } catch {
      // Preserve an earlier migration failure.
    }
  }
}

export async function main() {
  let options;
  try {
    options = parseMigrationArgs(process.argv.slice(2));
    if (options.help) {
      console.log(help());
      return;
    }
    await runMigration(options);
  } catch (error) {
    const message = redactConnectionText(
      error instanceof Error ? error.message : String(error),
      options?.connectionSecrets,
    );
    console.error(`Migration failed: ${message}`);
    process.exitCode = 1;
  }
}
