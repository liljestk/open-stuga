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
} from ".././sqlite-snapshot-utils.mjs";

export const BACKUP_VERSION = 2;

export const DEFAULT_SCHEMA = "telemetry";

export const DEFAULT_APPLICATION_ROLE = "stuga_app";

export const DEFAULT_ADMIN_ROLE = "stuga_admin";

export function timestampForPath(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

export function help() {
  return `Verified Stugu backup

Usage:
  node scripts/stugu-backup.mjs [options]
  node scripts/stugu-backup.mjs --verify <backup-directory-or-manifest>

Create options:
  --database <file>        Core SQLite DB (default: DATABASE_PATH or ./data/climate-twin.sqlite)
  --output <directory>     New backup directory (default: ./backups/stugu-backup-<UTC timestamp>)
  --assets <directory>     External assets directory (default: ASSET_DIRECTORY or ./data/assets)
  --spatial-db <file>      Spatial SQLite DB (default: SPATIAL_LAYERS_DATABASE_PATH or next to core DB)
  --stuguby-identity <file> Persistent Stuguby node identity (default: STUGBY_IDENTITY_FILE or next to core DB)
  --tracking-secret-key <file> Key required to restore encrypted tracking endpoint identities
  --include-secrets        Opt in to copying the integration secrets file
  --include-secrets-if-present Include the integration secrets file when it exists
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
  node scripts/stugu-backup.mjs --database ./data/climate-twin.sqlite
  node scripts/stugu-backup.mjs --include-timescale
  node scripts/stugu-backup.mjs --include-secrets --secrets-file ./data/integration-secrets.json
  node scripts/stugu-backup.mjs --verify ./backups/stugu-backup-2026-07-18T12-00-00-000Z
`;
}

export function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function validatedPort(value, label, fallback) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} must be an integer from 1 to 65535`);
  return String(port);
}

export function timeseriesPasswordFromEnvironment(env) {
  if (env.TIMESERIES_PASSWORD !== undefined && env.TIMESERIES_PASSWORD_FILE) {
    throw new Error("Configure only one of TIMESERIES_PASSWORD or TIMESERIES_PASSWORD_FILE");
  }
  if (!env.TIMESERIES_PASSWORD_FILE) return env.TIMESERIES_PASSWORD ?? "";
  const password = readFileSync(resolve(env.TIMESERIES_PASSWORD_FILE), "utf8").trim();
  if (!password) throw new Error("TIMESERIES_PASSWORD_FILE must not be empty");
  return password;
}

export function parseBackupArgs(argv, env = process.env, now = new Date()) {
  const parsed = {
    help: false,
    includeSecrets: false,
    includeSecretsIfPresent: false,
    includeTimescale: false,
    quiescedSqlite: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") parsed.help = true;
    else if (argument === "--include-secrets") parsed.includeSecrets = true;
    else if (argument === "--include-secrets-if-present") parsed.includeSecretsIfPresent = true;
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
    } else if (argument === "--stuguby-identity") {
      parsed.stugubyIdentityFile = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--tracking-secret-key") {
      parsed.trackingSecretKeyFile = argumentValue(argv, index, argument);
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
  if (parsed.includeSecrets && parsed.includeSecretsIfPresent) {
    throw new Error("Configure only one of --include-secrets or --include-secrets-if-present");
  }
  if (parsed.verify !== undefined) {
    const incompatible = parsed.includeSecrets || parsed.includeSecretsIfPresent || parsed.includeTimescale
      || parsed.database !== undefined || parsed.output !== undefined || parsed.assets !== undefined
      || parsed.spatialDatabase !== undefined || parsed.stugubyIdentityFile !== undefined || parsed.secretsFile !== undefined
      || parsed.trackingSecretKeyFile !== undefined
      || parsed.applicationRole !== undefined || parsed.adminRole !== undefined;
    if (incompatible) throw new Error("--verify cannot be combined with backup creation options");
    parsed.verify = resolve(parsed.verify);
    return parsed;
  }

  if (env.STUGU_BACKUP_QUIESCED_SQLITE !== undefined) {
    if (env.STUGU_BACKUP_QUIESCED_SQLITE !== "true") {
      throw new Error("STUGU_BACKUP_QUIESCED_SQLITE must be exactly 'true' when enabled");
    }
    parsed.quiescedSqlite = true;
  }

  const databaseValue = parsed.database ?? env.DATABASE_PATH ?? "./data/climate-twin.sqlite";
  if (databaseValue === ":memory:") throw new Error("An in-memory database cannot be backed up");
  parsed.database = resolve(databaseValue);
  parsed.output = resolve(parsed.output ?? join("./backups", `stugu-backup-${timestampForPath(now)}`));
  parsed.assets = resolve(parsed.assets ?? env.ASSET_DIRECTORY ?? "./data/assets");
  parsed.spatialDatabase = resolve(
    parsed.spatialDatabase
      ?? env.SPATIAL_LAYERS_DATABASE_PATH
      ?? join(dirname(parsed.database), "experimental-spatial-layers.sqlite"),
  );
  parsed.stugubyIdentityFile = resolve(
    parsed.stugubyIdentityFile
      ?? env.STUGBY_IDENTITY_FILE
      ?? join(dirname(parsed.database), "stuguby-identity.json"),
  );
  parsed.trackingSecretKeyFile = resolve(
    parsed.trackingSecretKeyFile
      ?? env.TRACKING_SECRET_KEY_FILE
      ?? join(dirname(parsed.database), "tracking-secret.key"),
  );
  parsed.secretsFile = resolve(
    parsed.secretsFile
      ?? env.INTEGRATION_SECRETS_FILE
      ?? join(dirname(parsed.database), "integration-secrets.json"),
  );
  if (parsed.includeSecretsIfPresent) parsed.includeSecrets = existsSync(parsed.secretsFile);
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

export function within(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

export function portable(path) {
  return path.split(sep).join("/");
}

export function postgresLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function fileRecord(root, path, category) {
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

export function describedFileRecord(root, description, category) {
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

export function sqliteInventory(path, { checkIntegrity = true } = {}) {
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

export function sqliteTableRowCount(path, table) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(table)) throw new Error("Unsafe SQLite table name");
  const database = openReadOnlySqlite(path);
  try {
    const exists = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    if (!exists) return 0;
    return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  } finally {
    database.close();
  }
}

export function walkAssets(root) {
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

export async function copyAssets(source, destination, backupRoot) {
  if (!existsSync(source)) return { status: "missing", files: 0, bytes: 0 };
  if (!statSync(source).isDirectory()) throw new Error(`Assets path is not a directory: ${source}`);
  if (within(source, backupRoot)) throw new Error("The backup output cannot be inside the assets directory");
  const files = walkAssets(source);
  let bytes = 0;
  for (const sourceFile of files) {
    const relativePath = relative(source, sourceFile);
    const destinationFile = join(destination, relativePath);
    mkdirSync(dirname(destinationFile), { recursive: true });
    copyFileSync(sourceFile, destinationFile);
    bytes += statSync(destinationFile).size;
  }
  return { status: "included", files: files.length, bytes };
}

export function requiredStugubyBlobs(snapshotPath) {
  const database = openReadOnlySqlite(snapshotPath);
  try {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map(({ name }) => String(name)));
    const dependentTables = ["stugby_blob_references", "stugby_blob_access"].filter((table) => tables.has(table));
    if (!tables.has("stugby_blob_metadata")) {
      if (dependentTables.length > 0) throw new Error("Core snapshot has Stuguby blob references but no blob metadata table");
      return [];
    }
    for (const table of dependentTables) {
      const missing = database.prepare(`SELECT DISTINCT dependency.digest FROM ${table} dependency
        LEFT JOIN stugby_blob_metadata metadata ON metadata.digest=dependency.digest
        WHERE metadata.digest IS NULL LIMIT 1`).get();
      if (missing) throw new Error(`Core snapshot has ${table} entry without Stuguby blob metadata: ${missing.digest}`);
    }
    return database.prepare(`SELECT digest,byte_length AS byteLength,relative_path AS relativePath
      FROM stugby_blob_metadata ORDER BY digest`).all().map((row) => {
      const digest = String(row.digest);
      const relativePath = String(row.relativePath);
      const byteLength = Number(row.byteLength);
      if (!/^[a-f0-9]{64}$/u.test(digest) || relativePath !== digest
        || !Number.isSafeInteger(byteLength) || byteLength < 1) {
        throw new Error(`Core snapshot has invalid Stuguby blob metadata: ${digest}`);
      }
      return { digest, byteLength, relativePath };
    });
  } finally {
    database.close();
  }
}

export async function matchesStugubyBlob(path, blob) {
  if (!existsSync(path)) return false;
  const details = lstatSync(path);
  return details.isFile() && !details.isSymbolicLink()
    && details.size === blob.byteLength && await sha256File(path) === blob.digest;
}

export async function ensureSnapshotStugubyAssets(snapshotPath, sourceRoot, destinationRoot) {
  const blobs = requiredStugubyBlobs(snapshotPath);
  for (const blob of blobs) {
    const destination = join(destinationRoot, "stuguby", blob.relativePath);
    if (await matchesStugubyBlob(destination, blob)) continue;
    const source = join(sourceRoot, "stuguby", blob.relativePath);
    let copied = false;
    for (let attempt = 0; attempt < 3 && !copied; attempt += 1) {
      if (!existsSync(source)) continue;
      const details = lstatSync(source);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error(`Stuguby asset required by the core snapshot is not a regular file: ${source}`);
      }
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      copied = await matchesStugubyBlob(destination, blob);
    }
    if (!copied) {
      throw new Error(
        `Stuguby asset required by the core snapshot could not be copied with its recorded checksum: ${blob.digest}`,
      );
    }
  }
  return blobs.length;
}

export async function assetRecords(destination, backupRoot) {
  if (!existsSync(destination)) return [];
  const records = [];
  for (const path of walkAssets(destination)) records.push(await fileRecord(backupRoot, path, "asset"));
  return records;
}

export function verifySnapshotStugubyAssetInventory(snapshotPath, files) {
  const records = new Map(files.map((record) => [record.path, record]));
  for (const blob of requiredStugubyBlobs(snapshotPath)) {
    const path = `assets/stuguby/${blob.relativePath}`;
    const record = records.get(path);
    if (!record || record.category !== "asset"
      || record.size !== blob.byteLength || record.sha256 !== blob.digest) {
      throw new Error(`Backup is missing the checksummed Stuguby asset required by its core snapshot: ${blob.digest}`);
    }
  }
}

export function redact(text, environment) {
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
