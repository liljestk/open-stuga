import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDeployment,
  ensureArtefact,
  readConfig,
  waitForDeployment,
} from "../deploy-rpi-ota.mjs";
import {
  artifactDefinitions,
  imageDefinitions,
  parseArguments,
  platformInvocation,
  repositoryFromRemote,
} from "../publish-local-release.mjs";

const baseEnv = {
  RPI_CONNECT_API_TOKEN: "secret-token",
  RPI_CONNECT_DEVICE_ID: "69739b44-ebb2-468e-9e24-08126dec4925",
  RPI_OTA_VERSION: "v1.2.3",
  RPI_OTA_URI: "https://example.test/stugu-rpi4-1.2.3-ota.tar.zst",
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
  assert.equal(config.artefactName, "stugu-rpi4-1.2.3");
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
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-data-grow.service", import.meta.url), "utf8"),
  ]);

  assert.match(layer, /containerd\.service\.d\/stugu-shared-storage\.conf[\s\S]*Requires=stugu-data-grow\.service var-lib-containerd\.mount/);
  assert.match(layer, /docker\.service\.d\/stugu-shared-storage\.conf[\s\S]*Requires=stugu-data-grow\.service var-lib-docker\.mount var-lib-containerd\.mount/);
  assert.match(growService, /Before=persistent-shared-init\.service containerd\.service docker\.service stugu\.service/);
});

