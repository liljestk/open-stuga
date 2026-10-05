#!/usr/bin/env node
import { writeSync } from "node:fs";

const startedAt = performance.now();
let httpStatus = null;
let reason = "connection-error";
try {
  const response = await fetch("http://127.0.0.1:8787/api/v1/health", {
    signal: AbortSignal.timeout(4_000),
  });
  httpStatus = response.status;
  reason = response.ok ? "success" : "http-error";
  await response.body?.cancel();
} catch (error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") reason = "timeout";
}
// A healthcheck has its own short-lived process. Flush before exiting and
// never print a response body, URL, exception message or configuration.
writeSync(1, JSON.stringify({
  schema: "stugu-api-health-probe/v1", reason, httpStatus,
  durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
}) + "\n");
process.exit(reason === "success" ? 0 : 1);
