import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, posix, resolve } from "node:path";

const BACKUP_NAME = /^stugu-backup-\d{4}-\d{2}-\d{2}T[0-9A-Za-z-]+$/u;
const BUCKET_NAME = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const CLOUDFLARE_R2_HOST = /^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/u;
const CIPHERTEXT_NAME = /^(stugu-backup-\d{4}-\d{2}-\d{2}T[0-9A-Za-z-]+)\.([a-f0-9]{64})\.tar\.zst\.age$/u;

function required(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function safePrefix(value) {
  const prefix = String(value ?? "stugu").trim().replace(/^\/+|\/+$/gu, "");
  if (!prefix || prefix.length > 256 || prefix.includes("\\") || prefix.includes("\0")) {
    throw new Error("STUGU_R2_PREFIX must be a non-empty portable object prefix");
  }
  const segments = prefix.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("STUGU_R2_PREFIX contains an unsafe path segment");
  }
  return prefix;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || posix.isAbsolute(value)) {
    throw new Error(`${label} must be a portable relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")
    || posix.normalize(value) !== value) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  return value;
}

function regularFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is not a regular file: ${path}`);
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  return path;
}

function backupArtifact(root, relative) {
  const parts = relative.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    if (!existsSync(current)) throw new Error(`Backup artifact is missing: ${relative}`);
    const details = lstatSync(current);
    if (details.isSymbolicLink()) throw new Error(`Backup artifact path contains a symbolic link: ${relative}`);
    if (index === parts.length - 1 ? !details.isFile() : !details.isDirectory()) {
      throw new Error(`Backup artifact has an unexpected file type: ${relative}`);
    }
  }
  return current;
}

