#!/usr/bin/env node

import { performance } from "node:perf_hooks";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
}

const origin = argument("origin", process.env.STUGU_BENCH_ORIGIN ?? "http://127.0.0.1:4000");
const houseId = argument("house", process.env.STUGU_BENCH_HOUSE_ID);
const dataMode = argument("mode", process.env.STUGU_BENCH_DATA_MODE ?? "live");
const requestCount = Number(argument("requests", process.env.STUGU_BENCH_REQUESTS ?? "20"));
const cookie = process.env.STUGU_BENCH_COOKIE;
const bearer = process.env.STUGU_BENCH_BEARER_TOKEN;
const ingestKey = process.env.STUGU_BENCH_INGEST_API_KEY;

if (!houseId) {
  console.error("Pass --house <id> or set STUGU_BENCH_HOUSE_ID.");
  process.exit(2);
}
if (!Number.isSafeInteger(requestCount) || requestCount < 2 || requestCount > 200) {
  console.error("--requests must be an integer from 2 to 200.");
  process.exit(2);
}

const headers = {
  accept: "application/json",
  ...(cookie ? { cookie } : {}),
  ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
};
const endpoint = new URL("/api/v2/analytics/home-performance", origin);
endpoint.searchParams.set("houseId", houseId);
endpoint.searchParams.set("dataMode", dataMode);

async function timedHomePerformance() {
  const startedAt = performance.now();
  const response = await fetch(endpoint, { headers });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const durationMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${new TextDecoder().decode(bytes)}`);
  }
  return {
    durationMs,
    bytes: bytes.byteLength,
    cache: response.headers.get("x-stugu-cache"),
    body: JSON.parse(new TextDecoder().decode(bytes)),
  };
}

async function publishRoutineMeasurement() {
  const snapshotUrl = new URL("/api/v2/measurements/snapshot", origin);
  snapshotUrl.searchParams.set("houseId", houseId);
  const snapshotResponse = await fetch(snapshotUrl, { headers });
  if (!snapshotResponse.ok) throw new Error(`Snapshot request failed with ${snapshotResponse.status}`);
  const snapshot = await snapshotResponse.json();
  const requestedSensor = argument("sensor");
  const entries = snapshot.snapshot ?? [];
  const entry = requestedSensor
    ? entries.find((item) => item.sensorId === requestedSensor)
    : entries.find((item) => Object.keys(item.measurements ?? {}).length > 0);
  const sample = entry && Object.values(entry.measurements ?? {})[0];
  if (!sample) throw new Error("No visible measurement is available for the ingest exercise");
  const ingestHeaders = {
    ...headers,
    "content-type": "application/json",
    ...(ingestKey ? { "x-api-key": ingestKey } : {}),
  };
  const ingestResponse = await fetch(new URL("/api/v2/measurements", origin), {
    method: "POST",
    headers: ingestHeaders,
    body: JSON.stringify({
      ...sample,
      timestamp: new Date().toISOString(),
    }),
  });
  if (!ingestResponse.ok) {
    throw new Error(`Measurement exercise failed with ${ingestResponse.status}: ${await ingestResponse.text()}`);
  }
}

const first = await timedHomePerformance();
const warm = [];
for (let index = 0; index < requestCount; index += 1) {
  warm.push(await timedHomePerformance());
}
let postMeasurement = null;
if (flag("exercise-ingest")) {
  await publishRoutineMeasurement();
  postMeasurement = await timedHomePerformance();
}

const warmDurations = warm.map((result) => result.durationMs);
const sensorCount = first.body.sensorHealth?.monitoredSensors ?? null;
const report = {
  endpoint: endpoint.toString(),
  sensorCount,
  firstMs: Number(first.durationMs.toFixed(1)),
  firstCache: first.cache,
  warmMedianMs: Number(percentile(warmDurations, 0.5).toFixed(1)),
  warmP95Ms: Number(percentile(warmDurations, 0.95).toFixed(1)),
  warmCacheOutcomes: Object.fromEntries([...new Set(warm.map((item) => item.cache))]
    .map((outcome) => [outcome ?? "missing", warm.filter((item) => item.cache === outcome).length])),
  responseBytes: first.bytes,
  postMeasurementCache: postMeasurement?.cache ?? null,
  budgets: {
    cold40SensorsMs: 2_500,
    warmP95Ms: 150,
    responseBytes: 1_000_000,
  },
};
console.log(JSON.stringify(report, null, 2));

const failed = report.responseBytes > report.budgets.responseBytes
  || report.warmP95Ms > report.budgets.warmP95Ms
  || (sensorCount === 40 && report.firstMs > report.budgets.cold40SensorsMs)
  || warm.some((result) => result.cache !== "hit")
  || (postMeasurement !== null && postMeasurement.cache !== "hit");
if (failed) process.exitCode = 1;
