import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chownSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
  validatedReleaseEnvironment,
  validatedRequest,
} from "../stugu-update-agent.mjs";
import { activeServices } from "../stugu-update-agent/services-cloudflare.mjs";
import {
  BACKUP_TIMEOUT_MS,
  UPDATE_TIMEOUT_MS,
  releaseEnvironment as requestReleaseEnvironment,
  releaseEnvironmentOwnership,
  writeTextAtomic,
} from "../stugu-update-agent/configuration-request.mjs";
import {
  applianceUpdateTransition,
  updateJournal,
  updateJournalPath,
  writeUpdateJournal,
} from "../stugu-update-agent/update-loop.mjs";

function updateRequest() {
  const version = "0.6.0";
  return {
    schema: "stugu-system-update-request/v3",
    id: "27974c49-f62e-4365-9ee7-802c7488557e",
    version,
    tagName: `v${version}`,
    repository: "liljestk/open-stuga",
    requestedAt: "2026-07-23T18:00:00.000Z",
    previousVersion: "0.5.0",
    releaseManifestSchema: "stugu-release-manifest/v1",
    compatibility: {
      updateAgent: 3,
      compose: 2,
    },
    images: {
      api: `ghcr.io/liljestk/open-stuga-api:v${version}@sha256:${"a".repeat(64)}`,
      web: `ghcr.io/liljestk/open-stuga-web:v${version}@sha256:${"b".repeat(64)}`,
      backup: `ghcr.io/liljestk/open-stuga-backup:v${version}@sha256:${"c".repeat(64)}`,
      tapo: `ghcr.io/liljestk/open-stuga-tapo-export-runner:v${version}@sha256:${"d".repeat(64)}`,
      updateAgent: `ghcr.io/liljestk/open-stuga-update-agent:v${version}@sha256:${"e".repeat(64)}`,
      mqtt: `ghcr.io/liljestk/open-stuga-mqtt:v${version}@sha256:${"f".repeat(64)}`,
      nexus433: `ghcr.io/liljestk/open-stuga-nexus433:v${version}@sha256:${"0".repeat(64)}`,
    },
  };
}

function releaseEnvironment(version) {
  return [
    "STUGA_RELEASE_ENV_SCHEMA=3",
    "STUGA_UPDATE_AGENT_CONTRACT=3",
    "STUGA_COMPOSE_CONTRACT=2",
    `STUGA_VERSION=${version}`,
    `STUGA_API_IMAGE=ghcr.io/liljestk/open-stuga-api:v${version}@sha256:${"1".repeat(64)}`,
    `STUGA_WEB_IMAGE=ghcr.io/liljestk/open-stuga-web:v${version}@sha256:${"2".repeat(64)}`,
    `STUGA_BACKUP_IMAGE=ghcr.io/liljestk/open-stuga-backup:v${version}@sha256:${"3".repeat(64)}`,
    `STUGA_TAPO_RUNNER_IMAGE=ghcr.io/liljestk/open-stuga-tapo-export-runner:v${version}@sha256:${"4".repeat(64)}`,
    `STUGA_UPDATE_AGENT_IMAGE=ghcr.io/liljestk/open-stuga-update-agent:v${version}@sha256:${"5".repeat(64)}`,
    `STUGA_MQTT_IMAGE=ghcr.io/liljestk/open-stuga-mqtt:v${version}@sha256:${"6".repeat(64)}`,
    `STUGA_NEXUS433_IMAGE=ghcr.io/liljestk/open-stuga-nexus433:v${version}@sha256:${"7".repeat(64)}`,
    "",
  ].join("\n");
}

function legacyReleaseEnvironment(version) {
  return [
    `STUGA_VERSION=${version}`,
    `STUGA_API_IMAGE=ghcr.io/liljestk/open-stuga-api:v${version}`,
    `STUGA_WEB_IMAGE=ghcr.io/liljestk/open-stuga-web:v${version}`,
    `STUGA_BACKUP_IMAGE=ghcr.io/liljestk/open-stuga-backup:v${version}`,
    `STUGA_TAPO_RUNNER_IMAGE=ghcr.io/liljestk/open-stuga-tapo-export-runner:v${version}`,
    `STUGA_UPDATE_AGENT_IMAGE=ghcr.io/liljestk/open-stuga-update-agent:v${version}`,
    "",
  ].join("\n");
}

function assignDistinctDirectoryOwnership(directory) {
  if (process.platform === "win32") return;
  const uid = process.getuid();
  const gid = process.getgid();
  if (uid === 0) {
    chownSync(directory, 12_345, 23_456);
    return;
  }
  const alternateGroup = process.getgroups().find((candidate) => candidate !== gid);
  if (alternateGroup !== undefined) chownSync(directory, uid, alternateGroup);
}

function assertReleaseStateMetadata(path, directory) {
  const file = lstatSync(path);
  const owner = statSync(directory);
  assert.equal(file.isFile(), true);
  if (process.platform === "win32") return;
  assert.equal(file.uid, owner.uid);
  assert.equal(file.gid, owner.gid);
  assert.equal(file.mode & 0o777, 0o640);
}

