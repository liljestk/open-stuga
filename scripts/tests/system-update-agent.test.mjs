import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAgentConfig, validatedRequest } from "../stuga-update-agent.mjs";

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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent accepts only API-issued image names for the exact release tag", () => {
  const config = readAgentConfig({
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
  });
  const request = {
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
  assert.equal(validatedRequest(request, config).version, "0.6.0");
  assert.throws(
    () => validatedRequest({
      ...request,
      images: { ...request.images, api: "ghcr.io/attacker/replacement:v0.6.0" },
    }, config),
    /trusted image namespace/,
  );
});

test("agent rejects malformed repository and registry configuration", () => {
  assert.throws(() => readAgentConfig({ SYSTEM_UPDATE_REPOSITORY: "https://github.com/example/repo" }), /owner\/repository/);
  assert.throws(() => readAgentConfig({
    SYSTEM_UPDATE_REPOSITORY: "example/repo",
    SYSTEM_UPDATE_IMAGE_PREFIX: "docker.io/example/repo",
  }), /GHCR/);
  assert.throws(() => readAgentConfig({ SYSTEM_UPDATE_RUNTIME: "windows" }), /docker or raspberry-pi/);
});