function credential(path, label) {
  const value = readFileSync(regularFile(path, label), "utf8").trim();
  if (!value || value.length > 8_192 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must contain exactly one non-empty line`);
  }
  return value;
}

function validateRecipientFile(path) {
  const lines = readFileSync(regularFile(path, "age recipient file"), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0 || lines.some((line) => !/^age1[023456789acdefghjklmnpqrstuvwxyz]{20,}$/u.test(line))) {
    throw new Error("The age recipient file must contain at least one age public recipient");
  }
}

export function r2BackupConfiguration(environment = process.env, { recipientRequired = true } = {}) {
  const endpointText = required(environment.STUGU_R2_ENDPOINT, "STUGU_R2_ENDPOINT");
  let endpoint;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new Error("STUGU_R2_ENDPOINT must be a valid Cloudflare R2 HTTPS endpoint");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port
    || endpoint.pathname !== "/" || endpoint.search || endpoint.hash
    || !CLOUDFLARE_R2_HOST.test(endpoint.hostname)) {
    throw new Error("STUGU_R2_ENDPOINT must be an account-scoped Cloudflare R2 HTTPS endpoint");
  }
  const bucket = required(environment.STUGU_R2_BUCKET, "STUGU_R2_BUCKET");
  if (!BUCKET_NAME.test(bucket)) throw new Error("STUGU_R2_BUCKET is not a valid R2 bucket name");
  const accessKeyIdFile = resolve(environment.STUGU_R2_ACCESS_KEY_ID_FILE ?? "/run/secrets/r2/access-key-id");
  const secretAccessKeyFile = resolve(environment.STUGU_R2_SECRET_ACCESS_KEY_FILE ?? "/run/secrets/r2/secret-access-key");
  const recipientFile = resolve(environment.STUGU_R2_AGE_RECIPIENT_FILE ?? "/run/secrets/r2/age-recipient");
  regularFile(accessKeyIdFile, "R2 access key id file");
  regularFile(secretAccessKeyFile, "R2 secret access key file");
  if (recipientRequired) validateRecipientFile(recipientFile);
  return Object.freeze({
    endpoint: endpoint.href.replace(/\/$/u, ""),
    bucket,
    prefix: safePrefix(environment.STUGU_R2_PREFIX),
    accessKeyIdFile,
    secretAccessKeyFile,
    recipientFile,
  });
}

export function rcloneEnvironment(config, environment = process.env) {
  const child = { ...environment };
  for (const key of Object.keys(child)) {
    if (key.startsWith("RCLONE_CONFIG_STUGUOFFSITE_")) delete child[key];
  }
  return {
    ...child,
    RCLONE_CONFIG_STUGUOFFSITE_TYPE: "s3",
    RCLONE_CONFIG_STUGUOFFSITE_PROVIDER: "Cloudflare",
    RCLONE_CONFIG_STUGUOFFSITE_ACCESS_KEY_ID: credential(config.accessKeyIdFile, "R2 access key id file"),
    RCLONE_CONFIG_STUGUOFFSITE_SECRET_ACCESS_KEY: credential(config.secretAccessKeyFile, "R2 secret access key file"),
    RCLONE_CONFIG_STUGUOFFSITE_ENDPOINT: config.endpoint,
    RCLONE_CONFIG_STUGUOFFSITE_REGION: "auto",
    RCLONE_CONFIG_STUGUOFFSITE_ACL: "private",
    RCLONE_CONFIG_STUGUOFFSITE_NO_CHECK_BUCKET: "true",
  };
}

export function verifiedBackupDescriptor(path) {
  const directory = resolve(path);
  const name = basename(directory);
  if (!BACKUP_NAME.test(name)) throw new Error(`Unsafe Stugu backup directory name: ${name}`);
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
    throw new Error(`Stugu backup path is not a real directory: ${directory}`);
  }
  const manifestPath = regularFile(resolve(directory, "manifest.json"), "Backup manifest");
  const checksumPath = regularFile(resolve(directory, "manifest.sha256"), "Backup manifest checksum");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`Cannot read backup manifest: ${manifestPath}`);
  }
  if (manifest?.format !== "stugu-backup" || manifest?.verification?.status !== "passed"
    || !Array.isArray(manifest.files)) {
    throw new Error("R2 replication requires a completed, verified Stugu backup");
  }
  const manifestHash = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  const expectedHash = readFileSync(checksumPath, "utf8").trim().split(/\s+/u)[0];
  if (manifestHash !== expectedHash) throw new Error("Backup manifest checksum mismatch");
  const entries = new Set(["manifest.json", "manifest.sha256"]);
  for (const file of manifest.files) {
    const relative = safeRelativePath(file?.path, "Backup manifest file path");
    if (entries.has(relative)) throw new Error(`Backup manifest contains a duplicate path: ${relative}`);
    if (!Number.isSafeInteger(file?.size) || file.size < 0 || !/^[a-f0-9]{64}$/u.test(file?.sha256)) {
      throw new Error(`Backup manifest contains an invalid file record: ${relative}`);
    }
    const artifact = backupArtifact(directory, relative);
    if (lstatSync(artifact).size !== file.size) throw new Error(`Backup artifact size mismatch: ${relative}`);
    entries.add(relative);
  }
  const archiveEntries = new Set([name]);
  for (const entry of [...entries].sort()) {
    const parts = entry.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      archiveEntries.add(`${name}/${parts.slice(0, index).join("/")}`);
    }
    archiveEntries.add(`${name}/${entry}`);
  }
  return Object.freeze({
    directory,
    root: dirname(directory),
    name,
    archiveEntries: [...archiveEntries].sort(),
  });
}

export function stagingObjectKey(config, backupName, nonce) {
  if (!BACKUP_NAME.test(backupName) || !/^[a-f0-9-]{20,}$/u.test(nonce)) throw new Error("Unsafe R2 staging key");
  return `${config.prefix}/staging/${backupName}.${nonce}.tar.zst.age.partial`;
}

export function completedObjectKey(config, backupName, checksum) {
  if (!BACKUP_NAME.test(backupName) || !/^[a-f0-9]{64}$/u.test(checksum)) {
    throw new Error("Unsafe completed R2 object key");
  }
  return `${config.prefix}/sets/${backupName}.${checksum}.tar.zst.age`;
}

export function parseCompletedObjectKey(config, objectKey) {
  const prefix = `${config.prefix}/sets/`;
  if (typeof objectKey !== "string" || !objectKey.startsWith(prefix)) {
    throw new Error("R2 object key is outside the configured completed-set prefix");
  }
  const match = CIPHERTEXT_NAME.exec(objectKey.slice(prefix.length));
  if (!match) throw new Error("R2 object key is not a Stugu encrypted recovery set");
  return { backupName: match[1], sha256: match[2] };
}

export function remotePath(config, objectKey) {
  safeRelativePath(objectKey, "R2 object key");
  return `stuguoffsite:${config.bucket}/${objectKey}`;
}
