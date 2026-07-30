import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  completedObjectKey,
  parseCompletedObjectKey,
  r2BackupConfiguration,
  rcloneEnvironment,
  remotePath,
  stagingObjectKey,
  verifiedBackupDescriptor,
} from "../stugu-r2-backup/configuration.mjs";
import {
  downloadEncryptedObject,
  rcloneArguments,
  uploadVerifiedBackup,
  verifyEncryptedObject,
} from "../stugu-r2-backup/transport.mjs";
import {
  replicateLatest,
  retryDue,
  verifiedBackupDirectories,
} from "../stugu-r2-backup-scheduler.mjs";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-r2-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function configurationFixture(t, overrides = {}) {
  const directory = temporaryDirectory(t);
  const accessKey = join(directory, "access-key-id");
  const secretKey = join(directory, "secret-access-key");
  const recipient = join(directory, "age-recipient");
  writeFileSync(accessKey, "0123456789abcdef0123456789abcdef\n", { mode: 0o600 });
  writeFileSync(secretKey, `${"a".repeat(64)}\n`, { mode: 0o600 });
  writeFileSync(recipient, `age1${"q".repeat(58)}\n`, { mode: 0o600 });
  const environment = {
    STUGU_R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com",
    STUGU_R2_BUCKET: "stugu-backups",
    STUGU_R2_PREFIX: "homes/stugu",
    STUGU_R2_ACCESS_KEY_ID_FILE: accessKey,
    STUGU_R2_SECRET_ACCESS_KEY_FILE: secretKey,
    STUGU_R2_AGE_RECIPIENT_FILE: recipient,
    ...overrides,
  };
  return { directory, environment, config: r2BackupConfiguration(environment) };
}

function backupFixture(t, root, name = "stugu-backup-2026-07-30T10-00-00-000Z") {
  const directory = join(root, name);
  mkdirSync(join(directory, "databases"), { recursive: true });
  writeFileSync(join(directory, "databases", "climate-twin.sqlite"), "sqlite");
  const manifest = {
    format: "stugu-backup",
    version: 2,
    createdAt: "2026-07-30T10:00:00.000Z",
    verification: { status: "passed" },
    files: [{
      path: "databases/climate-twin.sqlite",
      size: 6,
      sha256: createHash("sha256").update("sqlite").digest("hex"),
    }],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(directory, "manifest.json"), manifestText);
  const checksum = createHash("sha256").update(manifestText).digest("hex");
  writeFileSync(join(directory, "manifest.sha256"), `${checksum}  manifest.json\n`);
  return directory;
}

test("R2 configuration accepts only account-scoped Cloudflare HTTPS endpoints", (t) => {
  const fixture = configurationFixture(t);
  assert.equal(fixture.config.bucket, "stugu-backups");
  assert.equal(fixture.config.prefix, "homes/stugu");
  assert.throws(
    () => r2BackupConfiguration({ ...fixture.environment, STUGU_R2_ENDPOINT: "https://example.com" }),
    /account-scoped Cloudflare R2 HTTPS endpoint/u,
  );
  assert.throws(
    () => r2BackupConfiguration({ ...fixture.environment, STUGU_R2_PREFIX: "../other" }),
    /unsafe path segment/u,
  );
  assert.throws(
    () => r2BackupConfiguration({ ...fixture.environment, STUGU_R2_BUCKET: "Bad_Bucket" }),
    /valid R2 bucket name/u,
  );
});

test("rclone receives bucket credentials through its environment, not arguments", (t) => {
  const fixture = configurationFixture(t);
  const child = rcloneEnvironment(fixture.config, { PATH: "test-path" });
  assert.equal(child.PATH, "test-path");
  assert.equal(child.RCLONE_CONFIG_STUGUOFFSITE_PROVIDER, "Cloudflare");
  assert.equal(child.RCLONE_CONFIG_STUGUOFFSITE_ACCESS_KEY_ID, "0123456789abcdef0123456789abcdef");
  assert.equal(child.RCLONE_CONFIG_STUGUOFFSITE_SECRET_ACCESS_KEY, "a".repeat(64));
  const args = rcloneArguments("rcat", remotePath(fixture.config, "homes/stugu/staging/test"));
  assert.equal(args.join(" ").includes("0123456789abcdef"), false);
  assert.equal(args.includes("--s3-chunk-size"), true);
});

