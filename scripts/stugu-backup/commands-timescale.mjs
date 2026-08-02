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
  statfsSync,
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

import {
  DEFAULT_BACKUP_MIN_FREE_BYTES,
  portable,
  postgresLiteral,
  redact,
} from "./configuration-files.mjs";

export function runDirect(executable, arguments_, environment) {
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

export function runCapture(executable, arguments_, environment) {
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

export function postgresEnvironment(options, env = process.env) {
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

export function backupCapacity(
  availableBytes,
  logicalBytes,
  minimumFreeBytes = DEFAULT_BACKUP_MIN_FREE_BYTES,
) {
  const available = BigInt(availableBytes);
  const database = BigInt(logicalBytes);
  const reserve = BigInt(minimumFreeBytes);
  const required = database + reserve;
  return {
    availableBytes: available.toString(),
    requiredBytes: required.toString(),
    minimumFreeBytes: reserve.toString(),
    sufficient: available >= required,
  };
}

export function assertBackupCapacity(
  destination,
  logicalBytes,
  minimumFreeBytes = DEFAULT_BACKUP_MIN_FREE_BYTES,
) {
  const filesystem = statfsSync(dirname(destination), { bigint: true });
  const capacity = backupCapacity(
    filesystem.bavail * filesystem.bsize,
    logicalBytes,
    minimumFreeBytes,
  );
  if (!capacity.sufficient) {
    throw new Error(
      `Backup destination has ${capacity.availableBytes} bytes available; `
      + `${capacity.requiredBytes} bytes are required for the database dump and safety reserve`,
    );
  }
  return capacity;
}

export function timescaleOwnershipValidationSql(schema, applicationRole) {
  const schemaLiteral = postgresLiteral(schema);
  const roleLiteral = postgresLiteral(applicationRole);
  return `-- Run as the restore administrator after timescaledb_post_restore(). This is
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

export async function createTimescaleDump(options, destination, validationDestination) {
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
  const capacity = assertBackupCapacity(
    destination,
    logicalBytes,
    options.backupMinFreeBytes,
  );
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
    capacityPreflight: capacity,
    telemetrySchema: options.schema,
    format: "postgresql-custom",
    catalogVerification: "passed",
    restore: timescaleRestorePlan(options, destination, validationDestination),
  };
}
