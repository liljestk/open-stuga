#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const defaultApiBase = "https://api.connect.raspberrypi.com";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readConfig(env = process.env) {
  const token = required(env, "RPI_CONNECT_API_TOKEN");
  const deviceId = required(env, "RPI_CONNECT_DEVICE_ID");
  const version = required(env, "RPI_OTA_VERSION").replace(/^v/, "");
  const uri = required(env, "RPI_OTA_URI");
  const checksum = required(env, "RPI_OTA_CHECKSUM").toLowerCase();
  const deploy = (env.RPI_OTA_DEPLOY ?? "true").toLowerCase() !== "false";
  const waitMinutes = Number(env.RPI_OTA_WAIT_MINUTES ?? 30);

  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$/.test(version) || version.length > 64) {
    throw new Error("RPI_OTA_VERSION must be a release-like version of at most 64 characters");
  }
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error("RPI_OTA_CHECKSUM must be a hex-encoded SHA-256 checksum");
  }
  if (!/^https:\/\//.test(uri)) {
    throw new Error("RPI_OTA_URI must use HTTPS");
  }
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(deviceId)) {
    throw new Error("RPI_CONNECT_DEVICE_ID must be a UUID");
  }
  if (!Number.isFinite(waitMinutes) || waitMinutes < 1 || waitMinutes > 120) {
    throw new Error("RPI_OTA_WAIT_MINUTES must be between 1 and 120");
  }

  return {
    token,
    deviceId,
    version,
    uri,
    checksum,
    deploy,
    waitMinutes,
    artefactName: `stuga-rpi4-${version}`,
  };
}

async function connectRequest(config, path, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${defaultApiBase}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { message: bodyText };
  }
  if (!response.ok) {
    throw new Error(`Raspberry Pi Connect returned ${response.status}: ${body.message ?? "request failed"}`);
  }
  return body;
}

export async function ensureArtefact(config, fetchImpl = fetch) {
  const query = new URLSearchParams({ name: config.artefactName });
  const listed = await connectRequest(config, `/organisation/artefacts?${query}`, {}, fetchImpl);
  const existing = (listed.artefacts ?? []).find(({ name }) => name === config.artefactName);

  if (existing) {
    if (existing.uri !== config.uri || existing.checksum.toLowerCase() !== config.checksum) {
      throw new Error(`Artefact ${config.artefactName} already exists with different content`);
    }
    return existing;
  }

  return connectRequest(
    config,
    "/organisation/artefacts",
    {
      method: "POST",
      body: JSON.stringify({
        name: config.artefactName,
        uri: config.uri,
        checksum: config.checksum,
      }),
    },
    fetchImpl,
  );
}

export async function createDeployment(config, artefactId, fetchImpl = fetch) {
  return connectRequest(
    config,
    `/organisation/devices/${encodeURIComponent(config.deviceId)}/deployments`,
    {
      method: "POST",
      body: JSON.stringify({ artefact_id: artefactId }),
    },
    fetchImpl,
  );
}

export async function waitForDeployment(config, deploymentId, fetchImpl = fetch, delayImpl = delay) {
  const deadline = Date.now() + config.waitMinutes * 60_000;
  let lastState;

  while (Date.now() < deadline) {
    const deployment = await connectRequest(
      config,
      `/organisation/deployments/${encodeURIComponent(deploymentId)}`,
      {},
      fetchImpl,
    );
    if (deployment.state !== lastState) {
      console.log(`Deployment ${deployment.id}: ${deployment.state}`);
      lastState = deployment.state;
    }
    if (deployment.state === "succeeded") return deployment;
    if (["failed", "cancelled"].includes(deployment.state)) {
      throw new Error(`Deployment ${deployment.state}: ${deployment.state_reason ?? "no reason supplied"}`);
    }
    await delayImpl(15_000);
  }
  throw new Error(`Deployment did not finish within ${config.waitMinutes} minutes`);
}

export async function main(env = process.env, fetchImpl = fetch) {
  const config = readConfig(env);
  const artefact = await ensureArtefact(config, fetchImpl);
  console.log(`Registered artefact ${artefact.name} (${artefact.id})`);
  if (!config.deploy) return artefact;

  const deployment = await createDeployment(config, artefact.id, fetchImpl);
  console.log(`Created deployment ${deployment.id}`);
  return waitForDeployment(config, deployment.id, fetchImpl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
