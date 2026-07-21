import assert from "node:assert/strict";
import test from "node:test";
import { TapoExportWorker } from "../dist/worker.js";
import { WebDriverError } from "../dist/webdriver.js";

test("an automatic-login flow failure opens the global circuit before another claim", async () => {
  const job = (id) => ({
    id,
    sensorId: "sensor-1",
    deviceId: "device-1",
    deviceName: "Cellar",
    metric: "temperature",
    from: "2026-07-18T00:00:00.000Z",
    to: "2026-07-18T02:00:00.000Z",
    timeZone: "Europe/Helsinki",
    intervalMinutes: 15,
    expectedRecipient: `exports+stuga-${id}@example.com`,
    status: "claimed",
    attemptCount: 1,
    leaseToken: `lease-${id}`,
    leaseExpiresAt: "2026-07-19T20:10:00.000Z",
    serverNow: "2026-07-19T20:05:00.000Z",
    leaseTtlMs: 300_000,
  });
  let claims = 0;
  const updates = [];
  const api = {
    claim: async () => {
      claims += 1;
      return claims === 1 ? job("one") : job("two");
    },
    heartbeat: async () => ({ leaseExpiresAt: "2026-07-19T20:15:00.000Z", leaseTtlMs: 300_000 }),
    updateStatus: async (_job, update) => { updates.push(update); },
  };
  const appium = {
    pruneArtifacts: async () => 0,
    resetSession: async () => undefined,
    ensureSession: async () => "session",
    assertSensitiveInputSupported: async () => undefined,
    assertTargetSessionStateSafe: async () => undefined,
    activateApp: async () => undefined,
    terminateApp: async () => undefined,
    exists: async (selector) => selector.value === "login",
    waitForElement: async (selector) => {
      if (selector.value === "home") throw new Error("login result did not appear");
      return "field";
    },
    clear: async () => undefined,
    type: async () => undefined,
    saveScreenshot: async () => "diagnostic.png",
  };
  const config = {
    enabled: true,
    apiBaseUrl: "http://api",
    apiPrefix: "/internal",
    apiToken: "x".repeat(32),
    workerLabel: "test",
    workerId: "tapo-target-test",
    targetLockId: "phone-test",
    deploymentFingerprint: "a".repeat(64),
    tapoAppVersion: "3.14.110",
    appiumVersion: "2.18.0",
    appiumUrl: "http://appium",
    appiumCapabilities: { platformName: "Android", "appium:platformVersion": "15", "appium:udid": "device" },
    appiumLogsHardened: true,
    uiautomator2Version: "3.1.0",
    appiumSessionFile: "session.json",
    artifactDirectory: "artifacts",
    artifactRetentionMs: 86_400_000,
    flowConfigFile: "flow.json",
    flowConfigSource: "{}",
    tapoUsername: "user@example.com",
    tapoPassword: "wrong-password",
    dedicatedAccount: true,
    exportEmail: "exports@example.com",
    pollIntervalMs: 1_000,
    heartbeatIntervalMs: 15_000,
    requestTimeoutMs: 15_000,
    defaultActionTimeoutMs: 15_000,
    keepSessionOnShutdown: true,
  };
  const flow = {
    version: 1,
    appPackage: "com.tplink.iot",
    intervalLabels: { "15": "15 min" },
    deviceProofs: { "device-1": "serial-1" },
    restartAppBeforeJob: false,
    signalTimeoutMs: 0,
    signals: {
      authenticated: { using: "id", value: "home" },
      login: { using: "id", value: "login" },
    },
    flows: {
      login: [
        { action: "type", selector: { using: "id", value: "email" }, value: "{{TAPO_USERNAME}}" },
        { action: "type", selector: { using: "id", value: "password" }, value: "{{TAPO_PASSWORD}}" },
        { action: "waitFor", selector: { using: "id", value: "home" } },
      ],
      export: [],
    },
  };
  const logger = { info() {}, warn() {}, error() {} };
  const worker = new TapoExportWorker(config, api, appium, flow, logger);

  await worker.run(new AbortController().signal);

  assert.equal(claims, 1);
  assert.equal(updates[0].status, "running");
  assert.equal(updates.at(-1).status, "needs-attention");
});