test("release writes only adopt directory ownership for a privileged updater", () => {
  const directoryMetadata = { uid: 12_345, gid: 23_456 };
  assert.equal(
    releaseEnvironmentOwnership(directoryMetadata, 1_000, "linux"),
    null,
  );
  assert.equal(
    releaseEnvironmentOwnership(directoryMetadata, 0, "win32"),
    null,
  );
  assert.equal(
    releaseEnvironmentOwnership(directoryMetadata, 0, "linux"),
    directoryMetadata,
  );
});

test("atomic writes enforce mode despite umask", {
  skip: process.platform === "win32",
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-atomic-mode-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "release.env");
  const previousUmask = process.umask(0o777);
  try {
    writeTextAtomic(path, "release\n", 0o640);
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(statSync(path).mode & 0o777, 0o640);
});

test("failed atomic writes preserve the target and remove temporary files", {
  skip: process.platform === "win32",
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-atomic-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "release.env");
  writeFileSync(path, "known good\n", "utf8");
  assert.throws(
    () => writeTextAtomic(path, "candidate\n", 0o640, {
      uid: 0x1_0000_0000,
      gid: 0,
    }),
    /uid|range|integer/iu,
  );
  assert.equal(readFileSync(path, "utf8"), "known good\n");
  assert.deepEqual(readdirSync(directory), ["release.env"]);
});

test("atomic open failures do not remove a path the writer never created", () => {
  let removed = false;
  assert.throws(
    () => writeTextAtomic("unused-release.env", "candidate\n", 0o640, null, {
      openSync: () => {
        throw new Error("simulated exclusive-create collision");
      },
      rmSync: () => {
        removed = true;
      },
    }),
    /exclusive-create collision/u,
  );
  assert.equal(removed, false);
});

test("atomic metadata updates stay on the open file during path substitution", {
  skip: process.platform === "win32",
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-atomic-substitution-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "release.env");
  const external = join(directory, "external");
  writeFileSync(external, "external\n", { encoding: "utf8", mode: 0o600 });

  writeTextAtomic(path, "candidate\n", 0o640, null, {
    fchmodSync: (descriptor, mode) => {
      const temporary = readdirSync(directory)
        .map((name) => join(directory, name))
        .find((candidate) => candidate !== external && candidate !== path);
      assert.ok(temporary);
      rmSync(temporary, { force: true });
      symlinkSync(external, temporary);
      fchmodSync(descriptor, mode);
    },
  });

  assert.equal(statSync(external).mode & 0o777, 0o600);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
});

function composeImages(config) {
  const result = spawnSync(
    "docker",
    [...composeArguments(config), "--profile", "maintenance", "config", "--images"],
    {
      cwd: config.projectDirectory,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    `docker compose config failed: ${result.error?.message ?? result.stderr}`,
  );
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function standaloneComposeConfig(directory, args) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      "stugu-nexus-isolation-test",
      "--project-directory",
      directory,
      "--file",
      join(directory, "docker-compose.yml"),
      ...args,
    ],
    { cwd: directory, encoding: "utf8", windowsHide: true },
  );
  assert.equal(
    result.status,
    0,
    `docker compose config failed: ${result.error?.message ?? result.stderr}`,
  );
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

test("disabled source capabilities create and pull no MQTT or Nexus services", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-nexus-isolation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyFileSync(new URL("../../docker-compose.yml", import.meta.url), join(directory, "docker-compose.yml"));

  const services = standaloneComposeConfig(directory, ["config", "--services"]);
  const images = standaloneComposeConfig(directory, ["config", "--images"]);
  assert.equal(services.includes("source-ingress-secrets"), false);
  assert.equal(services.includes("mqtt"), false);
  assert.equal(services.includes("nexus433"), false);
  assert.equal(images.some((image) => image.includes("stugu-mqtt")), false);
  assert.equal(images.some((image) => image.includes("stugu-nexus433")), false);

  const enabledServices = standaloneComposeConfig(directory, [
    "--profile",
    "mqtt",
    "--profile",
    "nexus433",
    "config",
    "--services",
  ]);
  const enabledImages = standaloneComposeConfig(directory, [
    "--profile",
    "mqtt",
    "--profile",
    "nexus433",
    "config",
    "--images",
  ]);
  assert.ok(enabledServices.includes("source-ingress-secrets"));
  assert.ok(enabledServices.includes("mqtt"));
  assert.ok(enabledServices.includes("nexus433"));
  assert.ok(enabledImages.includes("stugu-mqtt:local"));
  assert.ok(enabledImages.includes("stugu-nexus433:local"));
});

function cloudflareSetupRequest() {
  return {
    schema: "stugu-cloudflare-setup-request/v1",
    id: "91576b34-fda0-4b8e-b96f-4265d2ee7f78",
    mode: "stuguby-coordinator",
    command: "provision-coordinator",
    hostname: "stugu.example.com",
    zone: "example.com",
    ownerEmail: "owner@example.com",
    accountId: "0123456789abcdef0123456789abcdef",
    zoneId: "abcdef0123456789abcdef0123456789",
    oauthClientId: "stugu-private-client",
    oauthRedirectUri: "http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback",
    claimSecret: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    requestedAt: "2026-07-24T08:00:00.000Z",
  };
}

