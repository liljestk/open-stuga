import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AppiumClient,
  MAX_APPIUM_JSON_RESPONSE_BYTES,
  MAX_APPIUM_SCREENSHOT_RESPONSE_BYTES,
} from "../dist/webdriver.js";

async function fixture(handler, { defaultSessions = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "stuga-appium-test-"));
  const server = createServer((request, response) => {
    if (defaultSessions && request.method === "GET" && request.url === "/sessions") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: [] }));
      return;
    }
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    directory,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function client(baseUrl, directory, udid, sessionFile = join(directory, "session.json")) {
  return new AppiumClient({
    baseUrl,
    capabilities: { platformName: "Android", "appium:udid": udid },
    sessionFile,
    artifactDirectory: join(directory, "artifacts"),
    requestTimeoutMs: 5_000,
  });
}

test("marks typed values sensitive and never echoes a rejected secret", async () => {
  let sensitiveHeader;
  const appium = await fixture((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/session") {
      response.end(JSON.stringify({ value: { sessionId: "session-a", capabilities: { platformName: "Android", "appium:udid": "device-a" } } }));
      return;
    }
    if (request.url?.endsWith("/value")) {
      sensitiveHeader = request.headers["x-appium-is-sensitive"];
      response.statusCode = 500;
      response.end(JSON.stringify({ value: { error: "unknown error", message: "driver rejected super-secret" } }));
      return;
    }
    response.end(JSON.stringify({ value: null }));
  });
  try {
    const driver = client(appium.baseUrl, appium.directory, "device-a");
    await driver.ensureSession();
    await assert.rejects(
      driver.type("password-field", "super-secret", undefined, true),
      (error) => error.message === "Sensitive Appium input command failed" && !error.message.includes("super-secret"),
    );
    assert.equal(sensitiveHeader, "true");
  } finally {
    await appium.close();
  }
});

test("requires Appium 2.18 or newer before sensitive input", async () => {
  let version = "2.17.9";
  const appium = await fixture((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/status") {
      response.end(JSON.stringify({ value: { build: { version } } }));
      return;
    }
    response.end(JSON.stringify({ value: null }));
  });
  try {
    const driver = client(appium.baseUrl, appium.directory, "device-a");
    await assert.rejects(driver.assertSensitiveInputSupported(), /2\.18\.0 or newer/u);
    version = "3.5.0";
    await assert.doesNotReject(driver.assertSensitiveInputSupported());
  } finally {
    await appium.close();
  }
});

test("requires /status to match the exact configured Appium version", async () => {
  let version = "2.18.0";
  const appium = await fixture((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ value: { build: { version } } }));
  });
  try {
    const driver = new AppiumClient({
      baseUrl: appium.baseUrl,
      expectedAppiumVersion: "2.18.0",
      capabilities: { platformName: "Android", "appium:udid": "device-a" },
      sessionFile: join(appium.directory, "session.json"),
      artifactDirectory: join(appium.directory, "artifacts"),
      requestTimeoutMs: 5_000,
    });
    await assert.doesNotReject(driver.assertSensitiveInputSupported());
    version = "2.19.0";
    await assert.rejects(driver.assertSensitiveInputSupported(), /exact configured TAPO_APPIUM_VERSION/u);
  } finally {
    await appium.close();
  }
});

test("does not reuse a persisted session after the configured target changes", async () => {
  let sessions = 0;
  let deletes = 0;
  const appium = await fixture(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/session") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const udid = JSON.parse(body).capabilities.alwaysMatch["appium:udid"];
      sessions += 1;
      response.end(JSON.stringify({ value: { sessionId: `session-${sessions}`, capabilities: { platformName: "Android", "appium:udid": udid } } }));
      return;
    }
    if (request.method === "DELETE" && request.url === "/session/session-1") {
      deletes += 1;
      response.end(JSON.stringify({ value: null }));
      return;
    }
    response.end(JSON.stringify({ value: { "appium:udid": "device-a" } }));
  });
  try {
    const sessionFile = join(appium.directory, "shared-session.json");
    await client(appium.baseUrl, appium.directory, "device-a", sessionFile).ensureSession();
    await client(appium.baseUrl, appium.directory, "device-b", sessionFile).ensureSession();
    assert.equal(sessions, 2);
    assert.equal(deletes, 1);
  } finally {
    await appium.close();
  }
});

