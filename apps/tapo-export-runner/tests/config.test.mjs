import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateDeploymentFingerprint, loadConfig } from "../dist/config.js";

const flowPath = fileURLToPath(new URL("../flow.example.json", import.meta.url));

const enabledSafety = {
  TAPO_TARGET_LOCK_ID: "tapo-phone-helsinki-01",
  TAPO_APPIUM_LOGS_HARDENED: "true",
  TAPO_UIAUTOMATOR2_VERSION: "3.1.0",
  TAPO_APPIUM_VERSION: "2.18.0",
  TAPO_APP_VERSION: "3.14.110",
  TAPO_DEDICATED_ACCOUNT: "true",
  TAPO_APPIUM_CAPABILITIES_JSON: '{"platformName":"Android","appium:automationName":"UiAutomator2","appium:platformVersion":"15","appium:language":"en","appium:locale":"US","appium:udid":"emulator-5554"}',
};
const accountProof = `account-proof-${"p".repeat(32)}`;
const preauthenticatedSafety = { ...enabledSafety, TAPO_ACCOUNT_PROOF: accountProof };

test("is safely disabled with no environment", () => {
  const config = loadConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.apiPrefix, "/api/v1/internal/tapo-history");
  assert.equal(config.keepSessionOnShutdown, true);
  assert.equal(config.appiumCapabilities["appium:noReset"], true);
});

test("requires API auth, flow config, and mailbox when enabled", () => {
  assert.throws(() => loadConfig({ TAPO_RUNNER_ENABLED: "true" }), /WORKER_TOKEN is required/u);
  assert.throws(
    () => loadConfig({ TAPO_RUNNER_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: "x".repeat(32) }),
    /FLOW_CONFIG is required/u,
  );
  assert.throws(
    () => loadConfig({
      TAPO_RUNNER_ENABLED: "true",
      TAPO_HISTORY_WORKER_TOKEN: "x".repeat(32),
      TAPO_RUNNER_FLOW_CONFIG: flowPath,
    }),
    /EXPORT_EMAIL is required/u,
  );
});