test("agent configuration is portable and pins one trusted release namespace", () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-"));
  try {
    const config = readAgentConfig({
      STUGA_PROJECT_DIRECTORY: directory,
      SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
      SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    }, directory);
    assert.equal(config.projectDirectory, directory);
    assert.equal(config.operationsDirectory, join(directory, "data", "update-operations"));
    assert.equal(config.factoryReleaseEnvFile, join(directory, "release.env"));
    assert.equal(config.knownGoodReleaseEnvFile, join(directory, ".stugu-known-good.env"));
    assert.equal(config.releaseEnvFile, join(directory, ".stugu-release.env"));
    assert.equal(config.composeProfileEnvironmentFile, join(directory, ".env"));
    assert.equal(config.runtime, "docker");
    assert.equal(config.hostUpdateJournal, null);
    assert.equal(config.composeProjectName, null);
    assert.equal(composeArguments(config).includes("--project-name"), false);

    const named = readAgentConfig({
      STUGA_COMPOSE_PROJECT_NAME: "stuga",
      STUGA_CLOUDFLARE_SECRET_DIR: join(directory, "host-cloudflare"),
      STUGA_PROJECT_DIRECTORY: directory,
      STUGA_UPDATE_CLOUDFLARE_SECRET_DIR: join(directory, "agent-cloudflare"),
      STUGA_UPDATE_PROFILE_ENV_FILE: join(directory, "persistent.env"),
    }, directory, []);
    assert.deepEqual(composeArguments(named).slice(0, 3), ["compose", "--project-name", "stuga"]);
    assert.equal(named.cloudflareSecretDirectory, join(directory, "agent-cloudflare"));
    assert.equal(named.composeProfileEnvironmentFile, join(directory, "persistent.env"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("containerized updater preserves host paths for nested Compose", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const service = compose.slice(
    compose.indexOf("  stugu-update-agent:"),
    compose.indexOf("  tapo-export-runner:"),
  );

  assert.match(
    service,
    /STUGA_UPDATE_CLOUDFLARE_SECRET_DIR: \/persistent\/stugu\/secrets\/cloudflare/u,
  );
  assert.doesNotMatch(service, /^\s+STUGA_CLOUDFLARE_SECRET_DIR:/mu);
  assert.ok(service.includes(
    "${STUGA_CLOUDFLARE_SECRET_DIR:-./secrets/cloudflare}:/persistent/stugu/secrets/cloudflare:z",
  ));
  assert.ok(service.includes(
    "${STUGA_MIGRATION_SETTINGS_DIRECTORY:-.}:/persistent/stugu/settings:z",
  ));
  assert.ok(service.includes(
    "STUGA_UPDATE_PROFILE_ENV_FILE: /persistent/stugu/settings/${STUGA_MIGRATION_ENV_FILENAME:-.env}",
  ));
  assert.ok(service.includes(
    "${STUGA_HOST_UPDATE_DIRECTORY:-./data/host-update}:/persistent/stugu/host-update:ro,z",
  ));
  assert.match(service, /STUGA_HOST_UPDATE_JOURNAL: \/persistent\/stugu\/host-update\/journal\.json/u);
});

test("system updates include only optional release services that are already running", async () => {
  const services = await activeServices({}, async (_config, args) => {
    assert.deepEqual(args, ["ps", "--services", "--filter", "status=running"]);
    return "api\nweb\nstugu-backup-scheduler\nstugu-r2-backup\nmqtt\nnexus433\n";
  });
  assert.deepEqual(services, [
    "api",
    "web",
    "stugu-backup-scheduler",
    "stugu-r2-backup",
    "mqtt",
    "nexus433",
  ]);
});

test("agent resolves service arguments and relative paths from the project directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-service-"));
  try {
    const config = readAgentConfig({
      STUGA_RELEASE_ENV_FILE: "./runtime/release.env",
      STUGA_FACTORY_RELEASE_ENV_FILE: "./runtime/factory.env",
      STUGA_KNOWN_GOOD_RELEASE_ENV_FILE: "./runtime/known-good.env",
      SYSTEM_UPDATE_OPERATIONS_DIRECTORY: "./runtime/operations",
    }, tmpdir(), [`--project-directory=${directory}`, "--once"]);

    assert.equal(config.projectDirectory, directory);
    assert.equal(config.operationsDirectory, join(directory, "runtime", "operations"));
    assert.equal(config.factoryReleaseEnvFile, join(directory, "runtime", "factory.env"));
    assert.equal(config.knownGoodReleaseEnvFile, join(directory, "runtime", "known-good.env"));
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
      images: {
        ...request.images,
        api: `ghcr.io/attacker/replacement:v0.6.0@sha256:${"a".repeat(64)}`,
      },
    }, config),
    /trusted image namespace/,
  );
  assert.throws(
    () => validatedRequest({
      ...request,
      images: {
        ...request.images,
        api: "ghcr.io/liljestk/open-stuga-api:v0.6.0",
      },
    }, config),
    /immutable digest/,
  );
});