test("does not create a replacement session when deleting the prior session fails", async () => {
  let sessions = 0;
  let deletes = 0;
  const appium = await fixture(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/session") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const capabilities = JSON.parse(body).capabilities.alwaysMatch;
      sessions += 1;
      response.end(JSON.stringify({ value: { sessionId: `session-${sessions}`, capabilities } }));
      return;
    }
    if (request.method === "DELETE" && request.url === "/session/session-1") {
      deletes += 1;
      response.statusCode = 500;
      response.end(JSON.stringify({ value: { error: "unknown error", message: "delete failed" } }));
      return;
    }
    response.end(JSON.stringify({ value: { "appium:udid": "device-a" } }));
  });
  try {
    const driver = client(appium.baseUrl, appium.directory, "device-a");
    await driver.ensureSession();
    await assert.rejects(driver.ensureSession(undefined, "Europe/Helsinki"), /delete failed/u);
    assert.equal(deletes, 1);
    assert.equal(sessions, 1);
  } finally {
    await appium.close();
  }
});

test("requires one exact account device and verifies the exact Android IANA timezone", async () => {
  const appium = await fixture(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/session") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const capabilities = JSON.parse(body).capabilities.alwaysMatch;
      response.end(JSON.stringify({ value: { sessionId: "session-a", capabilities } }));
      return;
    }
    if (request.url?.endsWith("/execute/sync")) {
      response.end(JSON.stringify({ value: "2026-07-19T15:00:00+03:00" }));
      return;
    }
    if (request.url?.endsWith("/elements")) {
      response.end(JSON.stringify({ value: [
        { "element-6066-11e4-a52e-4f735466cecf": "one" },
        { "element-6066-11e4-a52e-4f735466cecf": "two" },
      ] }));
      return;
    }
    response.end(JSON.stringify({ value: null }));
  });
  try {
    const driver = client(appium.baseUrl, appium.directory, "device-a");
    await driver.ensureSession(undefined, "Europe/Helsinki");
    await assert.rejects(
      driver.waitForUniqueElement({ using: "accessibility id", value: "Cellar" }, 10),
      /more than one account device/u,
    );
  } finally {
    await appium.close();
  }
});

test("prunes only expired runner screenshot artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stuga-artifact-test-"));
  try {
    const artifacts = join(directory, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const oldScreenshot = join(artifacts, "1000-old.png");
    const userFile = join(artifacts, "notes.png");
    await writeFile(oldScreenshot, "old");
    await writeFile(userFile, "keep");
    await utimes(oldScreenshot, new Date(0), new Date(0));
    const driver = client("http://127.0.0.1:4723", directory, "device-a");
    assert.equal(await driver.pruneArtifacts(24 * 60 * 60_000, Date.now()), 1);
    assert.equal(await driver.pruneArtifacts(24 * 60 * 60_000, Date.now()), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a session when Appium does not echo every locale and platform pin exactly", async () => {
  let deletes = 0;
  const appium = await fixture(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/session") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const capabilities = JSON.parse(body).capabilities.alwaysMatch;
      response.end(JSON.stringify({
        value: {
          sessionId: "session-a",
          capabilities: { ...capabilities, "appium:locale": "GB" },
        },
      }));
      return;
    }
    if (request.method === "DELETE") deletes += 1;
    response.end(JSON.stringify({ value: null }));
  });
  try {
    const driver = new AppiumClient({
      baseUrl: appium.baseUrl,
      capabilities: {
        platformName: "Android",
        "appium:automationName": "UiAutomator2",
        "appium:platformVersion": "15",
        "appium:language": "en",
        "appium:locale": "US",
        "appium:udid": "device-a",
      },
      sessionFile: join(appium.directory, "session.json"),
      artifactDirectory: join(appium.directory, "artifacts"),
      requestTimeoutMs: 5_000,
    });
    await assert.rejects(driver.ensureSession(), /exact configured appium:locale/u);
    assert.equal(deletes, 1);
  } finally {
    await appium.close();
  }
});