test("the appliance layer and build overrides use the declared Stugu variable prefix", async () => {
  const [layer, buildScript] = await Promise.all([
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../build-rpi-image.sh", import.meta.url), "utf8"),
  ]);

  assert.match(layer, /# X-Env-VarPrefix: stugu/);
  assert.match(layer, /\$\{IGconf_stugu_assetdir\}/);
  assert.match(buildScript, /"IGconf_stugu_api_image=\$api_image"/);
  assert.doesNotMatch(`${layer}\n${buildScript}`, /IGconf_stuga_/);
});

test("local publishing owns expensive builds and hosted release work is an explicit fallback", async () => {
  const [workflow, publisher] = await Promise.all([
    readFile(new URL("../../.github/workflows/rpi-release.yml", import.meta.url), "utf8"),
    readFile(new URL("../publish-local-release.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /confirm_hosted_build:/);
  assert.match(workflow, /if: \$\{\{ inputs\.confirm_hosted_build \}\}/);
  assert.match(workflow, /runs-on: ubuntu-24\.04-arm/);
  assert.doesNotMatch(workflow, /^\s{2}release:\s*$/mu);
  assert.doesNotMatch(workflow, /github\.event\.release/);

  assert.match(publisher, /linux\/amd64,linux\/arm64/);
  assert.match(publisher, /"buildx",\s*\n\s*"build"/);
  assert.match(publisher, /"linux\/amd64"[\s\S]*ARCH: "arm64"/);
  assert.match(publisher, /qemu-user-static/);
  assert.match(publisher, /binfmt_misc\/(?:qemu-)?aarch64/);
  assert.match(publisher, /scripts\/build-rpi-image\.sh/);
  assert.match(publisher, /"release",\s*\n\s*"upload"/);
  assert.match(publisher, /--publish/);
});

test("local release options and output names are deterministic", () => {
  const options = parseArguments([
    "--tag",
    "v1.2.3",
    "--ssh-public-key",
    "recovery.pub",
    "--publish",
    "--reuse-containers",
    "--upload-factory",
  ]);
  assert.equal(options.tag, "v1.2.3");
  assert.equal(options.sshPublicKey, "recovery.pub");
  assert.equal(options.publish, true);
  assert.equal(options.reuseContainers, true);
  assert.equal(options.uploadFactory, true);

  assert.equal(
    repositoryFromRemote("git@github.com:liljestk/open-stuga.git"),
    "liljestk/open-stuga",
  );
  const images = imageDefinitions("ghcr.io/liljestk/open-stuga", "v1.2.3");
  assert.deepEqual(
    images.map(({ target }) => target),
    ["api", "web", "backup", "tapo-export-runner", "update-agent"],
  );
  assert.equal(images[0].ref, "ghcr.io/liljestk/open-stuga-api:v1.2.3");

  const artifacts = artifactDefinitions("/workspace", "1.2.3");
  assert.match(artifacts.ota, /stugu-rpi4-1\.2\.3-ota\.tar\.zst$/);
  assert.match(artifacts.factory, /stugu-rpi4-1\.2\.3\.img\.zst$/);
  assert.notEqual(artifacts.combinedChecksum, artifacts.releaseChecksum);
});

test("the local publisher invokes npm through Node on Windows", () => {
  assert.deepEqual(
    platformInvocation("npm", ["test"], {
      platform: "win32",
      env: { npm_execpath: "C:\\node\\npm-cli.js" },
      execPath: "C:\\node\\node.exe",
    }),
    {
      command: "C:\\node\\node.exe",
      args: ["C:\\node\\npm-cli.js", "test"],
    },
  );
  assert.throws(
    () => platformInvocation("npm", ["test"], { platform: "win32", env: {} }),
    /npm_execpath is required on Windows/,
  );
  assert.deepEqual(
    platformInvocation("npm", ["test"], { platform: "linux" }),
    { command: "npm", args: ["test"] },
  );
});

test("the factory image export uses the portable zstd output option", async () => {
  const buildScript = await readFile(
    new URL("../build-rpi-image.sh", import.meta.url),
    "utf8",
  );

  assert.match(buildScript, /zstd[^\n]+ -o "\$dist_dir\/\$factory_name"/);
  assert.doesNotMatch(buildScript, /--output/);
});

test("the appliance exposes a health-gated migration receiver with rollback", async () => {
  const [control, compose, composeStart, environment, layer] = await Promise.all([
    readFile(new URL("../../deploy/rpi/assets/stuguctl", import.meta.url), "utf8"),
    readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-compose-start", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu.env.example", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
  ]);
  assert.match(control, /migration_tool intent[\s\S]*stugu-backup[\s\S]*stop_application_containers[\s\S]*migration_tool apply/);
  assert.match(control, /migration_tool apply[\s\S]*authorize_pending_health_check[\s\S]*systemctl restart stugu\.service && expected_release_is_healthy[\s\S]*commit_healthy_migration/);
  assert.match(control, /migration_tool commit "\$migration_id" "\$version" "\$healthy_at"/);
  assert.match(control, /resume\)[\s\S]*commit_healthy_migration[\s\S]*systemctl restart stugu\.service/);
  assert.match(control, /grep -Fxq "version=\$expected_version"/);
  assert.match(control, /Target health check failed; rolling back[\s\S]*quiesce_for_migration_rollback[\s\S]*migration_tool rollback/);
  assert.match(control, /current committed data was preserved/);
  assert.match(composeStart, /apply-intent\|applying\|rolling-back/);
  assert.match(composeStart, /applied-pending-health-check/);
  assert.match(composeStart, /health-check-authorization/);
  assert.match(composeStart, /stuguctl migration resume/);
  assert.match(composeStart, /Refusing to start over incomplete migration receipt/);
  assert.match(compose, /stugu-migration:[\s\S]*stugu-migration-target\.mjs/);
  assert.match(compose, /STUGA_MIGRATION_DIRECTORY[^\n]*:\/app\/migrations/);
  assert.match(compose, /stuga-timeseries-data:\/app\/timeseries-data:ro/);
  assert.match(environment, /STUGA_MIGRATION_DIRECTORY=\/persistent\/stugu\/migrations/);
  assert.match(layer, /STUGA_VERSION=\$\{IGconf_artefact_version\}/);
});

test("live cutover fails closed when target state is ambiguous", async () => {
  const controller = await readFile(new URL("../stugu-live-migrate.mjs", import.meta.url), "utf8");
  assert.match(controller, /Source writers remain stopped to prevent split-brain/);
  assert.match(controller, /statusQueried && targetState === "rolled-back"/);
  assert.doesNotMatch(controller, /status\?\.receipt === null/);
  assert.match(controller, /Cutover always creates a fresh snapshot/);
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
