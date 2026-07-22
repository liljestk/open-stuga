import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDeployment,
  ensureArtefact,
  readConfig,
  waitForDeployment,
} from "../deploy-rpi-ota.mjs";

const baseEnv = {
  RPI_CONNECT_API_TOKEN: "secret-token",
  RPI_CONNECT_DEVICE_ID: "69739b44-ebb2-468e-9e24-08126dec4925",
  RPI_OTA_VERSION: "v1.2.3",
  RPI_OTA_URI: "https://example.test/stuga-rpi4-1.2.3-ota.tar.zst",
  RPI_OTA_CHECKSUM: "a".repeat(64),
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("readConfig normalizes and validates release input", () => {
  const config = readConfig(baseEnv);
  assert.equal(config.version, "1.2.3");
  assert.equal(config.artefactName, "stuga-rpi4-1.2.3");
  assert.equal(config.deploy, true);
});

test("readConfig rejects non-HTTPS artifact URLs", () => {
  assert.throws(
    () => readConfig({ ...baseEnv, RPI_OTA_URI: "http://example.test/update.tar.zst" }),
    /must use HTTPS/,
  );
});

test("readConfig rejects malformed versions and device UUIDs", () => {
  assert.throws(
    () => readConfig({ ...baseEnv, RPI_OTA_VERSION: "1.2.3/../../replacement" }),
    /release-like version/,
  );
  assert.throws(
    () => readConfig({ ...baseEnv, RPI_CONNECT_DEVICE_ID: "a".repeat(36) }),
    /must be a UUID/,
  );
});

test("the appliance orders both shared container stores before container startup", async () => {
  const [layer, growService] = await Promise.all([
    readFile(new URL("../../deploy/rpi/layer/stuga.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stuga-data-grow.service", import.meta.url), "utf8"),
  ]);

  assert.match(layer, /containerd\.service\.d\/stuga-shared-storage\.conf[\s\S]*Requires=stuga-data-grow\.service var-lib-containerd\.mount/);
  assert.match(layer, /docker\.service\.d\/stuga-shared-storage\.conf[\s\S]*Requires=stuga-data-grow\.service var-lib-docker\.mount var-lib-containerd\.mount/);
  assert.match(growService, /Before=persistent-shared-init\.service containerd\.service docker\.service stuga\.service/);
});

test("the release workflow builds recoverable images on a hosted native ARM64 runner", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/rpi-release.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /runs-on: ubuntu-24\.04-arm/);
  assert.match(workflow, /docker run --rm --privileged --platform linux\/arm64/);
  assert.match(workflow, /RPI_FACTORY_SSH_PUBLIC_KEY/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /retention-days: 3/);
  assert.doesNotMatch(workflow, /runs-on: \[self-hosted/);
});

test("ensureArtefact reuses an identical registered artifact", async () => {
  const config = readConfig(baseEnv);
  const existing = {
    id: "artifact-id",
    name: config.artefactName,
    uri: config.uri,
    checksum: config.checksum,
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({ artefacts: [existing] });
  };

  assert.deepEqual(await ensureArtefact(config, fetchImpl), existing);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/organisation\/artefacts\?name=/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
});

test("createDeployment sends the artifact id as JSON", async () => {
  const config = readConfig(baseEnv);
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return response({ id: "deployment-id", state: "pending" }, 201);
  };

  const result = await createDeployment(config, "artifact-id", fetchImpl);
  assert.equal(result.id, "deployment-id");
  assert.match(request.url, new RegExp(`/devices/${config.deviceId}/deployments$`));
  assert.deepEqual(JSON.parse(request.init.body), { artefact_id: "artifact-id" });
});

test("waitForDeployment returns after a successful transition", async () => {
  const config = readConfig({ ...baseEnv, RPI_OTA_WAIT_MINUTES: "1" });
  const states = ["in_progress", "succeeded"];
  const fetchImpl = async () => response({ id: "deployment-id", state: states.shift() });
  const delayImpl = async () => {};

  const result = await waitForDeployment(config, "deployment-id", fetchImpl, delayImpl);
  assert.equal(result.state, "succeeded");
});
