#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const directory = resolve(process.env.STUGA_RUNTIME_SECRET_DIR ?? "/app/runtime");
const secrets = [
  resolve(process.env.STUGA_TIMESERIES_ADMIN_SECRET_PATH ?? join(directory, "timeseries-admin-password")),
  resolve(process.env.STUGA_TIMESERIES_APP_SECRET_PATH ?? join(directory, "timeseries-password")),
  resolve(process.env.STUGA_PROXY_SECRET_PATH ?? join(directory, "local-auth-proxy-secret")),
  resolve(process.env.STUGA_TAPO_WORKER_SECRET_PATH ?? join(directory, "tapo-history-worker-token")),
];

function ensureSecret(path) {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (Buffer.byteLength(existing, "utf8") < 32) {
      throw new Error(`Existing runtime secret ${path} is shorter than 32 bytes`);
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const value = randomBytes(48).toString("base64url");
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o444);
    writeFileSync(descriptor, `${value}\n`, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      ensureSecret(path);
      return;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

for (const path of secrets) {
  mkdirSync(dirname(path), { recursive: true });
  ensureSecret(path);
}