test("bounds ordinary Appium JSON separately from screenshot payloads", async () => {
  const appium = await fixture((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/status") {
      response.end(`{"value":"${"x".repeat(MAX_APPIUM_JSON_RESPONSE_BYTES)}"}`);
      return;
    }
    if (request.method === "POST" && request.url === "/session") {
      response.end(JSON.stringify({
        value: { sessionId: "session-a", capabilities: { platformName: "Android", "appium:udid": "device-a" } },
      }));
      return;
    }
    if (request.url?.endsWith("/screenshot")) {
      response.setHeader("content-length", String(MAX_APPIUM_SCREENSHOT_RESPONSE_BYTES + 1));
      response.end("{}");
      return;
    }
    response.end(JSON.stringify({ value: null }));
  });
  try {
    const driver = client(appium.baseUrl, appium.directory, "device-a");
    await assert.rejects(driver.assertSensitiveInputSupported(), /response exceeded/u);
    await driver.ensureSession();
    await assert.rejects(driver.saveScreenshot("bounded"), /response exceeded/u);
  } finally {
    await appium.close();
  }
});

test("recovers a crash-created exact-target orphan before creating a replacement session", async () => {
  const requests = [];
  const active = new Map();
  let sequence = 0;
  const appium = await fixture(async (request, response) => {
    response.setHeader("content-type", "application/json");
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "GET" && request.url === "/sessions") {
      response.end(JSON.stringify({
        value: [...active.entries()].map(([id, capabilities]) => ({ id, capabilities })),
      }));
      return;
    }
    if (request.method === "DELETE" && request.url?.startsWith("/session/")) {
      active.delete(decodeURIComponent(request.url.slice("/session/".length)));
      response.end(JSON.stringify({ value: null }));
      return;
    }
    if (request.method === "POST" && request.url === "/session") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const capabilities = JSON.parse(body).capabilities.alwaysMatch;
      const id = `session-${++sequence}`;
      active.set(id, capabilities);
      response.end(JSON.stringify({ value: { sessionId: id, capabilities } }));
      return;
    }
    response.end(JSON.stringify({ value: null }));
  }, { defaultSessions: false });
  try {
    const blockedParent = join(appium.directory, "not-a-directory");
    await writeFile(blockedParent, "blocked");
    const capabilities = {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:platformVersion": "15",
      "appium:language": "en",
      "appium:locale": "US",
      "appium:udid": "device-a",
    };
    const crashed = new AppiumClient({
      baseUrl: appium.baseUrl,
      capabilities,
      sessionFile: join(blockedParent, "session.json"),
      artifactDirectory: join(appium.directory, "artifacts"),
      requestTimeoutMs: 5_000,
    });
    await assert.rejects(crashed.ensureSession(), /durably record the Appium session/u);
    assert.deepEqual([...active.keys()], ["session-1"]);

    const replacement = new AppiumClient({
      baseUrl: appium.baseUrl,
      capabilities,
      sessionFile: join(appium.directory, "safe-session.json"),
      artifactDirectory: join(appium.directory, "artifacts"),
      requestTimeoutMs: 5_000,
    });
    assert.equal(await replacement.ensureSession(), "session-2");
    assert.deepEqual([...active.keys()], ["session-2"]);
    assert.deepEqual(requests.slice(0, 5), [
      "GET /sessions",
      "POST /session",
      "GET /sessions",
      "DELETE /session/session-1",
      "POST /session",
    ]);
  } finally {
    await appium.close();
  }
});

test("refuses rather than deletes a same-UDID orphan with mismatched deployment pins", async () => {
  let deletes = 0;
  let creates = 0;
  const appium = await fixture((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/sessions") {
      response.end(JSON.stringify({ value: [{
        id: "unknown-session",
        capabilities: {
          platformName: "Android",
          "appium:automationName": "UiAutomator2",
          "appium:platformVersion": "15",
          "appium:language": "en",
          "appium:locale": "GB",
          "appium:udid": "device-a",
        },
      }] }));
      return;
    }
    if (request.method === "DELETE") deletes += 1;
    if (request.method === "POST" && request.url === "/session") creates += 1;
    response.end(JSON.stringify({ value: null }));
  }, { defaultSessions: false });
  try {
    const driver = new AppiumClient({
      baseUrl: appium.baseUrl,
      capabilities: {
        platformName: "Android",
        "appium:automationName": "UiAutomator2",
        "appium:platformVersion": "15",
        "appium:language": "en",
        "appium:locale": "US",
        "appium:udid": "device-a",
      },
      sessionFile: join(appium.directory, "session.json"),
      artifactDirectory: join(appium.directory, "artifacts"),
      requestTimeoutMs: 5_000,
    });
    await assert.rejects(driver.ensureSession(), /exact configured appium:locale/u);
    assert.equal(deletes, 0);
    assert.equal(creates, 0);
  } finally {
    await appium.close();
  }
});
