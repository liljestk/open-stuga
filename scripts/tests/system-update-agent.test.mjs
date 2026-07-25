import assert from "node:assert/strict";
import {
  existsSync,
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
  applyCloudflareSetupRequest,
  applyRequest,
  composeArguments,
  readAgentConfig,
  validatedCloudflareSetupRequest,
  validatedRequest,
} from "../stuga-update-agent.mjs";

function updateRequest() {
  return {
    schema: "stuga-system-update-request/v1",
    id: "27974c49-f62e-4365-9ee7-802c7488557e",
    version: "0.6.0",
    tagName: "v0.6.0",
    repository: "liljestk/open-stuga",
    requestedAt: "2026-07-23T18:00:00.000Z",
    previousVersion: "0.5.0",
    images: {
      api: "ghcr.io/liljestk/open-stuga-api:v0.6.0",
      web: "ghcr.io/liljestk/open-stuga-web:v0.6.0",
      backup: "ghcr.io/liljestk/open-stuga-backup:v0.6.0",
      tapo: "ghcr.io/liljestk/open-stuga-tapo-export-runner:v0.6.0",
      updateAgent: "ghcr.io/liljestk/open-stuga-update-agent:v0.6.0",
    },
  };
}

function cloudflareSetupRequest() {
  return {
    schema: "stuga-cloudflare-setup-request/v1",
    id: "91576b34-fda0-4b8e-b96f-4265d2ee7f78",
    mode: "stugby-coordinator",
    command: "provision-coordinator",
    hostname: "stuga.example.com",
    zone: "example.com",
    ownerEmail: "owner@example.com",
    accountId: "0123456789abcdef0123456789abcdef",
    zoneId: "abcdef0123456789abcdef0123456789",
    oauthClientId: "stuga-private-client",
    oauthRedirectUri: "http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback",
    claimSecret: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    requestedAt: "2026-07-24T08:00:00.000Z",
  };
}

test("agent configuration is portable and pins one trusted release namespace", () => {
  const directory = mkdtempSync(join(tmpdir(), "stuga-update-agent-"));
  try {
    const config = readAgentConfig({
      STUGA_PROJECT_DIRECTORY: directory,
      SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
      SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    }, directory);
    assert.equal(config.projectDirectory, directory);
    assert.equal(config.operationsDirectory, join(directory, "data", "update-operations"));
    assert.equal(config.releaseEnvFile, join(directory, ".stuga-release.env"));
    assert.equal(config.runtime, "docker");
    assert.equal(config.composeProjectName, null);
    assert.equal(composeArguments(config).includes("--project-name"), false);

    const named = readAgentConfig({
      STUGA_COMPOSE_PROJECT_NAME: "stuga",
      STUGA_PROJECT_DIRECTORY: directory,
    }, directory, []);
    assert.deepEqual(composeArguments(named).slice(0, 3), ["compose", "--project-name", "stuga"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent resolves service arguments and relative paths from the project directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "stuga-update-agent-service-"));
  try {
    const config = readAgentConfig({
      STUGA_RELEASE_ENV_FILE: "./runtime/release.env",
      SYSTEM_UPDATE_OPERATIONS_DIRECTORY: "./runtime/operations",
    }, tmpdir(), [`--project-directory=${directory}`, "--once"]);

    assert.equal(config.projectDirectory, directory);
    assert.equal(config.operationsDirectory, join(directory, "runtime", "operations"));
    assert.equal(config.releaseEnvFile, join(directory, "runtime", "release.env"));
    assert.equal(config.once, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent accepts only API-issued image names for the exact release tag", () => {
  const config = readAgentConfig({
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
  });
  const request = updateRequest();
  assert.equal(validatedRequest(request, config).version, "0.6.0");
  assert.throws(
    () => validatedRequest({
      ...request,
      images: { ...request.images, api: "ghcr.io/attacker/replacement:v0.6.0" },
    }, config),
    /trusted image namespace/,
  );
});

test("agent validates the bounded Cloudflare setup handoff", () => {
  const request = cloudflareSetupRequest();
  assert.equal(validatedCloudflareSetupRequest(request).hostname, "stuga.example.com");
  assert.throws(
    () => validatedCloudflareSetupRequest({
      ...request,
      oauthRedirectUri: "http://127.0.0.1:80/api/v1/cloudflare/setup/oauth/callback",
    }),
    /explicit loopback/,
  );
  assert.throws(
    () => validatedCloudflareSetupRequest({ ...request, hostname: "other.invalid.com" }),
    /invalid configuration/,
  );
});

test("agent provisions, restarts, verifies, and revokes a UI-approved Cloudflare connection", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stuga-cloudflare-agent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    STUGA_CLOUDFLARE_SECRET_DIR: join(directory, "cloudflare"),
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
  }, directory, []);
  const requestPath = join(operationsDirectory, "cloudflare-request-test.json");
  writeFileSync(requestPath, JSON.stringify(cloudflareSetupRequest()), "utf8");
  const composeCalls = [];
  const provisionCalls = [];
  const revokeCalls = [];
  let verified = 0;

  await applyCloudflareSetupRequest(config, requestPath, {
    claim: async () => ({
      provisionToken: "temporary-oauth-provision-token-that-is-long-enough",
      accessToken: "runtime-access-group-token-that-is-long-enough",
      oauthClientId: "stuga-private-client",
    }),
    provisioner: async (...args) => { provisionCalls.push(args); },
    compose: async (_config, args) => { composeCalls.push(args); return ""; },
    verifyCoordinator: async () => { verified += 1; },
    revoke: async (value) => { revokeCalls.push(value); },
    waitForRetry: async () => undefined,
  });

  assert.equal(provisionCalls.length, 1);
  assert.equal(provisionCalls[0][0].command, "provision-coordinator");
  assert.equal(provisionCalls[0][1].provisionToken, "temporary-oauth-provision-token-that-is-long-enough");
  assert.equal(verified, 1);
  assert.deepEqual(revokeCalls, [{
    accessToken: "temporary-oauth-provision-token-that-is-long-enough",
    clientId: "stuga-private-client",
  }]);
  assert.equal(composeCalls.length, 1);
  assert.deepEqual(composeCalls[0].slice(-3), ["api", "web", "cloudflared"]);
  const statusText = readFileSync(join(operationsDirectory, "cloudflare-status.json"), "utf8");
  const status = JSON.parse(statusText);
  assert.equal(status.phase, "complete");
  assert.equal(statusText.includes("temporary-oauth-provision-token"), false);
  assert.equal(statusText.includes("runtime-access-group-token"), false);
  assert.equal(existsSync(requestPath), false);
});