test("agent accepts only an exact trusted legacy release environment as rollback input", () => {
  const config = readAgentConfig({
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
  });
  const legacy = legacyReleaseEnvironment("0.5.0");
  assert.deepEqual(
    validatedReleaseEnvironment(legacy, config),
    {
      format: "legacy-v1",
      version: "0.5.0",
      compatibility: null,
      images: {
        api: "ghcr.io/liljestk/open-stuga-api:v0.5.0",
        web: "ghcr.io/liljestk/open-stuga-web:v0.5.0",
        backup: "ghcr.io/liljestk/open-stuga-backup:v0.5.0",
        tapo: "ghcr.io/liljestk/open-stuga-tapo-export-runner:v0.5.0",
        updateAgent: "ghcr.io/liljestk/open-stuga-update-agent:v0.5.0",
      },
    },
  );
  assert.throws(
    () => validatedReleaseEnvironment(`${legacy}UNEXPECTED=value\n`, config),
    /supported release environment schema/,
  );
  assert.throws(
    () => validatedReleaseEnvironment(
      legacy.replace(
        "ghcr.io/liljestk/open-stuga-api:v0.5.0",
        "ghcr.io/attacker/open-stuga-api:v0.5.0",
      ),
      config,
    ),
    /untrusted legacy image reference/,
  );
});

test("agent validates the bounded Cloudflare setup handoff", () => {
  const request = cloudflareSetupRequest();
  assert.equal(validatedCloudflareSetupRequest(request).hostname, "stugu.example.com");
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
  const directory = mkdtempSync(join(tmpdir(), "stugu-cloudflare-agent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const profileEnvironment = join(directory, "stugu.env");
  writeFileSync(
    profileEnvironment,
    "# Persistent appliance profiles\nCOMPOSE_PROFILES=self-update,r2-backup\n",
    "utf8",
  );
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    STUGA_CLOUDFLARE_SECRET_DIR: join(directory, "cloudflare"),
    STUGA_UPDATE_PROFILE_ENV_FILE: profileEnvironment,
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
  }, directory, []);
  const request = cloudflareSetupRequest();
  const requestPath = join(operationsDirectory, "cloudflare-request-test.json");
  const overridePath = join(
    operationsDirectory,
    `cloudflare-provisional-${request.id}.compose.yml`,
  );
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  const composeCalls = [];
  const provisionCalls = [];
  const revokeCalls = [];
  const events = [];
  let overrideText = null;
  let verified = 0;

  await applyCloudflareSetupRequest(config, requestPath, {
    claim: async () => {
      events.push("claim");
      return {
        provisionToken: "temporary-oauth-provision-token-that-is-long-enough",
        accessToken: "runtime-access-group-token-that-is-long-enough",
        oauthClientId: "stugu-private-client",
      };
    },
    provisioner: async (...args) => {
      events.push("provision");
      provisionCalls.push(args);
    },
    compose: async (_config, args) => {
      composeCalls.push(args);
      const provisional = args[0] === "--file";
      const command = provisional ? args[2] : args[0];
      const service = args.at(-1);
      events.push(
        provisional && command === "up" && args.includes("--no-start")
          ? "compose:provisional-create"
          : command === "up"
          ? `compose:${service === "cloudflared" ? "regular" : "application"}-up`
          : `compose:${provisional ? "provisional-" : ""}${command}`,
      );
      if (provisional && command === "up" && args.includes("--no-start")) {
        assert.equal(args[1], overridePath);
        overrideText = readFileSync(overridePath, "utf8");
      }
      if (!provisional && command === "up" && service === "cloudflared") {
        assert.match(readFileSync(profileEnvironment, "utf8"), /cloudflare/u);
      }
      return "";
    },
    verifyCoordinator: async () => {
      assert.equal(
        readFileSync(profileEnvironment, "utf8").includes("cloudflare"),
        false,
      );
      assert.equal(existsSync(requestPath), true);
      events.push("verify");
      verified += 1;
    },
    revoke: async (value) => {
      events.push("revoke");
      revokeCalls.push(value);
    },
    waitForRetry: async () => undefined,
  });

  assert.equal(provisionCalls.length, 1);
  assert.equal(provisionCalls[0][0].command, "provision-coordinator");
  assert.equal(provisionCalls[0][1].provisionToken, "temporary-oauth-provision-token-that-is-long-enough");
  assert.equal(verified, 1);
  assert.deepEqual(revokeCalls, [{
    accessToken: "temporary-oauth-provision-token-that-is-long-enough",
    clientId: "stugu-private-client",
  }]);
  assert.equal(composeCalls.length, 8);
  assert.deepEqual(events, [
    "compose:stop",
    "compose:rm",
    "claim",
    "provision",
    "compose:application-up",
    "compose:provisional-create",
    "compose:provisional-start",
    "verify",
    "compose:provisional-stop",
    "compose:provisional-rm",
    "compose:regular-up",
    "revoke",
  ]);
  assert.equal(
    overrideText,
    "services:\n  cloudflared:\n    restart: \"no\"\n",
  );
  const statusText = readFileSync(join(operationsDirectory, "cloudflare-status.json"), "utf8");
  const status = JSON.parse(statusText);
  assert.equal(status.phase, "complete");
  assert.equal(statusText.includes("temporary-oauth-provision-token"), false);
  assert.equal(statusText.includes("runtime-access-group-token"), false);
  assert.equal(existsSync(requestPath), false);
  assert.equal(existsSync(overridePath), false);
  assert.match(
    readFileSync(profileEnvironment, "utf8"),
    /^COMPOSE_PROFILES=self-update,r2-backup,cloudflare$/mu,
  );
});

