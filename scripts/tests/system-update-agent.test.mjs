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
  applyRequest,
  composeArguments,
  readAgentConfig,
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