function recoveryJob(id = "one") {
  return {
    id,
    sensorId: "sensor-1",
    deviceId: "device-1",
    deviceName: "Cellar",
    metric: "temperature",
    from: "2026-07-18T00:00:00.000Z",
    to: "2026-07-18T02:00:00.000Z",
    timeZone: "Europe/Helsinki",
    intervalMinutes: 15,
    expectedRecipient: `exports+stuga-${id}@example.com`,
    status: "claimed",
    attemptCount: 1,
    leaseToken: `lease-${id}`,
    leaseExpiresAt: "2026-07-19T20:10:00.000Z",
    serverNow: "2026-07-19T20:05:00.000Z",
    leaseTtlMs: 300_000,
  };
}

function recoveryConfig() {
  return {
    enabled: true,
    apiBaseUrl: "http://api",
    apiPrefix: "/internal",
    apiToken: "x".repeat(32),
    workerLabel: "test",
    workerId: "tapo-target-test",
    targetLockId: "phone-test",
    deploymentFingerprint: "a".repeat(64),
    tapoAppVersion: "3.14.110",
    appiumVersion: "2.18.0",
    appiumUrl: "http://appium",
    appiumCapabilities: { platformName: "Android", "appium:platformVersion": "15", "appium:udid": "device" },
    appiumLogsHardened: true,
    uiautomator2Version: "3.1.0",
    appiumSessionFile: "session.json",
    artifactDirectory: "artifacts",
    artifactRetentionMs: 86_400_000,
    flowConfigFile: "flow.json",
    flowConfigSource: "{}",
    dedicatedAccount: true,
    exportEmail: "exports@example.com",
    pollIntervalMs: 1_000,
    heartbeatIntervalMs: 15_000,
    requestTimeoutMs: 15_000,
    defaultActionTimeoutMs: 15_000,
    keepSessionOnShutdown: true,
  };
}

function recoveryFlow(exportActions = []) {
  return {
    version: 1,
    appPackage: "com.tplink.iot",
    intervalLabels: { "15": "15 min" },
    deviceProofs: { "device-1": "serial-1" },
    restartAppBeforeJob: false,
    signalTimeoutMs: 0,
    signals: { authenticated: { using: "id", value: "home" } },
    flows: { export: exportActions },
  };
}

