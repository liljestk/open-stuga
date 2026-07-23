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

const BACKUP_VERSION = 2;
const DEFAULT_SCHEMA = "telemetry";
const DEFAULT_APPLICATION_ROLE = "stuga_app";
const DEFAULT_ADMIN_ROLE = "stuga_admin";

function timestampForPath(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

function help() {
  return `Verified Stuga backup

Usage:
  node scripts/stuga-backup.mjs [options]
  node scripts/stuga-backup.mjs --verify <backup-directory-or-manifest>

Create options:
  --database <file>        Core SQLite DB (default: DATABASE_PATH or ./data/climate-twin.sqlite)
  --output <directory>     New backup directory (default: ./backups/stuga-backup-<UTC timestamp>)
  --assets <directory>     External assets directory (default: ASSET_DIRECTORY or ./data/assets)
  --spatial-db <file>      Spatial SQLite DB (default: SPATIAL_LAYERS_DATABASE_PATH or next to core DB)
  --include-secrets        Opt in to copying the integration secrets file
  --secrets-file <file>    Secrets path (default: INTEGRATION_SECRETS_FILE or next to core DB)
  --include-timescale      Opt in to a pg_dump custom-format telemetry backup
  --schema <name>          Telemetry schema recorded for restore checks (default: telemetry)
  --application-role <name> Expected telemetry owner after restore (default: TIMESERIES_USER or stuga_app)
  --admin-role <name>      Pre-created Compose restore/extension owner (default: TIMESERIES_ADMIN_USER or stuga_admin)
  --pg-dump <executable>   pg_dump executable/path (default: pg_dump)
  --pg-restore <executable> pg_restore executable/path (default: pg_restore)
  -h, --help               Show this help

Verification options:
  --verify <path>          Verify every manifest checksum, SQLite integrity, and pg_dump catalog
  --pg-restore <executable> pg_restore executable/path used to inspect a custom dump

Timescale credentials:
  With --include-timescale, connection details are read only from
  TIMESCALE_DATABASE_URL, DATABASE_URL, or standard libpq PG* environment
  variables, then from TIMESERIES_HOST/PORT/DATABASE/USER/PASSWORD. Passwords
  are never accepted as CLI arguments, printed, stored in the manifest, or put
  in process arguments. pg_dump is spawned directly without a shell.

The output is a transparent directory, not a proprietary archive. It contains
consistent SQLite snapshots, copied assets, an optional custom-format PostgreSQL
dump, optional secrets, and a checksummed manifest. Existing output is never
overwritten. Any failed run remains marked INCOMPLETE for inspection.

Every artifact is sensitive, including the SQLite snapshots and manifest. The
tool enforces owner-only modes or a private Windows ACL, but the destination
must also be protected and preferably encrypted.

The PostgreSQL dump is deliberately a full-database dump. Timescale hypertable
chunks and catalog relationships cannot be safely recovered from a schema-filtered
pg_dump. Owner metadata is preserved. Restore it only into a new, empty database
with matching PostgreSQL/TimescaleDB versions and pre-created matching owner
roles, then run the included ownership validator before starting the API.

Examples:
  node scripts/stuga-backup.mjs --database ./data/climate-twin.sqlite
  node scripts/stuga-backup.mjs --include-timescale
  node scripts/stuga-backup.mjs --include-secrets --secrets-file ./data/integration-secrets.json
  node scripts/stuga-backup.mjs --verify ./backups/stuga-backup-2026-07-18T12-00-00-000Z
`;
}

function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function validatedPort(value, label, fallback) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} must be an integer from 1 to 65535`);
  return String(port);
}

function timeseriesPasswordFromEnvironment(env) {
  if (env.TIMESERIES_PASSWORD !== undefined && env.TIMESERIES_PASSWORD_FILE) {
    throw new Error("Configure only one of TIMESERIES_PASSWORD or TIMESERIES_PASSWORD_FILE");
  }
  if (!env.TIMESERIES_PASSWORD_FILE) return env.TIMESERIES_PASSWORD ?? "";
  const password = readFileSync(resolve(env.TIMESERIES_PASSWORD_FILE), "utf8").trim();
  if (!password) throw new Error("TIMESERIES_PASSWORD_FILE must not be empty");
  return password;
}

export function parseBackupArgs(argv, env = process.env, now = new Date()) {
  const parsed = { help: false, includeSecrets: false, includeTimescale: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") parsed.help = true;
    else if (argument === "--include-secrets") parsed.includeSecrets = true;
    else if (argument === "--include-timescale") parsed.includeTimescale = true;
    else if (argument === "--database") {
      parsed.database = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--output") {
      parsed.output = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--assets") {
      parsed.assets = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--spatial-db") {
      parsed.spatialDatabase = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--secrets-file") {
      parsed.secretsFile = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--schema") {
      parsed.schema = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--application-role") {
      parsed.applicationRole = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--admin-role") {
      parsed.adminRole = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--pg-dump") {
      parsed.pgDump = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--pg-restore") {
      parsed.pgRestore = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--verify") {
      parsed.verify = argumentValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  parsed.pgDump ??= "pg_dump";
  parsed.pgRestore ??= "pg_restore";
  if (parsed.verify !== undefined) {
    const incompatible = parsed.includeSecrets || parsed.includeTimescale
      || parsed.database !== undefined || parsed.output !== undefined || parsed.assets !== undefined
      || parsed.spatialDatabase !== undefined || parsed.secretsFile !== undefined
      || parsed.applicationRole !== undefined || parsed.adminRole !== undefined;
    if (incompatible) throw new Error("--verify cannot be combined with backup creation options");
    parsed.verify = resolve(parsed.verify);
    return parsed;
  }

  const databaseValue = parsed.database ?? env.DATABASE_PATH ?? "./data/climate-twin.sqlite";
  if (databaseValue === ":memory:") throw new Error("An in-memory database cannot be backed up");
  parsed.database = resolve(databaseValue);
  parsed.output = resolve(parsed.output ?? join("./backups", `stuga-backup-${timestampForPath(now)}`));
  parsed.assets = resolve(parsed.assets ?? env.ASSET_DIRECTORY ?? "./data/assets");
  parsed.spatialDatabase = resolve(
    parsed.spatialDatabase
      ?? env.SPATIAL_LAYERS_DATABASE_PATH
      ?? join(dirname(parsed.database), "experimental-spatial-layers.sqlite"),
  );
  parsed.secretsFile = resolve(
    parsed.secretsFile
      ?? env.INTEGRATION_SECRETS_FILE
      ?? join(dirname(parsed.database), "integration-secrets.json"),
  );
  parsed.schema ??= DEFAULT_SCHEMA;
  if (!/^[a-z_][a-z0-9_]*$/.test(parsed.schema)) {
    throw new Error("--schema must be a lowercase PostgreSQL identifier");
  }
  parsed.applicationRole ??= env.TIMESERIES_USER || DEFAULT_APPLICATION_ROLE;
  parsed.adminRole ??= env.TIMESERIES_ADMIN_USER || DEFAULT_ADMIN_ROLE;
  for (const [flag, role] of [["--application-role", parsed.applicationRole], ["--admin-role", parsed.adminRole]]) {
    if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`${flag} must be a lowercase PostgreSQL identifier`);
  }
  const connectionUrl = env.TIMESCALE_DATABASE_URL ?? env.DATABASE_URL;
  const pgKeys = [
    "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSERVICE",
    "PGSERVICEFILE", "PGSSLMODE", "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY",
  ];
  const hasPgEnvironment = pgKeys.some((key) => env[key] !== undefined && env[key] !== "");
  const hasTimeseriesEnvironment = [
    env.TIMESERIES_HOST,
    env.TIMESERIES_PORT,
    env.TIMESERIES_DATABASE,
    env.TIMESERIES_USER,
    env.TIMESERIES_PASSWORD,
    env.TIMESERIES_PASSWORD_FILE,
  ].some((value) => value !== undefined);
  if (connectionUrl) {
    // libpq treats PGDATABASE as a connection string. Keeping it in the child
    // environment prevents credentials from appearing in process arguments.
    parsed.pgConnectionEnvironment = { PGDATABASE: connectionUrl };
  } else if (hasPgEnvironment) {
    validatedPort(env.PGPORT, "PGPORT", undefined);
    parsed.pgConnectionEnvironment = Object.fromEntries(
      pgKeys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]),
    );
  } else if (hasTimeseriesEnvironment) {
    const password = timeseriesPasswordFromEnvironment(env);
    parsed.pgConnectionEnvironment = {
      PGHOST: env.TIMESERIES_HOST || "127.0.0.1",
      PGPORT: validatedPort(env.TIMESERIES_PORT, "TIMESERIES_PORT", "5432"),
      PGDATABASE: env.TIMESERIES_DATABASE || "stuga",
      PGUSER: env.TIMESERIES_USER || "stuga_app",
      PGPASSWORD: password,
    };
  }
  parsed.pgEnvironmentAvailable = parsed.pgConnectionEnvironment !== undefined;
  if (parsed.includeTimescale && !parsed.pgEnvironmentAvailable) {
    throw new Error(
      "--include-timescale requires a URL, PG* variables, or the application's TIMESERIES_* variables in the environment",
    );
  }
  return parsed;
}

function within(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function portable(path) {
  return path.split(sep).join("/");
}

function postgresLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function fileRecord(root, path, category) {
  const absolute = resolve(path);
  if (!within(root, absolute)) throw new Error(`Backup file escaped output directory: ${absolute}`);
  hardenPrivateFile(absolute);
  const details = statSync(absolute);
  if (!details.isFile()) throw new Error(`Backup artifact is not a regular file: ${absolute}`);
  return {
    path: portable(relative(root, absolute)),
    category,
    size: details.size,
    sha256: await sha256File(absolute),
    sensitive: true,
  };
}

function describedFileRecord(root, description, category) {
  if (!within(root, description.path) || typeof description.sha256 !== "string") {
    throw new Error("Verified snapshot description is incomplete or outside the backup directory");
  }
  hardenPrivateFile(description.path);
  return {
    path: portable(relative(root, description.path)),
    category,
    size: description.size,
    sha256: description.sha256,
    sensitive: true,
  };
}

function sqliteInventory(path, { checkIntegrity = true } = {}) {
  const database = openReadOnlySqlite(path);
  try {
    const integrity = checkIntegrity ? assertSqliteCheck(database, "integrity_check") : undefined;
    return {
      ...(integrity === undefined ? {} : { integrity }),
      tables: inventorySqliteTables(database),
    };
  } finally {
    database.close();
  }
}

function walkAssets(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const details = lstatSync(path);
      if (details.isSymbolicLink()) throw new Error(`Asset directory contains a symbolic link: ${path}`);
      if (details.isDirectory()) visit(path);
      else if (details.isFile()) files.push(path);
      else throw new Error(`Asset directory contains an unsupported entry: ${path}`);
    }
  };
  visit(root);
  return files;
}

async function copyAssets(source, destination, backupRoot) {
  if (!existsSync(source)) return { status: "missing", files: 0, bytes: 0 };
  if (!statSync(source).isDirectory()) throw new Error(`Assets path is not a directory: ${source}`);
  if (within(source, backupRoot)) throw new Error("The backup output cannot be inside the assets directory");
  const files = walkAssets(source);
  let bytes = 0;
  const records = [];
  for (const sourceFile of files) {
    const relativePath = relative(source, sourceFile);
    const destinationFile = join(destination, relativePath);
    mkdirSync(dirname(destinationFile), { recursive: true });
    copyFileSync(sourceFile, destinationFile);
    const record = await fileRecord(backupRoot, destinationFile, "asset");
    bytes += record.size;
    records.push(record);
  }
  return { status: "included", files: files.length, bytes, records };
}

function redact(text, environment) {
  let result = String(text ?? "");
  const sensitiveValues = [
    environment.TIMESCALE_DATABASE_URL,
    environment.DATABASE_URL,
    environment.PGDATABASE,
    environment.PGPASSWORD,
    environment.PGHOST,
    environment.PGHOSTADDR,
    environment.PGUSER,
    environment.TIMESERIES_PASSWORD,
    environment.TIMESERIES_HOST,
    environment.TIMESERIES_DATABASE,
    environment.TIMESERIES_USER,
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const value of sensitiveValues) result = result.replaceAll(value, "[REDACTED]");
  return result;
}

function runDirect(executable, arguments_, environment) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, arguments_, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let standardError = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (standardError.length < 64 * 1024) standardError += chunk;
    });
    child.on("error", (error) => reject(new Error(`${basename(executable)} could not start: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) accept();
      else {
        const detail = redact(standardError.trim(), environment);
        reject(new Error(
          `${basename(executable)} failed (${signal ? `signal ${signal}` : `exit ${code}`})${detail ? `: ${detail}` : ""}`,
        ));
      }
    });
  });
}

