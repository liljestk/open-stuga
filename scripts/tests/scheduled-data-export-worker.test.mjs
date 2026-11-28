import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processDataExportRequests } from "../stugu-backup-scheduler.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stugu-export-worker-"));
  const source = join(root, "operations");
  const destination = join(root, "nas");
  mkdirSync(source);
  mkdirSync(destination);
  return { root, source, destination };
}

test("the isolated storage worker verifies, copies, receipts, and prunes scheduled exports", (context) => {
  const { root, source, destination } = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runId = randomUUID();
  const scheduleId = randomUUID();
  const payloadName = `data-export-${runId}.csv`;
  const requestName = `data-export-${runId}.request.json`;
  const content = Buffer.from("\uFEFFHome time,Value\r\n2026-08-02 12:00:00,21.25\r\n", "utf8");
  writeFileSync(join(source, payloadName), content);
  writeFileSync(join(source, requestName), JSON.stringify({
    schema: "stugu-data-export-request/v2",
    runId,
    scheduleId,
    requestedAt: "2026-08-02T12:00:00.000Z",
    payloadName,
    outputName: "stugu-home-export.csv",
    dataMode: "live",
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    retentionCount: 1,
  }));
  const outputDirectory = join(destination, "data-exports", scheduleId);
  mkdirSync(outputDirectory, { recursive: true });
  const oldOutput = join(outputDirectory, "stugu-old-export.csv");
  writeFileSync(oldOutput, "old");
  utimesSync(oldOutput, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));

  const receipts = processDataExportRequests(source, destination, () => new Date("2026-08-02T12:01:00.000Z"));

  assert.deepEqual(receipts.map((receipt) => receipt.status), ["complete"]);
  assert.deepEqual(readFileSync(join(outputDirectory, "stugu-home-export.csv")), content);
  assert.deepEqual(readdirSync(outputDirectory), ["stugu-home-export.csv"]);
  assert.equal(existsSync(join(source, payloadName)), false);
  assert.equal(existsSync(join(source, requestName)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(source, `data-export-${runId}.receipt.json`), "utf8")), receipts[0]);
});

test("the storage worker rejects a tampered payload without writing it to NAS", (context) => {
  const { root, source, destination } = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runId = randomUUID();
  const scheduleId = randomUUID();
  const payloadName = `data-export-${runId}.csv`;
  const content = Buffer.from("tampered", "utf8");
  writeFileSync(join(source, payloadName), content);
  writeFileSync(join(source, `data-export-${runId}.request.json`), JSON.stringify({
    schema: "stugu-data-export-request/v2",
    runId,
    scheduleId,
    requestedAt: "2026-08-02T12:00:00.000Z",
    payloadName,
    outputName: "stugu-home-export.csv",
    dataMode: "live",
    bytes: content.byteLength,
    sha256: "0".repeat(64),
    retentionCount: 2,
  }));

  const [receipt] = processDataExportRequests(source, destination);

  assert.equal(receipt.status, "failed");
  assert.match(receipt.error, /checksum/u);
  assert.equal(existsSync(join(destination, "data-exports", scheduleId, "stugu-home-export.csv")), false);
});

test("the NAS worker isolates a queued demo export from the live directory and rejects a legacy request", (context) => {
  const { root, source, destination } = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scheduleId = randomUUID();
  const liveDirectory = join(destination, "data-exports", scheduleId);
  mkdirSync(liveDirectory, { recursive: true });
  writeFileSync(join(liveDirectory, "previous.csv"), "live");
  const content = Buffer.from("demo", "utf8");
  function stage(mode) {
    const runId = randomUUID();
    const payloadName = `data-export-${runId}.csv`;
    writeFileSync(join(source, payloadName), content);
    writeFileSync(join(source, `data-export-${runId}.request.json`), JSON.stringify({
      schema: `stugu-data-export-request/${mode ? "v2" : "v1"}`,
      runId, scheduleId, payloadName, outputName: "queued.csv",
      requestedAt: "2026-08-02T12:00:00.000Z", bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"), retentionCount: 1,
      ...(mode ? { dataMode: mode } : { relativeDirectory: `data-exports/${scheduleId}` }),
    }));
    return runId;
  }
  const demo = stage("demo");
  const legacy = stage(null);
  const receipts = processDataExportRequests(source, destination);
  assert.equal(receipts.find((receipt) => receipt.runId === demo)?.status, "complete");
  assert.match(receipts.find((receipt) => receipt.runId === legacy)?.error, /predates data-mode isolation/u);
  assert.deepEqual(readdirSync(liveDirectory), ["previous.csv"]);
  assert.deepEqual(readFileSync(join(destination, "demo-data-exports", scheduleId, "queued.csv")), content);
  assert.equal(existsSync(join(source, `data-export-${legacy}.csv`)), false);
});
