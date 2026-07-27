import assert from "node:assert/strict";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { PassThrough } from "node:stream";

import test from "node:test";

import {
  activateCloudflare,
  basicEnvironmentUpdates,
  containerRuntimeEnvironmentUpdates,
  configureEnvironment,
  environmentValues,
  ensureEnvironmentFile,
  parseSetupArgs,
  parseVersion,
  readHiddenValue,
  resolveConfiguration,
  supportsNode,
  updateEnvironmentText,
  verifyContainerRuntime,
} from "../setup.mjs";

test("uses the minimum settings for each runtime", () => {
  assert.deepEqual(
    basicEnvironmentUpdates({ data: "real", mode: "local" }),
    { MOCK_ENABLED: "false" },
  );
  assert.deepEqual(
    basicEnvironmentUpdates({ data: "demo", mode: "docker", port: 8081 }),
    { APP_PORT: "8081", MOCK_ENABLED: "true" },
  );
  assert.deepEqual(
    basicEnvironmentUpdates({
      cloudflareUiPending: true,
      data: "real",
      mode: "docker",
      port: 8080,
    }),
    {
      APP_PORT: "8080",
      BIND_ADDRESS: "127.0.0.1",
      MOCK_ENABLED: "false",
    },
  );
  assert.deepEqual(
    basicEnvironmentUpdates({
      data: "real",
      installUpdateAgent: true,
      mode: "docker",
      port: 8080,
      updateAgentGroupId: 4321,
    }),
    {
      APP_PORT: "8080",
      MOCK_ENABLED: "false",
      STUGA_UPDATE_OPERATIONS_GID: "4321",
    },
  );
  assert.deepEqual(
    basicEnvironmentUpdates({
      cloudflare: { composeSecretDirectory: "./secrets/cloudflare", mode: "remote-ui" },
      data: "real",
      mode: "docker",
      port: 8080,
    }),
    {
      APP_PORT: "8080",
      BIND_ADDRESS: "127.0.0.1",
      MOCK_ENABLED: "false",
      STUGA_CLOUDFLARE_ENV_FILE: "./secrets/cloudflare/config.env",
      STUGA_CLOUDFLARE_SECRET_DIR: "./secrets/cloudflare",
    },
  );
  assert.deepEqual(
    basicEnvironmentUpdates({ data: "real", mode: "podman", port: 8080 }),
    { APP_PORT: "8080", COMPOSE_PROFILES: "", MOCK_ENABLED: "false" },
  );
  assert.deepEqual(basicEnvironmentUpdates({ mode: "rpi" }), {});
  assert.deepEqual(
    containerRuntimeEnvironmentUpdates("docker", { rootless: false }),
    {
      STUGA_HOST_BIND_USER: "1000:1000",
      STUGA_UPDATE_OPERATIONS_DIRECTORY: "./data/update-operations",
      STUGA_UPDATE_OPERATIONS_MOUNT_OPTIONS: "z",
    },
  );
  assert.deepEqual(
    containerRuntimeEnvironmentUpdates("podman", { rootless: true }),
    {
      STUGA_HOST_BIND_USER: "0:0",
      STUGA_UPDATE_OPERATIONS_DIRECTORY: "stuga-update-operations",
      STUGA_UPDATE_OPERATIONS_MOUNT_OPTIONS: "rw",
    },
  );
  assert.deepEqual(containerRuntimeEnvironmentUpdates("local", {}), {});
});

test("validates the selected Compose runtime before launch", () => {
  const calls = [];
  const runtime = verifyContainerRuntime("podman", (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: args[0] === "info" ? "true\n" : "" };
  });
  assert.deepEqual(runtime, { rootless: true });
  assert.deepEqual(calls, [
    ["podman", "--version"],
    ["podman", "compose", "config"],
    ["podman", "info", "--format", "{{.Host.Security.Rootless}}"],
  ]);

  assert.throws(
    () => verifyContainerRuntime("docker", () => ({ error: { code: "ENOENT" }, status: null })),
    /Docker is not available/u,
  );
});