test("parses an enabled worker without exposing account credentials in defaults", () => {
  const config = loadConfig({
    TAPO_RUNNER_ENABLED: "1",
    TAPO_HISTORY_WORKER_TOKEN: ` ${"internal-token".padEnd(32, "x")} `,
    TAPO_RUNNER_FLOW_CONFIG: flowPath,
    TAPO_EXPORT_EMAIL: "exports@example.com",
    TAPO_ACCOUNT_EMAIL: "user@example.com",
    TAPO_ACCOUNT_PASSWORD: "secret",
    TAPO_RUNNER_API_PREFIX: "internal/jobs/",
    TAPO_RUNNER_POLL_MS: "2500",
    ...enabledSafety,
  });
  assert.equal(config.enabled, true);
  assert.equal(config.apiToken, "internal-token".padEnd(32, "x"));
  assert.equal(config.apiPrefix, "/internal/jobs");
  assert.equal(config.pollIntervalMs, 2500);
  assert.match(config.workerLabel, /-tapo-export$/u);
  assert.match(config.workerId, /^tapo-target-[a-f0-9]{24}$/u);
  assert.equal(config.tapoUsername, "user@example.com");
  assert.equal(config.tapoPassword, "secret");
  assert.equal(config.appiumCapabilities["appium:udid"], "emulator-5554");
  assert.match(config.deploymentFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(config.tapoAppVersion, "3.14.110");
  assert.equal(config.appiumVersion, "2.18.0");
  assert.match(config.flowConfigSource, /CHANGE_ME/u);
});

test("rejects unsafe or ambiguous scalar configuration", () => {
  assert.throws(() => loadConfig({ TAPO_RUNNER_ENABLED: "yes" }), /must be true/u);
  assert.throws(() => loadConfig({ TAPO_RUNNER_POLL_MS: "12.5" }), /must be an integer/u);
  assert.throws(() => loadConfig({ TAPO_APPIUM_URL: "file:///tmp/socket" }), /HTTP or HTTPS/u);
  assert.throws(() => loadConfig({ TAPO_APPIUM_URL: "http://remote.example:4723" }), /must use HTTPS/u);
  assert.throws(() => loadConfig({ STUGA_API_URL: "http://remote.example:8787" }), /must use HTTPS/u);
  assert.throws(() => loadConfig({ TAPO_APPIUM_CAPABILITIES_JSON: "[]" }), /JSON object/u);
  assert.throws(() => loadConfig({
    TAPO_HISTORY_WORKER_TOKEN: "x".repeat(32), TAPO_HISTORY_WORKER_TOKEN_FILE: "secret.txt",
  }), /Configure only one/u);
  assert.throws(() => loadConfig({
    TAPO_RUNNER_ENABLED: "true",
    TAPO_HISTORY_WORKER_TOKEN: "replace-with-a-long-random-token",
    TAPO_RUNNER_FLOW_CONFIG: flowPath,
    TAPO_EXPORT_EMAIL: "exports@example.com",
    TAPO_APPIUM_LOGS_HARDENED: "true",
    TAPO_TARGET_LOCK_ID: "tapo-phone-helsinki-01",
    TAPO_UIAUTOMATOR2_VERSION: "3.1.0",
    TAPO_DEDICATED_ACCOUNT: "true",
    TAPO_APPIUM_CAPABILITIES_JSON: '{"platformName":"Android","appium:automationName":"UiAutomator2","appium:platformVersion":"15","appium:language":"en","appium:locale":"US","appium:udid":"emulator-5554"}',
  }), /placeholder is forbidden/u);
  assert.throws(() => loadConfig({
    TAPO_RUNNER_ENABLED: "true",
    TAPO_HISTORY_WORKER_TOKEN: "x".repeat(32),
    TAPO_RUNNER_FLOW_CONFIG: flowPath,
    TAPO_EXPORT_EMAIL: "exports@example.com",
    TAPO_TARGET_LOCK_ID: "tapo-phone-helsinki-01",
    TAPO_APPIUM_CAPABILITIES_JSON: enabledSafety.TAPO_APPIUM_CAPABILITIES_JSON,
  }), /LOGS_HARDENED/u);
});

test("uses a stable physical-target lock across Appium endpoint aliases", () => {
  const base = {
    TAPO_RUNNER_ENABLED: "true",
    TAPO_HISTORY_WORKER_TOKEN: "x".repeat(32),
    TAPO_RUNNER_FLOW_CONFIG: flowPath,
    TAPO_EXPORT_EMAIL: "exports@example.com",
    ...preauthenticatedSafety,
  };
  const first = loadConfig({ ...base, TAPO_APPIUM_URL: "http://appium:4723" });
  const second = loadConfig({ ...base, TAPO_APPIUM_URL: "https://appium.internal.example:4723" });
  assert.equal(first.workerId, second.workerId);
  assert.throws(() => loadConfig({ ...base, TAPO_TARGET_LOCK_ID: "" }), /TARGET_LOCK_ID/u);
  assert.throws(() => loadConfig({ ...base, TAPO_UIAUTOMATOR2_VERSION: "3.0.9" }), /3\.1\.0 or newer/u);
  assert.throws(() => loadConfig({ ...base, TAPO_UIAUTOMATOR2_VERSION: "3.1" }), /3\.1\.0 or newer/u);
  assert.throws(() => loadConfig({ ...base, TAPO_APPIUM_VERSION: "" }), /APPIUM_VERSION/u);
  assert.throws(() => loadConfig({ ...base, TAPO_APPIUM_VERSION: "2.17.9" }), /2\.18\.0 or newer/u);
  assert.throws(() => loadConfig({ ...base, TAPO_DEDICATED_ACCOUNT: "false" }), /DEDICATED_ACCOUNT/u);
  assert.throws(() => loadConfig({ ...base, TAPO_APP_VERSION: "" }), /APP_VERSION/u);
  assert.throws(() => loadConfig({ ...base, TAPO_ACCOUNT_PROOF: "" }), /ACCOUNT_PROOF/u);
  assert.throws(() => loadConfig({ ...base, TAPO_ACCOUNT_PROOF: "short" }), /at least 32 bytes/u);
  assert.throws(() => loadConfig({
    ...base,
    TAPO_ACCOUNT_EMAIL: "owner@example.com",
    TAPO_ACCOUNT_PASSWORD: "secret",
  }), /only valid for preauthenticated mode/u);
  assert.throws(
    () => loadConfig({
      ...base,
      TAPO_APPIUM_CAPABILITIES_JSON: '{"platformName":"Android","appium:automationName":"UiAutomator2","appium:udid":"emulator-5554"}',
    }),
    /platformVersion/u,
  );
  assert.throws(
    () => loadConfig({
      ...base,
      TAPO_APPIUM_CAPABILITIES_JSON: '{"platformName":"Android","appium:automationName":"UiAutomator2","appium:platformVersion":"15","appium:language":"en","appium:udid":"emulator-5554"}',
    }),
    /appium:locale/u,
  );
});

test("deployment fingerprint is canonical and changes with every production pin", () => {
  const base = {
    runnerImplementationSha256: "a".repeat(64),
    flowConfigSource: '{"version":1}\n',
    targetLockId: "tapo-phone-helsinki-01",
    appiumUdid: "emulator-5554",
    tapoAppVersion: "3.14.110",
    appiumVersion: "2.18.0",
    uiautomator2Version: "3.1.0",
    exportEmail: "Exports+existing@example.com",
    apiToken: "worker-token".padEnd(32, "x"),
    accountIdentity: { kind: "proof", value: accountProof },
    appiumCapabilities: {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:platformVersion": "15",
      "appium:language": "en",
      "appium:locale": "US",
      "appium:udid": "emulator-5554",
    },
  };
  const first = calculateDeploymentFingerprint(base);
  const reordered = calculateDeploymentFingerprint({
    ...base,
    appiumCapabilities: Object.fromEntries(Object.entries(base.appiumCapabilities).reverse()),
  });
  assert.equal(first, reordered);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.notEqual(first, calculateDeploymentFingerprint({ ...base, flowConfigSource: '{"version":1} \n' }));
  assert.notEqual(first, calculateDeploymentFingerprint({ ...base, tapoAppVersion: "3.14.111" }));
  assert.notEqual(first, calculateDeploymentFingerprint({ ...base, appiumVersion: "2.19.0" }));
  assert.notEqual(first, calculateDeploymentFingerprint({ ...base, runnerImplementationSha256: "b".repeat(64) }));
  assert.notEqual(first, calculateDeploymentFingerprint({ ...base, apiToken: "rotated-token".padEnd(32, "y") }));
  assert.equal(first, calculateDeploymentFingerprint({ ...base, exportEmail: "exports@example.COM" }));
  assert.notEqual(first, calculateDeploymentFingerprint({ ...base, exportEmail: "other@example.com" }));
  assert.notEqual(first, calculateDeploymentFingerprint({
    ...base,
    accountIdentity: { kind: "proof", value: `${accountProof}-rotated` },
  }));
  assert.notEqual(first, calculateDeploymentFingerprint({
    ...base,
    appiumCapabilities: { ...base.appiumCapabilities, "appium:platformVersion": "16" },
  }));
});

test("caches the exact fingerprinted flow source so a later file mutation cannot change execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stuga-tapo-flow-pin-"));
  const path = join(directory, "flow.json");
  const original = '{"version":1,"name":"first"}\n';
  try {
    await writeFile(path, original);
    const config = loadConfig({
      TAPO_RUNNER_ENABLED: "true",
      TAPO_HISTORY_WORKER_TOKEN: "x".repeat(32),
      TAPO_RUNNER_FLOW_CONFIG: path,
      TAPO_EXPORT_EMAIL: "exports@example.com",
      ...preauthenticatedSafety,
    });
    await writeFile(path, '{"version":1,"name":"mutated"}\n');
    assert.equal(config.flowConfigSource, original);
    assert.notEqual(config.flowConfigSource, await readFile(path, "utf8"));
    assert.equal(config.deploymentFingerprint, calculateDeploymentFingerprint({
      flowConfigSource: original,
      targetLockId: config.targetLockId,
      appiumUdid: config.appiumCapabilities["appium:udid"],
      tapoAppVersion: config.tapoAppVersion,
      appiumVersion: config.appiumVersion,
      uiautomator2Version: config.uiautomator2Version,
      exportEmail: config.exportEmail,
      apiToken: config.apiToken,
      accountIdentity: { kind: "proof", value: accountProof },
      appiumCapabilities: config.appiumCapabilities,
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("binds account identity without making password rotation invalidate the deployment", () => {
  const base = {
    TAPO_RUNNER_ENABLED: "true",
    TAPO_HISTORY_WORKER_TOKEN: "x".repeat(32),
    TAPO_RUNNER_FLOW_CONFIG: flowPath,
    TAPO_EXPORT_EMAIL: "exports@example.com",
    TAPO_ACCOUNT_EMAIL: "Owner@Example.com",
    TAPO_ACCOUNT_PASSWORD: "first-password",
    ...enabledSafety,
  };
  const first = loadConfig(base);
  const passwordRotated = loadConfig({ ...base, TAPO_ACCOUNT_PASSWORD: "second-password" });
  const identityChanged = loadConfig({ ...base, TAPO_ACCOUNT_EMAIL: "other@example.com" });
  const identityCaseOnly = loadConfig({ ...base, TAPO_ACCOUNT_EMAIL: "owner@example.COM" });
  assert.equal(first.deploymentFingerprint, passwordRotated.deploymentFingerprint);
  assert.equal(first.deploymentFingerprint, identityCaseOnly.deploymentFingerprint);
  assert.notEqual(first.deploymentFingerprint, identityChanged.deploymentFingerprint);
  assert.equal("accountProof" in first, false);
});
