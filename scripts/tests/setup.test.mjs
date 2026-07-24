import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("accepts the supported Node.js range", () => {
  assert.deepEqual(parseVersion("v22.13.0"), [22, 13, 0]);
  assert.equal(supportsNode("22.12.9"), false);
  assert.equal(supportsNode("22.13.0"), true);
  assert.equal(supportsNode("23.0.0"), true);
  assert.equal(supportsNode("not-a-version"), false);
});

test("creates .env once and preserves local settings", (t) => {
  const root = mkdtempSync(join(tmpdir(), "stuga-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, ".env.example"), "MOCK_ENABLED=false\n", "utf8");
  assert.equal(ensureEnvironmentFile(root), "created");
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "MOCK_ENABLED=false\n");

  writeFileSync(join(root, ".env"), "LOCAL_SETTING=keep-me\n", "utf8");
  assert.equal(ensureEnvironmentFile(root), "existing");
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "LOCAL_SETTING=keep-me\n");
});

test("parses explicit install modes and non-interactive choices", () => {
  assert.deepEqual(
    parseSetupArgs(["--mode", "podman", "--demo", "--port=9090", "--start", "--yes"]),
    {
      cloudflare: {
        accessTokenFile: null,
        accountId: null,
        hostname: null,
        ownerEmail: null,
        provisionTokenFile: null,
        secretDirectory: null,
        zone: null,
        zoneId: null,
      },
      data: "demo",
      dryRun: false,
      help: false,
      installUpdateAgent: null,
      mode: "podman",
      piAction: null,
      port: 9090,
      remoteAccess: null,
      skipInstall: false,
      start: true,
      yes: true,
    },
  );
  assert.equal(parseSetupArgs(["--mode=pi", "--pi-action", "build"]).mode, "rpi");
  assert.equal(parseSetupArgs(["--install-update-agent"]).installUpdateAgent, true);
  assert.equal(parseSetupArgs(["--no-update-agent"]).installUpdateAgent, false);
  assert.throws(() => parseSetupArgs(["--demo", "--real"]), /cannot be combined/u);
  assert.throws(
    () => parseSetupArgs(["--install-update-agent", "--no-update-agent"]),
    /cannot be combined/u,
  );
  assert.throws(() => parseSetupArgs(["--port", "70000"]), /1 through 65535/u);
});

test("interactive setup asks for runtime and only basic choices", async () => {
  const answers = ["3", "yes", "9090", "1", "no"];
  let closed = false;
  const configuration = await resolveConfiguration(parseSetupArgs([]), {
    interactive: true,
    readline: {
      close: () => { closed = true; },
      question: async () => answers.shift(),
    },
  });

  assert.deepEqual(configuration, {
    cloudflare: null,
    data: "demo",
    installDependencies: false,
    installUpdateAgent: false,
    mode: "podman",
    port: 9090,
    start: false,
    updateAgentGroupId: null,
  });
  assert.equal(closed, true);
  assert.deepEqual(answers, []);
});