test("hidden input returns the token without echoing it", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  output.isTTY = true;
  let visible = "";
  output.on("data", (chunk) => { visible += chunk.toString("utf8"); });

  const answer = readHiddenValue("Secret: ", { input, output });
  input.write("hidden-test-token\r");
  assert.equal(await answer, "hidden-test-token");
  assert.equal(visible, "Secret: \n");
});

test("Cloudflare activation keeps pasted tokens out of commands and logs", async () => {
  const provisionToken = "p".repeat(40);
  const accessToken = "a".repeat(40);
  const tokenAnswers = [provisionToken, accessToken];
  const calls = [];
  const logs = [];
  const configuration = {
    cloudflare: {
      command: "provision",
      hostname: "stugu.example.test",
      mode: "remote-ui",
      secretDirectory: "C:\\protected\\cloudflare",
      tokenInput: "prompt",
    },
    mode: "docker",
    port: 8080,
  };

  const result = await activateCloudflare(configuration, {
    logger: { log: (message) => logs.push(message) },
    provisioner: async (_options, dependencies) => {
      calls.push(["provision", dependencies.provisionToken, dependencies.accessToken]);
    },
    runner: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0 };
    },
    tokenReader: async () => tokenAnswers.shift(),
    verifier: async () => ({ origin: "https://stugu.example.test" }),
    verifyAttempts: 1,
  });

  assert.deepEqual(result, { origin: "https://stugu.example.test" });
  assert.deepEqual(calls, [
    ["provision", provisionToken, accessToken],
    [
      "docker",
      "compose",
      "up",
      "-d",
      "--build",
      "--force-recreate",
      "api",
      "web",
      "cloudflared",
    ],
  ]);
  assert.doesNotMatch(logs.join("\n"), new RegExp(`${provisionToken}|${accessToken}`, "u"));
});

test("Cloudflare coordinator upgrade reuses the retained runtime approval", async () => {
  const provisionToken = "p".repeat(40);
  const calls = [];
  const configuration = {
    cloudflare: {
      accessTokenFile: "C:\\protected\\cloudflare\\access-group-token",
      command: "provision-coordinator",
      hostname: "stugu.example.test",
      mode: "stuguby-coordinator",
      provisionRequired: true,
      secretDirectory: "C:\\protected\\cloudflare",
      tokenInput: "provision-prompt",
    },
    mode: "docker",
    port: 8080,
  };

  await activateCloudflare(configuration, {
    logger: { log() {} },
    provisioner: async (_options, dependencies) => {
      calls.push({
        accessToken: dependencies.accessToken,
        provisionToken: dependencies.provisionToken,
      });
    },
    runner: () => ({ status: 0 }),
    tokenReader: async () => provisionToken,
    verifier: async () => ({ origin: "https://stugu.example.test" }),
    verifyAttempts: 1,
  });

  assert.deepEqual(calls, [{ accessToken: undefined, provisionToken }]);
});

test("Cloudflare OAuth approval is scoped, never logged, and revoked after verification", async () => {
  const provisionToken = "o".repeat(40);
  const events = [];
  const logs = [];
  const configuration = {
    cloudflare: {
      accessTokenFile: "C:\\protected\\cloudflare\\access-group-token",
      command: "provision-coordinator",
      hostname: "stugu.example.test",
      mode: "stuguby-coordinator",
      oauthClientId: "stugu-oauth-client",
      oauthRedirectUri: "http://127.0.0.1:8976/cloudflare/oauth/callback",
      provisionRequired: true,
      secretDirectory: "C:\\protected\\cloudflare",
      tokenInput: "oauth",
      zoneId: "b".repeat(32),
    },
    mode: "docker",
    port: 8080,
  };

  await activateCloudflare(configuration, {
    logger: { log: (message) => logs.push(message) },
    oauthAuthorizer: async (options) => {
      events.push(["authorize", options]);
      return {
        accessToken: provisionToken,
        async revoke() {
          events.push(["revoke"]);
        },
      };
    },
    provisioner: async (_options, dependencies) => {
      events.push(["provision", dependencies.provisionToken, dependencies.accessToken]);
    },
    runner: () => {
      events.push(["start"]);
      return { status: 0 };
    },
    verifier: async () => {
      events.push(["verify"]);
      return { origin: "https://stugu.example.test" };
    },
    verifyAttempts: 1,
  });

  assert.deepEqual(events.map(([event]) => event), [
    "authorize",
    "provision",
    "start",
    "verify",
    "revoke",
  ]);
  assert.deepEqual(events[0][1].scopes, [
    "access.write",
    "argotunnel.write",
    "dns.write",
  ]);
  assert.deepEqual(events[1], ["provision", provisionToken, undefined]);
  assert.doesNotMatch(logs.join("\n"), new RegExp(provisionToken, "u"));
});