test("agent closes public ingress and still revokes approval after failed verification", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stuga-cloudflare-agent-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
  }, directory, []);
  const requestPath = join(operationsDirectory, "cloudflare-request-test.json");
  writeFileSync(requestPath, JSON.stringify(cloudflareSetupRequest()), "utf8");
  const composeCalls = [];
  let revoked = 0;

  await applyCloudflareSetupRequest(config, requestPath, {
    claim: async () => ({
      provisionToken: "temporary-oauth-provision-token-that-is-long-enough",
      accessToken: "runtime-access-group-token-that-is-long-enough",
      oauthClientId: "stuga-private-client",
    }),
    provisioner: async () => undefined,
    compose: async (_config, args) => { composeCalls.push(args); return ""; },
    verifyCoordinator: async () => { throw new Error("protected route remained open"); },
    revoke: async () => { revoked += 1; },
    waitForRetry: async () => undefined,
  });

  const status = JSON.parse(readFileSync(join(operationsDirectory, "cloudflare-status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.match(status.detail, /protected route remained open/);
  assert.equal(composeCalls.some((args) => args[0] === "stop" && args[1] === "cloudflared"), true);
  assert.equal(revoked, 1);
  assert.equal(existsSync(requestPath), false);
});

test("pre-update failures do not attempt rollback before any release state changes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stuga-update-agent-preflight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  const requestPath = join(operationsDirectory, "request-test.json");
  writeFileSync(requestPath, JSON.stringify(updateRequest()), "utf8");
  const calls = [];

  await applyRequest(config, requestPath, {
    compose: async (_config, args) => {
      calls.push(args);
      if (args[0] === "ps") return "api\nweb\nstuga-backup-scheduler";
      if (args[0] === "exec") return "0.5.0";
      if (args.includes("stuga-backup")) throw new Error("simulated backup failure");
      throw new Error(`Unexpected Compose call: ${args.join(" ")}`);
    },
  });

  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.equal(status.detail, "simulated backup failure");
  assert.equal(calls.some((args) => args[0] === "up"), false);
  assert.equal(existsSync(config.releaseEnvFile), false);
  assert.equal(existsSync(requestPath), false);
});

test("agent rejects malformed repository and registry configuration", () => {
  assert.throws(() => readAgentConfig({ SYSTEM_UPDATE_REPOSITORY: "https://github.com/example/repo" }), /owner\/repository/);
  assert.throws(() => readAgentConfig({
    SYSTEM_UPDATE_REPOSITORY: "example/repo",
    SYSTEM_UPDATE_IMAGE_PREFIX: "docker.io/example/repo",
  }), /GHCR/);
  assert.throws(() => readAgentConfig({ SYSTEM_UPDATE_RUNTIME: "windows" }), /docker or raspberry-pi/);
});
