import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  basicEnvironmentUpdates,
  configureEnvironment,
  environmentValues,
  ensureEnvironmentFile,
  parseSetupArgs,
  parseVersion,
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
      data: "demo",
      dryRun: false,
      help: false,
      mode: "podman",
      piAction: null,
      port: 9090,
      skipInstall: false,
      start: true,
      yes: true,
    },
  );
  assert.equal(parseSetupArgs(["--mode=pi", "--pi-action", "build"]).mode, "rpi");
  assert.throws(() => parseSetupArgs(["--demo", "--real"]), /cannot be combined/u);
  assert.throws(() => parseSetupArgs(["--port", "70000"]), /1 through 65535/u);
});

test("interactive setup asks for runtime and only basic choices", async () => {
  const answers = ["3", "yes", "9090", "no"];
  let closed = false;
  const configuration = await resolveConfiguration(parseSetupArgs([]), {
    interactive: true,
    readline: {
      close: () => { closed = true; },
      question: async () => answers.shift(),
    },
  });

  assert.deepEqual(configuration, {
    data: "demo",
    installDependencies: false,
    mode: "podman",
    port: 9090,
    start: false,
  });
  assert.equal(closed, true);
  assert.deepEqual(answers, []);
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
    basicEnvironmentUpdates({ data: "real", mode: "podman", port: 8080 }),
    { APP_PORT: "8080", COMPOSE_PROFILES: "", MOCK_ENABLED: "false" },
  );
  assert.deepEqual(basicEnvironmentUpdates({ mode: "rpi" }), {});
});

test("validates the selected Compose runtime before launch", () => {
  const calls = [];
  verifyContainerRuntime("podman", (command, args) => {
    calls.push([command, ...args]);
    return { status: 0 };
  });
  assert.deepEqual(calls, [
    ["podman", "--version"],
    ["podman", "compose", "config"],
  ]);

  assert.throws(
    () => verifyContainerRuntime("docker", () => ({ error: { code: "ENOENT" }, status: null })),
    /Docker is not available/u,
  );
});