test("Cloudflare OAuth approval is revoked when provisioning fails", async () => {
  let revoked = false;
  await assert.rejects(
    activateCloudflare(
      {
        cloudflare: {
          command: "provision",
          hostname: "stugu.example.test",
          mode: "remote-ui",
          oauthClientId: "stugu-oauth-client",
          oauthRedirectUri: "http://127.0.0.1:8976/cloudflare/oauth/callback",
          provisionRequired: true,
          tokenInput: "oauth",
          zoneId: null,
        },
        mode: "docker",
        port: 8080,
      },
      {
        logger: { log() {} },
        oauthAuthorizer: async (options) => {
          assert.ok(options.scopes.includes("zone.read"));
          return {
            accessToken: "o".repeat(40),
            async revoke() {
              revoked = true;
            },
          };
        },
        provisioner: async () => {
          throw new Error("provider unavailable");
        },
      },
    ),
    /provider unavailable/u,
  );
  assert.equal(revoked, true);
});

test("new Cloudflare OAuth setup retains only the separately supplied runtime token", async () => {
  const provisionToken = "o".repeat(40);
  const runtimeToken = "r".repeat(40);
  let provisioned;
  let revoked = false;

  await activateCloudflare(
    {
      cloudflare: {
        command: "provision",
        hostname: "stugu.example.test",
        mode: "remote-ui",
        oauthClientId: "stugu-oauth-client",
        oauthRedirectUri: "http://127.0.0.1:8976/cloudflare/oauth/callback",
        provisionRequired: true,
        tokenInput: "oauth-prompt",
        zoneId: null,
      },
      mode: "docker",
      port: 8080,
    },
    {
      logger: { log() {} },
      oauthAuthorizer: async () => ({
        accessToken: provisionToken,
        async revoke() {
          revoked = true;
        },
      }),
      provisioner: async (_options, dependencies) => {
        provisioned = {
          accessToken: dependencies.accessToken,
          provisionToken: dependencies.provisionToken,
        };
      },
      runner: () => ({ status: 0 }),
      tokenReader: async () => runtimeToken,
      verifier: async () => ({ origin: "https://stugu.example.test" }),
      verifyAttempts: 1,
    },
  );

  assert.deepEqual(provisioned, { accessToken: runtimeToken, provisionToken });
  assert.equal(revoked, true);
});

test("Cloudflare activation stops the connector when boundary verification fails", async () => {
  const calls = [];
  await assert.rejects(
    activateCloudflare(
      {
        cloudflare: {
          command: "provision",
          hostname: "stugu.example.test",
          mode: "remote-ui",
          secretDirectory: "C:\\protected\\cloudflare",
          tokenInput: "files",
        },
        mode: "podman",
        port: 8080,
      },
      {
        logger: { log() {} },
        provisioner: async () => {},
        runner: (command, args) => {
          calls.push([command, ...args]);
          return { status: 0 };
        },
        verifier: async () => {
          throw new Error("root is exposed");
        },
        verifyAttempts: 2,
        verifyDelayMs: 0,
        waitForRetry: async () => {},
      },
    ),
    /public connector was stopped/u,
  );
  assert.deepEqual(calls.at(-1), ["podman", "compose", "stop", "cloudflared"]);
});