function runCapture(executable, arguments_, environment) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, arguments_, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let standardOutput = "";
    let standardError = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (standardOutput.length < 64 * 1024) standardOutput += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (standardError.length < 64 * 1024) standardError += chunk;
    });
    child.on("error", (error) => reject(new Error(`${basename(executable)} could not start: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) accept(standardOutput);
      else {
        const detail = redact(standardError.trim(), environment);
        reject(new Error(
          `${basename(executable)} failed (${signal ? `signal ${signal}` : `exit ${code}`})${detail ? `: ${detail}` : ""}`,
        ));
      }
    });
  });
}

function postgresEnvironment(options, env = process.env) {
  return { ...env, ...options.pgConnectionEnvironment };
}

export function timescaleDumpArguments(destination) {
  return [
    "--format=custom",
    // Preserve owner metadata. A fresh Compose restore pre-creates the same
    // admin/application roles so telemetry relations, chunks, and continuous
    // aggregates do not silently become owned by the restore login.
    "--no-privileges",
    "--no-tablespaces",
    `--file=${destination}`,
  ];
}

export function timescaleOwnershipValidationSql(schema, applicationRole) {
  const schemaLiteral = postgresLiteral(schema);
  const roleLiteral = postgresLiteral(applicationRole);
  return `\\set ON_ERROR_STOP on
-- Run as the restore administrator after timescaledb_post_restore(). This is
-- validation only: role-preserving pg_dump/pg_restore is the ownership mechanism.
DO $stuga_ownership$
DECLARE
  expected_role oid;
  unexpected text;
BEGIN
  SELECT oid INTO expected_role FROM pg_roles WHERE rolname = ${roleLiteral};
  IF expected_role IS NULL THEN
    RAISE EXCEPTION 'Required application role % does not exist', ${roleLiteral};
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname = ${schemaLiteral} AND nspowner = expected_role
  ) THEN
    RAISE EXCEPTION 'Schema % is not owned by role %', ${schemaLiteral}, ${roleLiteral};
  END IF;
  IF NOT has_schema_privilege(${roleLiteral}, ${schemaLiteral}, 'USAGE')
     OR NOT has_schema_privilege(${roleLiteral}, ${schemaLiteral}, 'CREATE') THEN
    RAISE EXCEPTION 'Role % lacks USAGE,CREATE on schema %', ${roleLiteral}, ${schemaLiteral};
  END IF;

  SELECT string_agg(format('%I.%I owned by %I', namespace.nspname, relation.relname, owner.rolname), ', '
    ORDER BY namespace.nspname, relation.relname)
  INTO unexpected
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  JOIN pg_roles owner ON owner.oid = relation.relowner
  WHERE namespace.nspname = ${schemaLiteral}
    AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
    AND relation.relowner <> expected_role;
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'Telemetry relations have unexpected owners: %', unexpected;
  END IF;

  SELECT string_agg(format('%I.%I owned by %I', chunk.chunk_schema, chunk.chunk_name, owner.rolname), ', '
    ORDER BY chunk.chunk_schema, chunk.chunk_name)
  INTO unexpected
  FROM timescaledb_information.chunks chunk
  JOIN pg_namespace namespace ON namespace.nspname = chunk.chunk_schema
  JOIN pg_class relation ON relation.relnamespace = namespace.oid AND relation.relname = chunk.chunk_name
  JOIN pg_roles owner ON owner.oid = relation.relowner
  WHERE chunk.hypertable_schema = ${schemaLiteral}
    AND relation.relowner <> expected_role;
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'Raw hypertable chunks have unexpected owners: %', unexpected;
  END IF;

  SELECT string_agg(format('%I.%I owned by %I', aggregate.view_schema, aggregate.view_name, owner.rolname), ', '
    ORDER BY aggregate.view_schema, aggregate.view_name)
  INTO unexpected
  FROM timescaledb_information.continuous_aggregates aggregate
  JOIN pg_namespace namespace ON namespace.nspname = aggregate.view_schema
  JOIN pg_class relation ON relation.relnamespace = namespace.oid AND relation.relname = aggregate.view_name
  JOIN pg_roles owner ON owner.oid = relation.relowner
  WHERE aggregate.view_schema = ${schemaLiteral}
    AND relation.relowner <> expected_role;
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'Continuous aggregate views have unexpected owners: %', unexpected;
  END IF;

  SELECT string_agg(format('%I.%I owned by %I', aggregate.materialization_hypertable_schema,
      aggregate.materialization_hypertable_name, owner.rolname), ', '
    ORDER BY aggregate.materialization_hypertable_schema, aggregate.materialization_hypertable_name)
  INTO unexpected
  FROM timescaledb_information.continuous_aggregates aggregate
  JOIN pg_namespace namespace ON namespace.nspname = aggregate.materialization_hypertable_schema
  JOIN pg_class relation ON relation.relnamespace = namespace.oid
    AND relation.relname = aggregate.materialization_hypertable_name
  JOIN pg_roles owner ON owner.oid = relation.relowner
  WHERE aggregate.view_schema = ${schemaLiteral}
    AND relation.relowner <> expected_role;
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'Continuous aggregate materializations have unexpected owners: %', unexpected;
  END IF;

  SELECT string_agg(format('%I.%I owned by %I', chunk.chunk_schema, chunk.chunk_name, owner.rolname), ', '
    ORDER BY chunk.chunk_schema, chunk.chunk_name)
  INTO unexpected
  FROM timescaledb_information.continuous_aggregates aggregate
  JOIN timescaledb_information.chunks chunk
    ON chunk.hypertable_schema = aggregate.materialization_hypertable_schema
   AND chunk.hypertable_name = aggregate.materialization_hypertable_name
  JOIN pg_namespace namespace ON namespace.nspname = chunk.chunk_schema
  JOIN pg_class relation ON relation.relnamespace = namespace.oid AND relation.relname = chunk.chunk_name
  JOIN pg_roles owner ON owner.oid = relation.relowner
  WHERE aggregate.view_schema = ${schemaLiteral}
    AND relation.relowner <> expected_role;
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'Continuous aggregate chunks have unexpected owners: %', unexpected;
  END IF;
END
$stuga_ownership$;
`;
}

export function timescalePreRestoreSql(schema) {
  const schemaLiteral = postgresLiteral(schema);
  return `DO $stuga_pre_restore$
DECLARE
  existing_relations bigint;
BEGIN
  SELECT count(*) INTO existing_relations
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = ${schemaLiteral};
  IF existing_relations > 0 THEN
    RAISE EXCEPTION 'Refusing to restore over non-empty schema % (% relations)',
      ${schemaLiteral}, existing_relations;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${schemaLiteral}) THEN
    EXECUTE format('DROP SCHEMA %I', ${schemaLiteral});
  END IF;
END
$stuga_pre_restore$;
SELECT timescaledb_pre_restore();`;
}

export function timescaleRestorePlan(options, dumpDestination, validationDestination) {
  const dumpPath = portable(relative(options.output, dumpDestination));
  const validationPath = portable(relative(options.output, validationDestination));
  return {
    automatic: false,
    ownershipMode: "preserve-source-roles",
    requiredRoles: [...new Set([options.adminRole, options.applicationRole])],
    adminRole: options.adminRole,
    applicationRole: options.applicationRole,
    rolePrecondition: "Restore only into a freshly bootstrapped target where every source owner role exists; the supplied Compose bootstrap pre-creates the recorded admin and application roles and an empty telemetry schema.",
    preRestoreSql: timescalePreRestoreSql(options.schema),
    command: `pg_restore --exit-on-error --no-privileges --no-tablespaces --dbname \"$TIMESCALE_RESTORE_DATABASE_URL\" \"${dumpPath}\"`,
    postRestoreSql: "SELECT timescaledb_post_restore(); ANALYZE;",
    ownershipValidation: {
      file: validationPath,
      command: `psql \"$TIMESCALE_RESTORE_DATABASE_URL\" -X -v ON_ERROR_STOP=1 -f \"${validationPath}\"`,
      checks: [
        "telemetry schema and relations",
        "raw hypertable chunks",
        "continuous aggregate views",
        "continuous aggregate materialization hypertables and chunks",
      ],
    },
    restoreDrill: {
      status: "not-performed",
      note: "Backup creation and catalog inspection do not constitute a live restore drill.",
    },
    note: "Connect as the recorded restore administrator, keep the API stopped, run preRestoreSql, restore serially without --no-owner or parallel jobs, run postRestoreSql, then run the fail-closed ownership validator before application checks.",
  };
}

