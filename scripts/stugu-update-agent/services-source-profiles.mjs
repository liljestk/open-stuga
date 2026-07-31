import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rmSync } from "node:fs";

import { bounded, compose, readJson, writeJson } from "./configuration-request.mjs";
import { setComposeProfiles } from "./services-cloudflare.mjs";

const REQUEST_SCHEMA = "stugu-source-profile-request/v1";
const SOURCE_PROFILES = ["mqtt", "nexus433"];
const SOURCE_SERVICES = ["source-ingress-secrets", "mqtt", "nexus433"];

export function validatedSourceProfileRequest(value) {
  if (!value || typeof value !== "object" || value.schema !== REQUEST_SCHEMA
    || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/iu.test(value.id)
    || value.adapter !== "nexus433"
    || typeof value.enabled !== "boolean"
    || typeof value.requestedAt !== "string" || !Number.isFinite(Date.parse(value.requestedAt))
    || Object.keys(value).some((key) => !["schema", "id", "adapter", "enabled", "requestedAt"].includes(key))) {
    throw new Error("Unsupported source profile request");
  }
  return {
    id: value.id,
    adapter: "nexus433",
    enabled: value.enabled,
    requestedAt: new Date(value.requestedAt).toISOString(),
  };
}

function operation(request, phase, detail, completedAt = null) {
  return {
    id: request.id,
    enabled: request.enabled,
    phase,
    requestedAt: request.requestedAt,
    completedAt,
    detail,
  };
}

async function stopSources(config, composeCommand) {
  for (const service of ["nexus433", "mqtt"]) {
    await composeCommand(config, ["stop", service], 30_000);
    await composeCommand(config, ["rm", "--force", "--stop", service], 30_000);
  }
}

export async function applySourceProfileRequest(config, requestPath, dependencies = {}) {
  const composeCommand = dependencies.compose ?? compose;
  const statusPath = join(config.operationsDirectory, "source-profile-status.json");
  const raw = readJson(requestPath);
  let request;
  try {
    request = validatedSourceProfileRequest(raw);
  } catch (error) {
    const completedAt = new Date().toISOString();
    writeJson(statusPath, {
      id: typeof raw?.id === "string" ? raw.id : randomUUID(),
      enabled: raw?.enabled === true,
      phase: "failed",
      requestedAt: typeof raw?.requestedAt === "string" ? raw.requestedAt : completedAt,
      completedAt,
      detail: error instanceof Error ? bounded(error.message) : "Invalid source profile request",
    });
    rmSync(requestPath, { force: true });
    return;
  }
  const setStatus = (phase, detail, completedAt = null) => writeJson(
    statusPath,
    operation(request, phase, detail, completedAt),
  );
  try {
    setStatus("applying", request.enabled ? "Starting the 433 MHz receiver" : "Stopping the 433 MHz receiver");
    if (request.enabled) {
      setComposeProfiles(config, SOURCE_PROFILES, true);
      try {
        await composeCommand(config, [
          "--profile", "mqtt",
          "--profile", "nexus433",
          "up", "--detach", "--no-deps", "--wait", "--wait-timeout", "120",
          ...SOURCE_SERVICES,
        ], 180_000);
      } catch (error) {
        setComposeProfiles(config, SOURCE_PROFILES, false);
        try {
          await stopSources(config, composeCommand);
        } catch (cleanupError) {
          const initial = error instanceof Error ? error.message : "source startup failed";
          const cleanup = cleanupError instanceof Error ? cleanupError.message : "container cleanup failed";
          throw new Error(`${initial}; cleanup also failed: ${cleanup}`);
        }
        throw error;
      }
    } else {
      setComposeProfiles(config, SOURCE_PROFILES, false);
      await stopSources(config, composeCommand);
    }
    setStatus(
      "complete",
      request.enabled ? "The 433 MHz receiver is running" : "The 433 MHz receiver is stopped",
      new Date().toISOString(),
    );
  } catch (error) {
    setStatus("failed", error instanceof Error ? bounded(error.message) : "Source profile change failed", new Date().toISOString());
  } finally {
    rmSync(requestPath, { force: true });
  }
}
