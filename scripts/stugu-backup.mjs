#!/usr/bin/env node

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

import { pathToFileURL } from "node:url";

import {
  assertSqliteCheck,
  createVerifiedSqliteSnapshot,
  hardenPrivateDirectory,
  hardenPrivateFile,
  inventorySqliteTables,
  openReadOnlySqlite,
  sha256File,
} from "./sqlite-snapshot-utils.mjs";

import { main } from "./stugu-backup/operations.mjs";

export { parseBackupArgs } from "./stugu-backup/configuration-files.mjs";

export { timescaleDumpArguments } from "./stugu-backup/commands-timescale.mjs";

export { timescaleOwnershipValidationSql } from "./stugu-backup/commands-timescale.mjs";

export { timescalePreRestoreSql } from "./stugu-backup/commands-timescale.mjs";

export { timescaleRestorePlan } from "./stugu-backup/commands-timescale.mjs";

export { verifyBackup } from "./stugu-backup/operations.mjs";

export { createBackup } from "./stugu-backup/operations.mjs";

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (invokedPath === import.meta.url) await main();
