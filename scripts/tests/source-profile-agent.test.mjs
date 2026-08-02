import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readAgentConfig } from "../stugu-update-agent/configuration-request.mjs";
import {
  applySourceProfileRequest,
  validatedSourceProfileRequest,
} from "../stugu-update-agent/services-source-profiles.mjs";
import { heartbeat, pendingWork } from "../stugu-update-agent/update-loop.mjs";

const request = (enabled, id = "27974c49-f62e-4365-9ee7-802c7488557e") => ({
  schema: "stugu-source-profile-request/v1",
  id,
  adapter: "nexus433",
  enabled,
  requestedAt: "2026-07-31T10:00:00.000Z",
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-source-profile-"));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  writeFileSync(join(directory, ".env"), "COMPOSE_PROFILES=self-update\n", "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
  }, directory, []);
}

test("source profile requests are closed over the Nexus adapter and exact schema", () => {
  assert.deepEqual(validatedSourceProfileRequest(request(true)), {
    id: request(true).id,
    adapter: "nexus433",
    enabled: true,
    requestedAt: "2026-07-31T10:00:00.000Z",
  });
  assert.throws(() => validatedSourceProfileRequest({ ...request(true), adapter: "arbitrary" }), /Unsupported/);
  assert.throws(() => validatedSourceProfileRequest({ ...request(true), service: "docker.sock" }), /Unsupported/);
});

test("agent starts and stops only the bounded MQTT and Nexus profiles", async (t) => {
  const config = fixture(t);
  const enablePath = join(config.operationsDirectory, `source-profile-request-${request(true).id}.json`);
  writeFileSync(enablePath, JSON.stringify(request(true)), "utf8");
  assert.equal(pendingWork(config).kind, "source-profile");
  const calls = [];
  await applySourceProfileRequest(config, enablePath, {
    compose: async (_config, args) => { calls.push(args); return ""; },
  });
  assert.equal(readFileSync(join(config.projectDirectory, ".env"), "utf8"), "COMPOSE_PROFILES=self-update,mqtt,nexus433\n");
  assert.deepEqual(calls, [[
    "--profile", "mqtt", "--profile", "nexus433", "up", "--detach", "--no-deps",
    "--wait", "--wait-timeout", "120", "source-ingress-secrets", "mqtt", "nexus433",
  ]]);
  assert.equal(JSON.parse(readFileSync(join(config.operationsDirectory, "source-profile-status.json"), "utf8")).phase, "complete");

  calls.length = 0;
  const disableRequest = request(false, "37974c49-f62e-4365-9ee7-802c7488557e");
  const disablePath = join(config.operationsDirectory, `source-profile-request-${disableRequest.id}.json`);
  writeFileSync(disablePath, JSON.stringify(disableRequest), "utf8");
  await applySourceProfileRequest(config, disablePath, {
    compose: async (_config, args) => { calls.push(args); return ""; },
  });
  assert.equal(readFileSync(join(config.projectDirectory, ".env"), "utf8"), "COMPOSE_PROFILES=self-update\n");
  assert.deepEqual(calls, [
    ["stop", "nexus433"], ["rm", "--force", "--stop", "nexus433"],
    ["stop", "mqtt"], ["rm", "--force", "--stop", "mqtt"],
  ]);
});

test("agent advertises source-profile control without enabling it", (t) => {
  const config = fixture(t);
  heartbeat(config, true);
  const status = JSON.parse(readFileSync(join(config.operationsDirectory, "agent-status.json"), "utf8"));
  assert.deepEqual(status.capabilities, ["system-update", "cloudflare-setup", "source-profile", "storage-settings"]);
  assert.equal(readFileSync(join(config.projectDirectory, ".env"), "utf8"), "COMPOSE_PROFILES=self-update\n");
});
