import { randomUUID, createHash } from "node:crypto";
import { createWriteStream, existsSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyBackup } from "../stugu-backup/operations.mjs";
import {
  completedObjectKey,
  parseCompletedObjectKey,
  rcloneEnvironment,
  remotePath,
  stagingObjectKey,
  verifiedBackupDescriptor,
} from "./configuration.mjs";

const RCLONE_BASE = [
  "--config", process.platform === "win32" ? "NUL" : "/dev/null",
  "--s3-no-check-bucket",
  "--retries", "5",
  "--low-level-retries", "10",
  "--contimeout", "15s",
  "--timeout", "5m",
  "--stats", "0",
  "--log-level", "ERROR",
];

function capturedChild(command, args, environment, { input = "ignore", output = "pipe" } = {}) {
  const child = spawn(command, args, {
    env: environment,
    stdio: [input, output, "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 8_000) stderr += chunk.toString();
  });
  const completion = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        stderr.trim().slice(0, 2_000) || `${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`,
      ));
    });
  });
  return { child, completion, stderr: () => stderr };
}

function stop(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

function meter() {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return {
    stream,
    result: () => ({ sha256: hash.digest("hex"), bytes }),
  };
}

export function rcloneArguments(command, ...arguments_) {
  if (command === "rcat") {
    return [
      "rcat", ...arguments_, ...RCLONE_BASE,
      "--s3-upload-cutoff", "128Mi",
      "--s3-chunk-size", "128Mi",
    ];
  }
  return [command, ...arguments_, ...RCLONE_BASE];
}

async function runRclone(config, args, environment = process.env) {
  const execution = capturedChild("rclone", args, rcloneEnvironment(config, environment));
  let stdout = "";
  execution.child.stdout.on("data", (chunk) => {
    if (stdout.length < 1_000_000) stdout += chunk.toString();
  });
  await execution.completion;
  return stdout;
}

export async function streamEncryptedArchive(
  config,
  descriptor,
  stagingKey,
  environment = process.env,
) {
  const tar = capturedChild("tar", [
    "--create",
    "--zstd",
    "--format=pax",
    "--file=-",
    `--directory=${descriptor.root}`,
    "--no-recursion",
    "--null",
    "--verbatim-files-from",
    "--files-from=-",
  ], environment, { input: "pipe" });
  const age = capturedChild("age", [
    "--encrypt",
    "--recipients-file", config.recipientFile,
  ], environment, { input: "pipe" });
  const upload = capturedChild("rclone", rcloneArguments(
    "rcat",
    remotePath(config, stagingKey),
  ), rcloneEnvironment(config, environment), { input: "pipe" });
  const measurement = meter();
  const children = [tar.child, age.child, upload.child];
  const streamTasks = [
    pipeline(tar.child.stdout, age.child.stdin),
    pipeline(age.child.stdout, measurement.stream, upload.child.stdin),
  ];
  tar.child.stdin.end(Buffer.from(`${descriptor.archiveEntries.join("\0")}\0`, "utf8"));
  const tasks = [...streamTasks, tar.completion, age.completion, upload.completion];
  try {
    await Promise.all(tasks);
  } catch (error) {
    stop(children);
    const settled = await Promise.allSettled(tasks);
    const processFailure = settled.slice(streamTasks.length)
      .find((result) => result.status === "rejected");
    throw processFailure?.reason ?? error;
  }
  return measurement.result();
}

async function remoteStat(config, objectKey, environment, executeRclone) {
  const output = await executeRclone(
    config,
    rcloneArguments("lsjson", remotePath(config, objectKey), "--stat"),
    environment,
  );
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("R2 returned an invalid object description after upload");
  }
  if (!value || value.IsDir === true || !Number.isSafeInteger(value.Size) || value.Size < 1) {
    throw new Error("R2 did not report a non-empty completed backup object");
  }
  return value;
}

