import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("API container health probes retain only bounded failure classifications", () => {
  const healthcheck = new URL("../api-healthcheck.mjs", import.meta.url).href;
  for (const [behavior, status, expected] of [
    ["return new Response('private-secret-body', { status: 200 });", 0, { reason: "success", httpStatus: 200 }],
    ["return new Response('private-secret-body', { status: 503 });", 1, { reason: "http-error", httpStatus: 503 }],
    ["throw new DOMException('private-secret', 'TimeoutError');", 1, { reason: "timeout", httpStatus: null }],
    ["throw new Error('private-secret');", 1, { reason: "connection-error", httpStatus: null }],
  ]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      globalThis.fetch = async (url, options) => {
        if (url !== 'http://127.0.0.1:8787/api/v1/health' || !options.signal) throw new Error('invalid probe');
        ${behavior}
      };
      await import(${JSON.stringify(healthcheck)});
    `], { encoding: "utf8", timeout: 6_000, windowsHide: true });
    assert.equal(child.status, status, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.schema, "stugu-api-health-probe/v1");
    assert.equal(result.reason, expected.reason);
    assert.equal(result.httpStatus, expected.httpStatus);
    assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
    assert.doesNotMatch(child.stdout + child.stderr, /private-secret/u);
  }
});
