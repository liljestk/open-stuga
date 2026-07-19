import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

let cachedWindowsSid;

function normalizedPath(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

function sqliteString(value) {
  if (value.includes("\0")) throw new Error("SQLite paths cannot contain a NUL byte");
  return `'${value.replaceAll("'", "''")}'`;
}

function currentWindowsSid() {
  if (cachedWindowsSid !== undefined) return cachedWindowsSid;
  const result = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  const sid = /S-\d-(?:\d+-)+\d+/u.exec(result.stdout ?? "")?.[0];
  if (result.status !== 0 || !sid) {
    throw new Error(
      "Could not identify the Windows account for a private ACL; use a protected, encrypted destination",
    );
  }
  cachedWindowsSid = sid;
  return sid;
}

function tightenWindowsAcl(path, directory) {
  const permission = directory ? "(OI)(CI)(F)" : "(F)";
  const result = spawnSync("icacls.exe", [
    resolve(path),
    "/inheritance:r",
    "/grant:r",
    `*${currentWindowsSid()}:${permission}`,
  ], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `Could not apply a private Windows ACL to ${resolve(path)}; use a protected, encrypted destination`,
    );
  }
}

export function hardenPrivateFile(path) {
  const absolute = resolve(path);
  try {
    chmodSync(absolute, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  if (process.platform === "win32") tightenWindowsAcl(absolute, false);
  return absolute;
}

export function hardenPrivateDirectory(path) {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  try {
    chmodSync(absolute, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  if (process.platform === "win32") tightenWindowsAcl(absolute, true);
  return absolute;
}

export function quoteSqliteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function openReadOnlySqlite(path) {
  const absolute = resolve(path);
  const details = statSync(absolute);
  if (!details.isFile()) throw new Error(`SQLite source is not a regular file: ${absolute}`);
  const database = new DatabaseSync(absolute, { readOnly: true });
  database.exec("PRAGMA busy_timeout = 10000");
  return database;
}

export function assertSqliteCheck(database, pragma = "quick_check") {
  if (pragma !== "quick_check" && pragma !== "integrity_check") {
    throw new Error(`Unsupported SQLite check: ${pragma}`);
  }
  const rows = database.prepare(`PRAGMA ${pragma}`).all();
  const failures = rows
    .flatMap((row) => Object.values(row))
    .filter((value) => value !== "ok")
    .map(String);
  if (failures.length > 0) {
    const summary = failures.slice(0, 5).join("; ");
    throw new Error(`SQLite ${pragma} failed${summary ? `: ${summary}` : ""}`);
  }
  return { pragma, status: "ok", resultRows: rows.length };
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((accept, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", accept);
  });
  return hash.digest("hex");
}

export async function describeFile(path, { hash = true } = {}) {
  const absolute = resolve(path);
  const details = statSync(absolute);
  return {
    path: absolute,
    size: details.size,
    mtime: details.mtime.toISOString(),
    ...(hash ? { sha256: await sha256File(absolute) } : {}),
  };
}

export async function createVerifiedSqliteSnapshot({
  sourcePath,
  destinationPath,
  fullSourceCheck = false,
  hashSource = true,
}) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (normalizedPath(source) === normalizedPath(destination)) {
    throw new Error("The SQLite snapshot destination must differ from its source");
  }
  if (existsSync(destination)) {
    throw new Error(`Refusing to overwrite an existing snapshot: ${destination}`);
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });

  let sourceDatabase;
  try {
    sourceDatabase = openReadOnlySqlite(source);
    const sourceQuickCheck = assertSqliteCheck(sourceDatabase, "quick_check");
    const sourceIntegrityCheck = fullSourceCheck
      ? assertSqliteCheck(sourceDatabase, "integrity_check")
      : undefined;

    // VACUUM INTO reads one consistent SQLite transaction, including committed WAL
    // pages, while never writing to the source database or its sidecar files.
    sourceDatabase.exec(`VACUUM INTO ${sqliteString(destination)}`);
    sourceDatabase.close();
    sourceDatabase = undefined;
    hardenPrivateFile(destination);

    const descriptor = openSync(destination, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    const snapshotDatabase = openReadOnlySqlite(destination);
    let snapshotIntegrityCheck;
    try {
      snapshotIntegrityCheck = assertSqliteCheck(snapshotDatabase, "integrity_check");
    } finally {
      snapshotDatabase.close();
    }

    return {
      source: await describeFile(source, { hash: hashSource }),
      snapshot: await describeFile(destination),
      checks: {
        sourceQuickCheck,
        ...(sourceIntegrityCheck === undefined ? {} : { sourceIntegrityCheck }),
        snapshotIntegrityCheck,
      },
    };
  } catch (error) {
    try {
      sourceDatabase?.close();
    } catch {
      // Preserve the original failure.
    }
    // The destination did not exist before this call, so removing an incomplete
    // file cannot destroy user data and makes an interrupted snapshot retryable.
    if (existsSync(destination)) {
      try {
        unlinkSync(destination);
      } catch {
        // Leave the partial artifact in place if the OS still has it locked.
      }
    }
    throw error;
  }
}

export function listSqliteTables(database) {
  return database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(({ name }) => String(name));
}

export function inventorySqliteTables(database) {
  return listSqliteTables(database).map((name) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(name)}`).get();
    return { name, rows: Number(row.count) };
  });
}