function recoveryApi() {
  let claims = 0;
  const updates = [];
  return {
    updates,
    claims: () => claims,
    client: {
      claim: async () => {
        claims += 1;
        return claims === 1 ? recoveryJob() : recoveryJob("two");
      },
      heartbeat: async () => ({ leaseExpiresAt: "2026-07-19T20:15:00.000Z", leaseTtlMs: 300_000 }),
      updateStatus: async (_job, update) => { updates.push(update); },
    },
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };

test("an Appium preflight outage claims zero jobs", async () => {
  const api = recoveryApi();
  const appium = {
    pruneArtifacts: async () => 0,
    assertSensitiveInputSupported: async () => {
      throw new WebDriverError("offline", "appium unavailable", 503);
    },
    assertTargetSessionStateSafe: async () => undefined,
  };
  const worker = new TapoExportWorker(recoveryConfig(), api.client, appium, recoveryFlow(), quietLogger);

  await assert.rejects(
    worker.run(new AbortController().signal),
    /exiting for the service restart policy/u,
  );

  assert.equal(api.claims(), 0);
  assert.deepEqual(api.updates, []);
});

test("an unsafe active-session preflight claims zero jobs", async () => {
  const api = recoveryApi();
  const appium = {
    pruneArtifacts: async () => 0,
    assertSensitiveInputSupported: async () => undefined,
    assertTargetSessionStateSafe: async () => {
      throw new WebDriverError("unknown active target", "unsafe session state", 409);
    },
  };
  const worker = new TapoExportWorker(recoveryConfig(), api.client, appium, recoveryFlow(), quietLogger);

  await assert.rejects(
    worker.run(new AbortController().signal),
    /exiting for the service restart policy/u,
  );

  assert.equal(api.claims(), 0);
  assert.deepEqual(api.updates, []);
});

test("a claimed-job session infrastructure failure opens the circuit before a second claim", async () => {
  const api = recoveryApi();
  const appium = {
    pruneArtifacts: async () => 0,
    assertSensitiveInputSupported: async () => undefined,
    assertTargetSessionStateSafe: async () => undefined,
    resetSession: async () => {
      throw new WebDriverError("session reset failed", "appium unavailable", 503);
    },
  };
  const worker = new TapoExportWorker(recoveryConfig(), api.client, appium, recoveryFlow(), quietLogger);

  await assert.rejects(
    worker.run(new AbortController().signal),
    /exiting for the service restart policy/u,
  );

  assert.equal(api.claims(), 1);
  assert.equal(api.updates[0].status, "running");
  assert.equal(api.updates.at(-1).status, "failed");
});

test("a FlowExecutionError preserves an infrastructure cause and opens the global circuit", async () => {
  const api = recoveryApi();
  const appium = {
    pruneArtifacts: async () => 0,
    assertSensitiveInputSupported: async () => undefined,
    assertTargetSessionStateSafe: async () => undefined,
    resetSession: async () => undefined,
    ensureSession: async () => "session",
    activateApp: async () => undefined,
    exists: async () => true,
    waitForElement: async () => {
      throw new WebDriverError("malformed response", "invalid response", 502);
    },
    saveScreenshot: async () => "diagnostic.png",
  };
  const flow = recoveryFlow([{
    action: "waitFor",
    selector: { using: "id", value: "history" },
    failureCode: "device_not_found",
  }]);
  const worker = new TapoExportWorker(recoveryConfig(), api.client, appium, flow, quietLogger);

  await assert.rejects(
    worker.run(new AbortController().signal),
    /exiting for the service restart policy/u,
  );

  assert.equal(api.claims(), 1);
  assert.equal(api.updates.at(-1).status, "needs-attention");
});

test("shared ui_drift and configuration_error flow failures stop further claims", async () => {
  for (const failureCode of ["ui_drift", "configuration_error"]) {
    const api = recoveryApi();
    const appium = {
      pruneArtifacts: async () => 0,
      assertSensitiveInputSupported: async () => undefined,
      assertTargetSessionStateSafe: async () => undefined,
      resetSession: async () => undefined,
      ensureSession: async () => "session",
      activateApp: async () => undefined,
      exists: async () => true,
      waitForElement: async () => {
        throw new WebDriverError("selector absent", "no such element", 404);
      },
      saveScreenshot: async () => "diagnostic.png",
    };
    const flow = recoveryFlow([{
      action: "waitFor",
      selector: { using: "id", value: "history" },
      failureCode,
    }]);
    const worker = new TapoExportWorker(recoveryConfig(), api.client, appium, flow, quietLogger);

    await worker.run(new AbortController().signal);

    assert.equal(api.claims(), 1, failureCode);
    assert.equal(api.updates.at(-1).status, "needs-attention", failureCode);
  }
});

test("a runner/API export-mailbox mismatch opens the shared configuration circuit", async () => {
  const api = recoveryApi();
  const config = recoveryConfig();
  config.exportEmail = "different@example.com";
  const appium = {
    pruneArtifacts: async () => 0,
    assertSensitiveInputSupported: async () => undefined,
    assertTargetSessionStateSafe: async () => undefined,
    saveScreenshot: async () => "diagnostic.png",
  };
  const worker = new TapoExportWorker(config, api.client, appium, recoveryFlow(), quietLogger);

  await worker.run(new AbortController().signal);

  assert.equal(api.claims(), 1);
  assert.equal(api.updates.at(-1).status, "needs-attention");
  assert.match(api.updates.at(-1).detail, /plus-address alias/u);
});
