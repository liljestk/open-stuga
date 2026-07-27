#!/usr/bin/env node

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
} from "./sqlite-snapshot-utils.mjs";

import { main } from "./migrate-telemetry-to-timescale/execution.mjs";

export { MIGRATION_HYPERTABLES } from "./migrate-telemetry-to-timescale/configuration.mjs";

export { MIGRATION_AGGREGATES } from "./migrate-telemetry-to-timescale/configuration.mjs";

export { parseMigrationArgs } from "./migrate-telemetry-to-timescale/configuration.mjs";

export { inventoryTelemetrySource } from "./migrate-telemetry-to-timescale/source-state.mjs";

export { acquireCheckpointLock } from "./migrate-telemetry-to-timescale/source-state.mjs";

export { destinationFingerprint } from "./migrate-telemetry-to-timescale/source-state.mjs";

export { validateExpectedHypertables } from "./migrate-telemetry-to-timescale/destination-schema.mjs";

export { ensureAndRefreshMeasurementAggregates } from "./migrate-telemetry-to-timescale/destination-schema.mjs";

export { provisionDestination } from "./migrate-telemetry-to-timescale/destination-schema.mjs";

export { mapRows } from "./migrate-telemetry-to-timescale/transfer.mjs";

export { upsertBatch } from "./migrate-telemetry-to-timescale/transfer.mjs";

export { verifyBatch } from "./migrate-telemetry-to-timescale/transfer.mjs";

export { runDryMigration } from "./migrate-telemetry-to-timescale/execution.mjs";

export { runMigration } from "./migrate-telemetry-to-timescale/execution.mjs";

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (invokedPath === import.meta.url) await main();