async function createTimescaleDump(options, destination, validationDestination) {
  mkdirSync(dirname(destination), { recursive: true });
  const environment = postgresEnvironment(options);
  const logicalBytesText = await runCapture("psql", [
    "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-c", "SELECT pg_database_size(current_database())::bigint;",
  ], environment);
  const logicalBytes = Number(logicalBytesText.trim());
  if (!Number.isSafeInteger(logicalBytes) || logicalBytes < 0) {
    throw new Error("TimescaleDB returned an invalid logical database size");
  }
  await runDirect(options.pgDump, timescaleDumpArguments(destination), environment);
  if (!existsSync(destination) || statSync(destination).size === 0) {
    throw new Error("pg_dump did not produce a non-empty custom-format backup");
  }
  await runDirect(options.pgRestore, ["--list", destination], environment);
  mkdirSync(dirname(validationDestination), { recursive: true });
  writeFileSync(
    validationDestination,
    timescaleOwnershipValidationSql(options.schema, options.applicationRole),
    { encoding: "utf8", flush: true, flag: "wx", mode: 0o600 },
  );
  return {
    status: "included",
    scope: "full-database",
    logicalBytes,
    telemetrySchema: options.schema,
    format: "postgresql-custom",
    catalogVerification: "passed",
    restore: timescaleRestorePlan(options, destination, validationDestination),
  };
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
  if (manifest?.format !== "stuga-backup" || ![1, BACKUP_VERSION].includes(manifest?.version)) {
    throw new Error(`Unsupported backup manifest: ${manifestPath}`);
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
  for (const record of manifest.files ?? []) {
    if (typeof record.path !== "string" || isAbsolute(record.path)) throw new Error("Manifest contains an unsafe file path");
    const artifact = resolve(root, record.path);
    if (!within(root, artifact)) throw new Error("Manifest contains a path outside the backup directory");
    const details = statSync(artifact);
    if (!details.isFile() || details.size !== record.size) throw new Error(`Backup size mismatch: ${record.path}`);
    const checksum = await sha256File(artifact);
    if (checksum !== record.sha256) throw new Error(`Backup checksum mismatch: ${record.path}`);
    totalBytes += details.size;
    if (record.category === "core-sqlite" || record.category === "spatial-sqlite") sqliteInventory(artifact);
    if (record.category === "timescale-pgdump") {
      await runDirect(pgRestore, ["--list", artifact], env);
    }
  }
  return {
    status: "passed",
    verifiedAt: new Date().toISOString(),
    files: manifest.files.length,
    totalBytes,
    manifestPath,
  };
}

export async function createBackup(options) {
  if (existsSync(options.output)) throw new Error(`Refusing to overwrite existing backup output: ${options.output}`);
  if (!existsSync(options.database)) throw new Error(`Core SQLite database does not exist: ${options.database}`);
  hardenPrivateDirectory(options.output);
  const incompletePath = join(options.output, "INCOMPLETE.json");
  writeFileSync(incompletePath, `${JSON.stringify({
    format: "stuga-backup-incomplete",
    startedAt: new Date().toISOString(),
    reason: "Backup creation or verification has not completed",
  }, null, 2)}\n`, { encoding: "utf8", flush: true, mode: 0o600 });
  hardenPrivateFile(incompletePath);

  const manifest = {
    format: "stuga-backup",
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    sensitivity: "confidential-household-authentication-and-telemetry-data",
    includesSecrets: options.includeSecrets,
    files: [],
    sources: {},
    verification: { status: "pending" },
  };

  const databaseDirectory = join(options.output, "databases");
  const coreDestination = join(databaseDirectory, "climate-twin.sqlite");
  const core = await createVerifiedSqliteSnapshot({
    sourcePath: options.database,
    destinationPath: coreDestination,
    hashSource: false,
  });
  manifest.files.push(describedFileRecord(options.output, core.snapshot, "core-sqlite"));
  manifest.sources.coreDatabase = {
    status: "included",
    originalPath: options.database,
    snapshotChecks: core.checks,
    inventory: sqliteInventory(coreDestination, { checkIntegrity: false }),
  };

  if (existsSync(options.spatialDatabase)) {
    const spatialDestination = join(databaseDirectory, "experimental-spatial-layers.sqlite");
    const spatial = await createVerifiedSqliteSnapshot({
      sourcePath: options.spatialDatabase,
      destinationPath: spatialDestination,
      hashSource: false,
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

  const assetResult = await copyAssets(options.assets, join(options.output, "assets"), options.output);
  manifest.files.push(...(assetResult.records ?? []));
  delete assetResult.records;
  manifest.sources.assets = { ...assetResult, originalPath: options.assets };

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

async function main() {
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

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