test("Compose isolates R2 egress from live databases and the decryption identity", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const service = compose.match(
    /^  stugu-r2-backup:\r?\n(?<body>[\s\S]*?)(?=^  web:)/mu,
  )?.groups?.body ?? "";
  const initializer = compose.match(
    /^  r2-backup-operations-init:\r?\n(?<body>[\s\S]*?)(?=^  update-operations-init:)/mu,
  )?.groups?.body ?? "";
  assert.match(service, /stuga-scheduled-backups:\/app\/backups:ro/u);
  assert.match(service, /stuga-r2-backup-operations:\/app\/runtime\/r2-backup-operations/u);
  assert.match(service, /- backup-egress/u);
  assert.match(service, /cap_drop:\r?\n\s+- ALL/u);
  assert.doesNotMatch(service, /climate-twin-data|stuga-timeseries|age-identity|- backend/u);
  assert.match(initializer, /chown -R \$\{STUGA_HOST_BIND_USER:-1000:1000\}/u);
});

test("verified backup descriptors include only checksummed manifest artifacts", (t) => {
  const root = temporaryDirectory(t);
  const backup = backupFixture(t, root);
  writeFileSync(join(backup, "unlisted-secret.txt"), "do not upload");
  const descriptor = verifiedBackupDescriptor(backup);
  assert.deepEqual(descriptor.archiveEntries, [
    descriptor.name,
    `${descriptor.name}/databases`,
    `${descriptor.name}/databases/climate-twin.sqlite`,
    `${descriptor.name}/manifest.json`,
    `${descriptor.name}/manifest.sha256`,
  ]);
  const manifestPath = join(backup, "manifest.json");
  writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("\"passed\"", "\"pending\""));
  assert.throws(() => verifiedBackupDescriptor(backup), /completed, verified/u);
});