test("agent closes public ingress and still revokes approval after failed verification", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-cloudflare-agent-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const cloudflareDirectory = join(directory, "cloudflare");
  const profileEnvironment = join(directory, "stugu.env");
  writeFileSync(
    profileEnvironment,
    "COMPOSE_PROFILES=self-update,cloudflare\n",
    "utf8",
  );
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    STUGA_CLOUDFLARE_SECRET_DIR: cloudflareDirectory,
    STUGA_UPDATE_PROFILE_ENV_FILE: profileEnvironment,
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
  }, directory, []);
  const request = cloudflareSetupRequest();
  const requestPath = join(operationsDirectory, "cloudflare-request-test.json");
  const overridePath = join(
    operationsDirectory,
    `cloudflare-provisional-${request.id}.compose.yml`,
  );
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  const composeCalls = [];
  let overrideText = null;
  let revoked = 0;

  await applyCloudflareSetupRequest(config, requestPath, {
    claim: async () => ({
      provisionToken: "temporary-oauth-provision-token-that-is-long-enough",
      accessToken: "runtime-access-group-token-that-is-long-enough",
      oauthClientId: "stugu-private-client",
    }),
    provisioner: async () => {
      mkdirSync(cloudflareDirectory);
      writeFileSync(join(cloudflareDirectory, "deployment.json"), "{}\n", "utf8");
    },
    compose: async (_config, args) => {
      composeCalls.push(args);
      if (args[0] === "--file"
        && args[2] === "up"
        && args.includes("--no-start")) {
        assert.equal(args[1], overridePath);
        overrideText = readFileSync(overridePath, "utf8");
      }
      return "";
    },
    verifyCoordinator: async () => { throw new Error("protected route remained open"); },
    revoke: async () => { revoked += 1; },
    waitForRetry: async () => undefined,
  });

  const status = JSON.parse(readFileSync(join(operationsDirectory, "cloudflare-status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.match(status.detail, /protected route remained open/);
  assert.deepEqual(composeCalls.slice(0, 2), [
    ["stop", "cloudflared"],
    ["rm", "--force", "--stop", "cloudflared"],
  ]);
  assert.deepEqual(composeCalls.slice(-2), [
    ["stop", "cloudflared"],
    ["rm", "--force", "--stop", "cloudflared"],
  ]);
  assert.equal(
    composeCalls.some((args) => args[0] === "up" && args.at(-1) === "cloudflared"),
    false,
  );
  assert.equal(
    overrideText,
    "services:\n  cloudflared:\n    restart: \"no\"\n",
  );
  assert.equal(revoked, 1);
  assert.equal(existsSync(requestPath), false);
  assert.equal(existsSync(overridePath), false);
  assert.equal(existsSync(join(cloudflareDirectory, "deployment.json")), true);
  assert.equal(
    readFileSync(profileEnvironment, "utf8"),
    "COMPOSE_PROFILES=self-update\n",
  );
});

test("pending Cloudflare request re-entry closes stale ingress before reclaiming", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-cloudflare-reentry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const profileEnvironment = join(directory, "stugu.env");
  writeFileSync(profileEnvironment, "COMPOSE_PROFILES=self-update,cloudflare\n", "utf8");
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    STUGA_UPDATE_PROFILE_ENV_FILE: profileEnvironment,
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
  }, directory, []);
  const request = cloudflareSetupRequest();
  const requestPath = join(operationsDirectory, "cloudflare-request-test.json");
  const overridePath = join(
    operationsDirectory,
    `cloudflare-provisional-${request.id}.compose.yml`,
  );
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  writeFileSync(overridePath, "stale provisional state\n", "utf8");
  const composeCalls = [];
  let claimed = 0;

  await applyCloudflareSetupRequest(config, requestPath, {
    claim: async () => {
      claimed += 1;
      assert.deepEqual(composeCalls, [
        ["stop", "cloudflared"],
        ["rm", "--force", "--stop", "cloudflared"],
      ]);
      assert.equal(
        readFileSync(profileEnvironment, "utf8"),
        "COMPOSE_PROFILES=self-update\n",
      );
      assert.equal(existsSync(requestPath), true);
      throw new Error("the prior in-memory claim was already consumed");
    },
    compose: async (_config, args) => {
      composeCalls.push(args);
      return "";
    },
    provisioner: async () => assert.fail("re-entry must not provision without a claim"),
    revoke: async () => assert.fail("re-entry has no claimed token to revoke"),
  });

  assert.equal(claimed, 1);
  assert.deepEqual(composeCalls.slice(-2), [
    ["stop", "cloudflared"],
    ["rm", "--force", "--stop", "cloudflared"],
  ]);
  assert.equal(existsSync(requestPath), false);
  assert.equal(existsSync(overridePath), false);
  assert.equal(
    readFileSync(profileEnvironment, "utf8"),
    "COMPOSE_PROFILES=self-update\n",
  );
});