test("interactive setup guides a Cloudflare deployment without asking for IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "stuga-cloudflare-setup-"));
  const answers = [
    "2",
    "no",
    "",
    "2",
    "stuga.example.test",
    "",
    "owner@example.test",
    "",
    "no",
  ];
  let closed = false;
  try {
    const configuration = await resolveConfiguration(parseSetupArgs([]), {
      interactive: true,
      root,
      readline: {
        close: () => { closed = true; },
        question: async () => answers.shift(),
      },
    });

    assert.equal(configuration.mode, "docker");
    assert.equal(configuration.start, true);
    assert.equal(configuration.installUpdateAgent, false);
    assert.deepEqual(configuration.cloudflare, {
      accessTokenFile: null,
      accountId: null,
      command: "provision",
      composeSecretDirectory: "./secrets/cloudflare",
      hostname: "stuga.example.test",
      mode: "remote-ui",
      ownerEmail: "owner@example.test",
      provisionTokenFile: null,
      secretDirectory: join(root, "secrets", "cloudflare"),
      tokenInput: "prompt",
      zone: "example.test",
      zoneId: null,
    });
    assert.equal(closed, true);
    assert.deepEqual(answers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker setup requires explicit consent before installing the update service", async () => {
  const answers = ["2", "no", "", "1", "no", "yes"];
  const configuration = await resolveConfiguration(parseSetupArgs([]), {
    groupId: 4321,
    interactive: true,
    platform: "linux",
    readline: {
      close() {},
      question: async () => answers.shift(),
    },
  });

  assert.equal(configuration.mode, "docker");
  assert.equal(configuration.installUpdateAgent, true);
  assert.equal(configuration.updateAgentGroupId, 4321);
  assert.deepEqual(answers, []);

  await assert.rejects(
    resolveConfiguration(parseSetupArgs(["--mode", "podman", "--install-update-agent"]), {
      interactive: false,
    }),
    /only valid with Docker/u,
  );
});

test("non-interactive Cloudflare setup requires explicit protected token files", async () => {
  const root = mkdtempSync(join(tmpdir(), "stuga-cloudflare-options-"));
  try {
    const base = [
      "--mode", "docker",
      "--real",
      "--cloudflare", "coordinator",
      "--cloudflare-hostname", "stuga.example.test",
      "--cloudflare-zone", "example.test",
      "--cloudflare-owner-email", "owner@example.test",
      "--yes",
    ];
    await assert.rejects(
      resolveConfiguration(parseSetupArgs(base), { interactive: false, root }),
      /requires both --cloudflare-provision-token-file/u,
    );
    await assert.rejects(
      resolveConfiguration(parseSetupArgs([...base, "--no-start", "--dry-run"]), {
        interactive: false,
        root,
      }),
      /must start and verify/u,
    );

    const configuration = await resolveConfiguration(parseSetupArgs([
      ...base,
      "--cloudflare-provision-token-file", "setup-token",
      "--cloudflare-access-token-file", "access-token",
    ]), { interactive: false, root });
    assert.equal(configuration.start, true);
    assert.equal(configuration.cloudflare.mode, "stugby-coordinator");
    assert.equal(configuration.cloudflare.command, "provision-coordinator");
    assert.equal(configuration.cloudflare.provisionTokenFile, join(root, "setup-token"));
    assert.equal(configuration.cloudflare.accessTokenFile, join(root, "access-token"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updates only selected environment values", () => {
  const source = [
    "# Local configuration",
    "MOCK_ENABLED=false",
    "APP_PORT=8080",
    "TP_LINK_PASSWORD=keep-this-secret",
    "",
  ].join("\r\n");
  const updated = updateEnvironmentText(source, {
    APP_PORT: "9090",
    COMPOSE_PROFILES: "",
    MOCK_ENABLED: "true",
  });
  const values = environmentValues(updated);

  assert.equal(values.MOCK_ENABLED, "true");
  assert.equal(values.APP_PORT, "9090");
  assert.equal(values.COMPOSE_PROFILES, "");
  assert.equal(values.TP_LINK_PASSWORD, "keep-this-secret");
  assert.match(updated, /\r\n/u);
});

test("dry-run and real configuration preserve advanced settings", (t) => {
  const root = mkdtempSync(join(tmpdir(), "stuga-configure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, ".env.example"),
    "MOCK_ENABLED=false\nAPP_PORT=8080\nTP_LINK_PASSWORD=keep-this-secret\n",
    "utf8",
  );

  assert.deepEqual(
    configureEnvironment(root, { APP_PORT: "9090", MOCK_ENABLED: "true" }, true),
    { changed: true, state: "would-create" },
  );
  assert.equal(existsSync(join(root, ".env")), false);

  assert.deepEqual(
    configureEnvironment(root, { APP_PORT: "9090", MOCK_ENABLED: "true" }),
    { changed: true, state: "created" },
  );
  const values = environmentValues(readFileSync(join(root, ".env"), "utf8"));
  assert.equal(values.APP_PORT, "9090");
  assert.equal(values.MOCK_ENABLED, "true");
  assert.equal(values.TP_LINK_PASSWORD, "keep-this-secret");
});

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
      hostname: "stuga.example.test",
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
    verifier: async () => ({ origin: "https://stuga.example.test" }),
    verifyAttempts: 1,
  });

  assert.deepEqual(result, { origin: "https://stuga.example.test" });
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

test("Cloudflare activation stops the connector when boundary verification fails", async () => {
  const calls = [];
  await assert.rejects(
    activateCloudflare(
      {
        cloudflare: {
          command: "provision",
          hostname: "stuga.example.test",
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
