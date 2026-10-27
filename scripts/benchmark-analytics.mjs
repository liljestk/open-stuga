#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;

/**
 * p95 latency targets in milliseconds for a Raspberry Pi-class appliance.
 * Cold answers are computed; warm answers repeat a request and must come from
 * the server cache.
 */
export const ANALYTICS_LATENCY_TARGETS = Object.freeze({
  "query-24h": { cold: 400, warm: 100 },
  "query-7d": { cold: 800, warm: 100 },
  "query-30d": { cold: 1_500, warm: 100 },
  "query-365d": { cold: 3_000, warm: 150 },
  "energy-summary-30d": { cold: 2_000, warm: 100 },
});

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
}

async function timed(url, init) {
  const startedAt = performance.now();
  const response = await fetch(url, init);
  const text = await response.text();
  const durationMs = performance.now() - startedAt;
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}: ${text.slice(0, 300)}`);
  return { durationMs, cache: response.headers.get("x-stugu-cache"), body: JSON.parse(text) };
}

/**
 * Measures cold and warm latency per scenario. Each cold sample shifts the
 * window end by a minute so it misses the cache; each warm sample repeats the
 * previous request and must be reported as a cache hit.
 */
export async function runAnalyticsBenchmark(options) {
  const {
    origin, houseId, sensorId, metric = "temperature", dataMode = "live",
    samples = 5, headers = {}, now = Date.now(), targets = ANALYTICS_LATENCY_TARGETS,
  } = options;
  const jsonHeaders = { accept: "application/json", "content-type": "application/json", ...headers };
  const queryUrl = new URL("/api/v2/analytics/query", origin);
  const scenarios = [
    ["query-24h", DAY_MS],
    ["query-7d", 7 * DAY_MS],
    ["query-30d", 30 * DAY_MS],
    ["query-365d", 365 * DAY_MS],
  ].map(([name, durationMs]) => ({
    name,
    request: (end) => timed(queryUrl, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        apiVersion: "1.0", dataMode,
        scope: { kind: "house", id: houseId, entityIds: [sensorId] },
        measurementIds: [metric],
        range: { start: new Date(end - durationMs).toISOString(), end: new Date(end).toISOString(), timezone: "UTC" },
        resolution: "auto", aggregation: "default", requestId: `benchmark-${name}`,
      }),
    }),
    hit: (result) => result.body.cache?.hit === true,
  }));
  scenarios.push({
    name: "energy-summary-30d",
    request: (end) => {
      const url = new URL(`/api/v1/houses/${encodeURIComponent(houseId)}/energy-summary`, origin);
      url.searchParams.set("from", new Date(end - 30 * DAY_MS).toISOString());
      url.searchParams.set("to", new Date(end).toISOString());
      return timed(url, { headers: jsonHeaders });
    },
    hit: (result) => result.cache === "hit",
  });

  const alignedNow = Math.floor(now / 60_000) * 60_000;
  const results = [];
  for (const scenario of scenarios) {
    const cold = [];
    const warm = [];
    let warmHits = 0;
    for (let index = 0; index < samples; index += 1) {
      const end = alignedNow - index * 60_000;
      cold.push((await scenario.request(end)).durationMs);
      const repeated = await scenario.request(end);
      warm.push(repeated.durationMs);
      if (scenario.hit(repeated)) warmHits += 1;
    }
    const target = targets[scenario.name];
    const coldP95 = percentile(cold, 0.95);
    const warmP95 = percentile(warm, 0.95);
    results.push({
      name: scenario.name,
      coldP95Ms: Number(coldP95.toFixed(1)),
      warmP95Ms: Number(warmP95.toFixed(1)),
      warmHitRate: warmHits / samples,
      targetColdMs: target?.cold ?? null,
      targetWarmMs: target?.warm ?? null,
      pass: warmHits === samples && (!target || (coldP95 <= target.cold && warmP95 <= target.warm)),
    });
  }
  return results;
}

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const houseId = argument("house", process.env.STUGU_BENCH_HOUSE_ID);
  const sensorId = argument("sensor", process.env.STUGU_BENCH_SENSOR_ID);
  if (!houseId || !sensorId) {
    console.error("Pass --house <id> and --sensor <id> (or STUGU_BENCH_HOUSE_ID and STUGU_BENCH_SENSOR_ID).");
    process.exit(2);
  }
  const cookie = process.env.STUGU_BENCH_COOKIE;
  const bearer = process.env.STUGU_BENCH_BEARER_TOKEN;
  const results = await runAnalyticsBenchmark({
    origin: argument("origin", process.env.STUGU_BENCH_ORIGIN ?? "http://127.0.0.1:4000"),
    houseId,
    sensorId,
    metric: argument("metric", "temperature"),
    dataMode: argument("mode", process.env.STUGU_BENCH_DATA_MODE ?? "live"),
    samples: Number(argument("samples", "5")),
    headers: { ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  });
  console.table(results);
  process.exit(results.every((result) => result.pass) ? 0 : 1);
}