test("dependency-free pre-update backup failures remain fail-closed before release mutation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-preflight-"));
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
  writeFileSync(config.factoryReleaseEnvFile, releaseEnvironment("0.5.0"), "utf8");
  writeFileSync(requestPath, JSON.stringify(updateRequest()), "utf8");
  const calls = [];

  await applyRequest(config, requestPath, {
    compose: async (_config, args) => {
      calls.push(args);
      if (args[0] === "ps") return "api\nweb\nstugu-backup-scheduler";
      if (args[0] === "exec") return "0.5.0";
      if (args.includes("stugu-backup")) throw new Error("simulated backup failure");
      throw new Error(`Unexpected Compose call: ${args.join(" ")}`);
    },
  });

  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.equal(status.detail, "simulated backup failure");
  assert.deepEqual(status.activity.map((entry) => entry.phase), ["queued", "preparing", "backup", "failed"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["ps", "--services", "--filter", "status=running"]);
  assert.deepEqual(calls[1].slice(0, 3), ["exec", "-T", "api"]);
  assert.deepEqual(
    calls[2],
    ["--profile", "maintenance", "run", "--rm", "--no-deps", "stugu-backup"],
  );
  assert.equal(calls.some((args) => args[0] === "up"), false);
  assert.equal(existsSync(config.releaseEnvFile), false);
  assert.equal(existsSync(requestPath), false);
});

test("restart after candidate mutation rolls back from the durable update journal", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-journal-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  const request = updateRequest();
  const requestPath = join(operationsDirectory, "request-interrupted.json");
  const previousRelease = releaseEnvironment(request.previousVersion);
  writeFileSync(config.factoryReleaseEnvFile, previousRelease, "utf8");
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  writeUpdateJournal(
    config,
    updateJournal(
      config,
      validatedRequest(request, config),
      requestPath,
      previousRelease,
      ["api", "web"],
    ),
  );
  writeFileSync(config.releaseEnvFile, requestReleaseEnvironment(request), "utf8");
  const calls = [];

  await applyRequest(config, requestPath, {
    compose: async (_config, args) => {
      calls.push(args);
      assert.equal(readFileSync(config.releaseEnvFile, "utf8"), previousRelease);
      return "";
    },
  });

  assert.deepEqual(calls, [[
    "up", "--detach", "--no-deps", "--wait", "--wait-timeout", "600", "api", "web",
  ]]);
  assert.equal(readFileSync(config.releaseEnvFile, "utf8"), previousRelease);
  assert.equal(existsSync(requestPath), false);
  assert.equal(existsSync(updateJournalPath(config)), false);
  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.match(status.detail, /Previous release restored/u);
});

test("restart after verification commits from the journal even after request cleanup", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-journal-verify-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  const request = updateRequest();
  const requestPath = join(operationsDirectory, "request-verified.json");
  const previousRelease = releaseEnvironment(request.previousVersion);
  const candidateRelease = requestReleaseEnvironment(request);
  writeFileSync(config.factoryReleaseEnvFile, previousRelease, "utf8");
  writeFileSync(config.releaseEnvFile, candidateRelease, "utf8");
  writeUpdateJournal(
    config,
    updateJournal(
      config,
      validatedRequest(request, config),
      requestPath,
      previousRelease,
      ["api", "web"],
      "verified",
    ),
  );
  const calls = [];

  await applyRequest(config, null, {
    compose: async (_config, args) => {
      calls.push(args);
      return args[0] === "exec" ? request.version : "";
    },
  });

  assert.equal(calls[0][0], "up");
  assert.equal(calls[1][0], "exec");
  assert.equal(readFileSync(config.knownGoodReleaseEnvFile, "utf8"), candidateRelease);
  assert.equal(existsSync(updateJournalPath(config)), false);
  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(status.phase, "complete");
});