test("completed R2 keys bind backup names to ciphertext hashes", (t) => {
  const { config } = configurationFixture(t);
  const name = "stugu-backup-2026-07-30T10-00-00-000Z";
  const checksum = "b".repeat(64);
  const objectKey = completedObjectKey(config, name, checksum);
  assert.deepEqual(parseCompletedObjectKey(config, objectKey), { backupName: name, sha256: checksum });
  assert.match(stagingObjectKey(config, name, "12345678-1234-1234-1234-123456789abc"), /\/staging\//u);
  assert.throws(
    () => parseCompletedObjectKey(config, `other/sets/${name}.${checksum}.tar.zst.age`),
    /outside the configured/u,
  );
});

test("upload promotes an encrypted staging object only after size verification", async (t) => {
  const fixture = configurationFixture(t);
  const backup = backupFixture(t, temporaryDirectory(t));
  const calls = [];
  let verified = false;
  const result = await uploadVerifiedBackup(backup, fixture.config, fixture.environment, {
    randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    verifyBackup: async (path) => {
      assert.equal(path, backup);
      verified = true;
    },
    streamEncryptedArchive: async (_config, descriptor, stagingKey) => {
      assert.equal(verified, true);
      assert.equal(descriptor.name, "stugu-backup-2026-07-30T10-00-00-000Z");
      assert.match(stagingKey, /\/staging\//u);
      return { sha256: "c".repeat(64), bytes: 1234 };
    },
    runRclone: async (_config, args) => {
      calls.push(args);
      if (args[0] === "lsjson") return JSON.stringify({ IsDir: false, Size: 1234 });
      return "";
    },
  });
  assert.equal(result.bytes, 1234);
  assert.match(result.objectKey, /\.c{64}\.tar\.zst\.age$/u);
  assert.deepEqual(calls.map((args) => args[0]), ["copyto", "lsjson", "deletefile"]);
  assert.equal(calls[0].includes("--immutable"), true);
});

test("upload cleans its unlocked staging key after promotion failure", async (t) => {
  const fixture = configurationFixture(t);
  const backup = backupFixture(t, temporaryDirectory(t));
  const commands = [];
  await assert.rejects(
    uploadVerifiedBackup(backup, fixture.config, fixture.environment, {
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
      verifyBackup: async () => {},
      streamEncryptedArchive: async () => ({ sha256: "d".repeat(64), bytes: 10 }),
      runRclone: async (_config, args) => {
        commands.push(args[0]);
        if (args[0] === "copyto") throw new Error("copy failed");
        return "";
      },
    }),
    /copy failed/u,
  );
  assert.deepEqual(commands, ["copyto", "deletefile"]);
});

test("R2 scheduler selects only the latest verified local recovery set", (t) => {
  const root = temporaryDirectory(t);
  backupFixture(t, root, "stugu-backup-2026-07-29T10-00-00-000Z");
  const latest = backupFixture(t, root, "stugu-backup-2026-07-30T10-00-00-000Z");
  const pending = backupFixture(t, root, "stugu-backup-2026-07-31T10-00-00-000Z");
  const pendingManifest = join(pending, "manifest.json");
  writeFileSync(pendingManifest, readFileSync(pendingManifest, "utf8").replace("\"passed\"", "\"pending\""));
  assert.equal(verifiedBackupDirectories(root)[0].path, latest);
});

test("R2 scheduler is idempotent and backs off a failed latest set", async (t) => {
  const fixture = configurationFixture(t);
  const backupRoot = temporaryDirectory(t);
  const operationsDirectory = temporaryDirectory(t);
  const latest = backupFixture(t, backupRoot);
  const dependencies = {
    findCompletedBackup: async () => null,
    uploadVerifiedBackup: async (path) => {
      assert.equal(path, latest);
      return {
        objectKey: `${fixture.config.prefix}/sets/result.tar.zst.age`,
        sha256: "e".repeat(64),
        bytes: 55,
        uploadedAt: "2026-07-30T10:01:00.000Z",
      };
    },
  };
  const complete = await replicateLatest({
    backupRoot,
    operationsDirectory,
    config: fixture.config,
    now: new Date("2026-07-30T10:01:00.000Z"),
    dependencies,
  });
  assert.equal(complete.state, "complete");
  assert.equal(complete.latestUploadedBackupName, "stugu-backup-2026-07-30T10-00-00-000Z");

  dependencies.uploadVerifiedBackup = async () => { throw new Error("must not repeat"); };
  const repeated = await replicateLatest({
    backupRoot,
    operationsDirectory,
    config: fixture.config,
    now: new Date("2026-07-30T10:02:00.000Z"),
    dependencies,
  });
  assert.equal(repeated.state, "complete");
  assert.equal(retryDue({
    state: "failed",
    latestBackupName: complete.latestUploadedBackupName,
    checkedAt: "2026-07-30T10:00:00.000Z",
  }, complete.latestUploadedBackupName, new Date("2026-07-30T10:14:59.000Z"), 15), false);
});

test("container smoke: real tar, zstd, and age pipeline round-trips", {
  skip: process.env.STUGU_R2_CONTAINER_SMOKE !== "true",
}, async (t) => {
  const fixture = configurationFixture(t);
  const backup = backupFixture(t, temporaryDirectory(t));
  const identity = join(fixture.directory, "age-identity");
  execFileSync("age-keygen", ["-o", identity], { stdio: ["ignore", "ignore", "pipe"] });
  const recipient = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" });
  writeFileSync(fixture.config.recipientFile, recipient);

  const fakeBin = join(fixture.directory, "bin");
  const fakeStorage = join(fixture.directory, "object-storage");
  mkdirSync(fakeBin);
  mkdirSync(fakeStorage);
  const fakeRclone = join(fakeBin, "rclone");
  writeFileSync(fakeRclone, `#!/usr/bin/env node
import { copyFileSync, createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
const [command, ...args] = process.argv.slice(2);
const local = (remote) => join(process.env.FAKE_RCLONE_ROOT, ...remote.slice(remote.indexOf(":") + 1).split("/"));
if (command === "rcat") {
  const output = local(args[0]); mkdirSync(dirname(output), { recursive: true });
  await pipeline(process.stdin, createWriteStream(output));
} else if (command === "copyto") {
  const output = local(args[1]); mkdirSync(dirname(output), { recursive: true }); copyFileSync(local(args[0]), output);
} else if (command === "lsjson" && args.includes("--stat")) {
  const details = statSync(local(args[0])); process.stdout.write(JSON.stringify({ IsDir: false, Size: details.size }));
} else if (command === "lsjson") {
  const directory = local(args[0]);
  const entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const details = statSync(join(directory, entry.name));
    return { Path: entry.name, Size: details.size, ModTime: details.mtime.toISOString() };
  });
  process.stdout.write(JSON.stringify(entries));
} else if (command === "deletefile") {
  rmSync(local(args[0]), { force: true });
} else if (command === "cat") {
  await pipeline(createReadStream(local(args[0])), process.stdout);
} else {
  throw new Error(\`Unsupported fake rclone command: \${command}\`);
}
`);
  chmodSync(fakeRclone, 0o700);
  const environment = {
    ...fixture.environment,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_RCLONE_ROOT: fakeStorage,
  };
  const config = r2BackupConfiguration(environment);
  const uploaded = await uploadVerifiedBackup(backup, config, environment, {
    verifyBackup: async () => {},
  });
  assert.equal(uploaded.bytes > 0, true);
  const verified = await verifyEncryptedObject(config, uploaded.objectKey, environment);
  assert.equal(verified.sha256, uploaded.sha256);

  const download = join(fixture.directory, "recovery.tar.zst.age");
  await downloadEncryptedObject(config, uploaded.objectKey, download, environment);
  const decrypted = execFileSync("age", ["--decrypt", "--identity", identity, download]);
  const listing = execFileSync("tar", ["--list", "--zstd", "--file=-"], {
    input: decrypted,
    encoding: "utf8",
  });
  assert.match(listing, /databases\/climate-twin\.sqlite/u);
  assert.match(listing, /manifest\.sha256/u);
});