async function cleanupStaging(config, stagingKey, environment, executeRclone) {
  try {
    await executeRclone(
      config,
      rcloneArguments("deletefile", remotePath(config, stagingKey)),
      environment,
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function uploadVerifiedBackup(
  backupDirectory,
  config,
  environment = process.env,
  dependencies = {},
) {
  await (dependencies.verifyBackup ?? verifyBackup)(backupDirectory, "pg_restore", environment);
  const descriptor = verifiedBackupDescriptor(backupDirectory);
  const nonce = (dependencies.randomUUID ?? randomUUID)().toLowerCase();
  const stagingKey = stagingObjectKey(config, descriptor.name, nonce);
  const archive = dependencies.streamEncryptedArchive ?? streamEncryptedArchive;
  const executeRclone = dependencies.runRclone ?? runRclone;
  let encrypted;
  try {
    encrypted = await archive(config, descriptor, stagingKey, environment);
    if (!/^[a-f0-9]{64}$/u.test(encrypted?.sha256) || !Number.isSafeInteger(encrypted?.bytes)
      || encrypted.bytes < 1) {
      throw new Error("Encrypted backup stream returned an invalid checksum or size");
    }
    const objectKey = completedObjectKey(config, descriptor.name, encrypted.sha256);
    await executeRclone(config, rcloneArguments(
      "copyto",
      remotePath(config, stagingKey),
      remotePath(config, objectKey),
      "--immutable",
      "--no-traverse",
    ), environment);
    const remote = await remoteStat(config, objectKey, environment, executeRclone);
    if (remote.Size !== encrypted.bytes) throw new Error("R2 completed object size does not match the encrypted upload");
    const cleanupWarning = await cleanupStaging(config, stagingKey, environment, executeRclone);
    return {
      provider: "cloudflare-r2",
      backupName: descriptor.name,
      objectKey,
      sha256: encrypted.sha256,
      bytes: encrypted.bytes,
      uploadedAt: new Date().toISOString(),
      cleanupWarning,
    };
  } catch (error) {
    await cleanupStaging(config, stagingKey, environment, executeRclone);
    throw error;
  }
}

export async function findCompletedBackup(config, backupName, environment = process.env, dependencies = {}) {
  const executeRclone = dependencies.runRclone ?? runRclone;
  const directory = `${config.prefix}/sets`;
  const output = await executeRclone(
    config,
    rcloneArguments("lsjson", remotePath(config, directory), "--max-depth", "1", "--files-only"),
    environment,
  );
  let entries;
  try {
    entries = JSON.parse(output);
  } catch {
    throw new Error("R2 returned an invalid completed-set listing");
  }
  if (!Array.isArray(entries)) throw new Error("R2 completed-set listing is not an array");
  for (const entry of entries) {
    const path = typeof entry?.Path === "string" ? entry.Path : "";
    const objectKey = `${directory}/${path}`;
    try {
      const parsed = parseCompletedObjectKey(config, objectKey);
      if (parsed.backupName === backupName && Number.isSafeInteger(entry.Size) && entry.Size > 0) {
        return { objectKey, sha256: parsed.sha256, bytes: entry.Size, uploadedAt: entry.ModTime ?? null };
      }
    } catch {
      // Ignore unrelated objects under the completed-set prefix.
    }
  }
  return null;
}

async function consumeEncryptedObject(config, objectKey, destination, environment) {
  const expected = parseCompletedObjectKey(config, objectKey);
  const download = capturedChild(
    "rclone",
    rcloneArguments("cat", remotePath(config, objectKey)),
    rcloneEnvironment(config, environment),
  );
  const measurement = meter();
  try {
    await Promise.all([
      pipeline(download.child.stdout, measurement.stream, destination),
      download.completion,
    ]);
  } catch (error) {
    stop([download.child]);
    await Promise.allSettled([download.completion]);
    throw error;
  }
  const result = measurement.result();
  if (result.sha256 !== expected.sha256) throw new Error("Downloaded R2 backup ciphertext checksum mismatch");
  return { ...expected, ...result };
}

export async function verifyEncryptedObject(config, objectKey, environment = process.env, dependencies = {}) {
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  return consumeEncryptedObject(config, objectKey, sink, environment);
}

export async function downloadEncryptedObject(
  config,
  objectKey,
  outputPath,
  environment = process.env,
  dependencies = {},
) {
  const output = resolve(outputPath);
  if (existsSync(output)) throw new Error(`Refusing to overwrite existing download: ${output}`);
  const temporary = resolve(dirname(output), `.${basename(output)}.${process.pid}.${Date.now()}.tmp`);
  const stream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  try {
    const result = await consumeEncryptedObject(config, objectKey, stream, environment);
    renameSync(temporary, output);
    return { ...result, output };
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The failed pipeline may not have created the temporary file. */ }
    throw error;
  }
}