for (const timedOutMutation of ["backup", "candidate-pull"]) {
for (const processTreeTerminated of [false, true]) {
test(`${timedOutMutation} timeout blocks rollback across agent restarts when process tree termination is ${processTreeTerminated ? "confirmed" : "unconfirmed"}`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), `stugu-update-agent-${timedOutMutation}-timeout-${processTreeTerminated}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  const request = updateRequest();
  const requestPath = join(operationsDirectory, "request-timeout.json");
  writeFileSync(config.factoryReleaseEnvFile, releaseEnvironment(request.previousVersion), "utf8");
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  let activeMutation = null;

  await applyRequest(config, requestPath, {
    compose: async (_config, args) => {
      if (args[0] === "ps") return "api\nweb";
      if (args[0] === "exec") return request.previousVersion;
      if (args.includes("stugu-backup") && timedOutMutation !== "backup") return "";
      if (args.includes("stugu-backup") || args[0] === "pull") {
        activeMutation = JSON.parse(readFileSync(updateJournalPath(config), "utf8"));
        const error = new Error("simulated mutator timeout");
        error.code = "COMMAND_TIMEOUT";
        error.processTreeTerminated = processTreeTerminated;
        throw error;
      }
      assert.fail(`Unexpected Compose call: ${args.join(" ")}`);
    },
  });

  const journalPath = updateJournalPath(config);
  assert.equal(activeMutation?.phase, "mutation-active");
  assert.equal(activeMutation?.mutation, timedOutMutation);
  assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).phase, "termination-uncertain");
  assert.equal(existsSync(requestPath), true);
  if (timedOutMutation === "candidate-pull") {
    assert.equal(readFileSync(config.releaseEnvFile, "utf8"), requestReleaseEnvironment(request));
  } else {
    assert.equal(existsSync(config.releaseEnvFile), false);
  }

  let retriedCompose = false;
  await applyRequest(config, null, {
    compose: async () => {
      retriedCompose = true;
      assert.fail("blocked recovery must not mutate Compose state");
    },
  });

  assert.equal(retriedCompose, false);
  assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).phase, "termination-uncertain");
  assert.equal(existsSync(requestPath), true);
  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.match(status.detail, /remains blocked/u);
});
}
}

test("Docker transition restores the exact legacy six-line release after candidate failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-legacy-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const releaseDirectory = join(directory, "release-state");
  mkdirSync(releaseDirectory);
  assignDistinctDirectoryOwnership(releaseDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    STUGA_KNOWN_GOOD_RELEASE_ENV_FILE: join(releaseDirectory, "known-good.env"),
    STUGA_RELEASE_ENV_FILE: join(releaseDirectory, "release.env"),
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  const legacyRelease = legacyReleaseEnvironment("0.5.0");
  writeFileSync(config.factoryReleaseEnvFile, legacyRelease, "utf8");
  const requestPath = join(operationsDirectory, "request-legacy-transition.json");
  writeFileSync(requestPath, JSON.stringify(updateRequest()), "utf8");
  let starts = 0;
  let rollbackRelease = null;
  const persistedMutations = [];

  await applyRequest(config, requestPath, {
    compose: async (_config, args) => {
      if (args[0] === "ps") return "api\nweb\nstugu-backup-scheduler";
      if (args[0] === "exec") return "0.5.0";
      if (args.includes("stugu-backup") || args[0] === "pull") return "";
      if (args[0] === "up") {
        starts += 1;
        persistedMutations.push(JSON.parse(readFileSync(updateJournalPath(config), "utf8")));
        if (starts === 1) throw new Error("simulated candidate health failure");
        rollbackRelease = readFileSync(config.releaseEnvFile, "utf8");
        return "";
      }
      throw new Error(`Unexpected Compose call: ${args.join(" ")}`);
    },
  });

  assert.equal(starts, 2);
  assert.deepEqual(
    persistedMutations.map(({ phase, mutation }) => ({ phase, mutation })),
    [
      { phase: "mutation-active", mutation: "candidate-start" },
      { phase: "mutation-active", mutation: "rollback" },
    ],
  );
  assert.equal(rollbackRelease, legacyRelease);
  assert.equal(readFileSync(config.releaseEnvFile, "utf8"), legacyRelease);
  assertReleaseStateMetadata(config.releaseEnvFile, releaseDirectory);
  assert.deepEqual(readdirSync(releaseDirectory), ["release.env"]);
  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.match(status.detail, /Previous release restored/);
});

test("legacy Raspberry Pi state requires a factory transition before any update mutation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-legacy-pi-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
    SYSTEM_UPDATE_RUNTIME: "raspberry-pi",
  }, directory, []);
  writeFileSync(config.factoryReleaseEnvFile, legacyReleaseEnvironment("0.5.0"), "utf8");
  const requestPath = join(operationsDirectory, "request-legacy-pi.json");
  writeFileSync(requestPath, JSON.stringify(updateRequest()), "utf8");

  const transition = applianceUpdateTransition(config);
  assert.equal(transition?.reason, "appliance-upgrade-required");
  assert.match(transition?.detail ?? "", /factory image with updater contract 3/);
  let composeCalled = false;
  await applyRequest(config, requestPath, {
    compose: async () => {
      composeCalled = true;
      throw new Error("Compose must not run for a legacy appliance");
    },
  });

  assert.equal(composeCalled, false);
  assert.equal(existsSync(config.releaseEnvFile), false);
  assert.equal(existsSync(requestPath), false);
  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.match(status.detail, /factory image with updater contract 3/);
  assert.deepEqual(status.activity.map((entry) => entry.phase), ["queued", "preparing", "failed"]);
});

test("agent publishes a durable step-by-step activity trail", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-progress-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const releaseDirectory = join(directory, "release-state");
  mkdirSync(releaseDirectory);
  assignDistinctDirectoryOwnership(releaseDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    STUGA_KNOWN_GOOD_RELEASE_ENV_FILE: join(releaseDirectory, "known-good.env"),
    STUGA_RELEASE_ENV_FILE: join(releaseDirectory, "release.env"),
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  const requestPath = join(operationsDirectory, "request-test.json");
  writeFileSync(config.factoryReleaseEnvFile, releaseEnvironment("0.5.0"), "utf8");
  writeFileSync(requestPath, JSON.stringify(updateRequest()), "utf8");
  let versionChecks = 0;
  const commandTimeouts = [];

  await applyRequest(config, requestPath, {
    compose: async (_config, args, timeoutMs) => {
      commandTimeouts.push({ args, timeoutMs });
      if (args[0] === "ps") return "api\nweb\nstugu-backup-scheduler";
      if (args[0] === "exec") {
        versionChecks += 1;
        return versionChecks === 1 ? "0.5.0" : "0.6.0";
      }
      return "";
    },
  });

  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(BACKUP_TIMEOUT_MS, 24 * 60 * 60_000);
  assert.equal(UPDATE_TIMEOUT_MS, 45 * 60_000);
  assert.equal(commandTimeouts.find(({ args }) => args.includes("stugu-backup")).timeoutMs, BACKUP_TIMEOUT_MS);
  const containerMutations = commandTimeouts.filter(({ args }) => ["pull", "up"].includes(args[0]));
  assert.equal(containerMutations.length, 2);
  assert.ok(containerMutations.every(({ timeoutMs }) => timeoutMs === undefined));
  assert.equal(commandTimeouts.filter(({ timeoutMs }) => timeoutMs === BACKUP_TIMEOUT_MS).length, 1);
  assert.equal(status.phase, "complete");
  assert.equal(status.updatedAt, status.phaseStartedAt);
  assert.deepEqual(
    status.activity.map((entry) => entry.phase),
    ["queued", "preparing", "backup", "pulling", "applying", "verifying", "complete"],
  );
  assert.equal(
    readFileSync(config.knownGoodReleaseEnvFile, "utf8").includes(updateRequest().images.api),
    true,
  );
  assertReleaseStateMetadata(config.releaseEnvFile, releaseDirectory);
  assertReleaseStateMetadata(config.knownGoodReleaseEnvFile, releaseDirectory);
  assert.deepEqual(
    readdirSync(releaseDirectory).sort(),
    ["known-good.env", "release.env"],
  );
  assert.equal(existsSync(requestPath), false);
});

test("first update backup and rollback interpolate the immutable factory release", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-compose-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyFileSync(new URL("../../docker-compose.yml", import.meta.url), join(directory, "docker-compose.yml"));
  const operationsDirectory = join(directory, "operations");
  mkdirSync(operationsDirectory);
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  const factoryRelease = releaseEnvironment("0.5.0");
  writeFileSync(config.factoryReleaseEnvFile, factoryRelease, "utf8");
  const requestPath = join(operationsDirectory, "request-first-update.json");
  writeFileSync(requestPath, JSON.stringify(updateRequest()), "utf8");
  const snapshots = {
    backup: [],
    candidate: [],
    starts: [],
  };

  await applyRequest(config, requestPath, {
    compose: async (_config, args) => {
      if (args[0] === "ps") return "api\nweb\nstugu-backup-scheduler";
      if (args[0] === "exec") return "0.5.0";
      if (args.includes("stugu-backup")) {
        snapshots.backup = composeImages(config);
        return "";
      }
      if (args[0] === "pull") {
        snapshots.candidate = composeImages(config);
        return "";
      }
      if (args[0] === "up") {
        snapshots.starts.push(composeImages(config));
        if (snapshots.starts.length === 1) throw new Error("simulated candidate health failure");
        return "";
      }
      throw new Error(`Unexpected Compose call: ${args.join(" ")}`);
    },
  });

  assert.ok(snapshots.backup.includes(
    `ghcr.io/liljestk/open-stuga-backup:v0.5.0@sha256:${"3".repeat(64)}`,
  ));
  assert.ok(snapshots.candidate.includes(updateRequest().images.api));
  assert.ok(snapshots.starts[0].includes(updateRequest().images.web));
  assert.ok(snapshots.starts[1].includes(
    `ghcr.io/liljestk/open-stuga-api:v0.5.0@sha256:${"1".repeat(64)}`,
  ));
  assert.equal(readFileSync(config.releaseEnvFile, "utf8"), factoryRelease);
  const status = JSON.parse(readFileSync(join(operationsDirectory, "status.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.match(status.detail, /Previous release restored/);
});

test("real Compose interpolation layers known-good refs over factory refs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-update-agent-known-good-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyFileSync(new URL("../../docker-compose.yml", import.meta.url), join(directory, "docker-compose.yml"));
  const config = readAgentConfig({
    STUGA_PROJECT_DIRECTORY: directory,
    SYSTEM_UPDATE_IMAGE_PREFIX: "ghcr.io/liljestk/open-stuga",
    SYSTEM_UPDATE_REPOSITORY: "liljestk/open-stuga",
  }, directory, []);
  writeFileSync(config.factoryReleaseEnvFile, releaseEnvironment("0.4.0"), "utf8");
  writeFileSync(config.knownGoodReleaseEnvFile, releaseEnvironment("0.5.0"), "utf8");

  const images = composeImages(config);
  assert.ok(images.includes(
    `ghcr.io/liljestk/open-stuga-api:v0.5.0@sha256:${"1".repeat(64)}`,
  ));
  assert.equal(images.some((image) => image.includes(":v0.4.0@sha256:")), false);
});

test("agent rejects malformed repository and registry configuration", () => {
  assert.throws(() => readAgentConfig({ SYSTEM_UPDATE_REPOSITORY: "https://github.com/example/repo" }), /owner\/repository/);
  assert.throws(() => readAgentConfig({
    SYSTEM_UPDATE_REPOSITORY: "example/repo",
    SYSTEM_UPDATE_IMAGE_PREFIX: "docker.io/example/repo",
  }), /GHCR/);
  assert.throws(() => readAgentConfig({ SYSTEM_UPDATE_RUNTIME: "windows" }), /docker or raspberry-pi/);
});
