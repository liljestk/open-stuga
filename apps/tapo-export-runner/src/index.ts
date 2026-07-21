import { JobApiClient } from "./api-client.js";
import { loadConfig } from "./config.js";
import { parseFlowConfigSource } from "./flow.js";
import type { RunnerLogger } from "./types.js";
import { AppiumClient } from "./webdriver.js";
import { TapoExportWorker } from "./worker.js";

const logger: RunnerLogger = {
  info: (message, fields = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", message, ...fields })),
  warn: (message, fields = {}) => console.warn(JSON.stringify({ timestamp: new Date().toISOString(), level: "warn", message, ...fields })),
  error: (message, fields = {}) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message, ...fields })),
};

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.enabled) {
    logger.info("Tapo export runner is disabled; set TAPO_RUNNER_ENABLED=true after configuring a tested flow");
    return;
  }

  // Parse the same immutable source bytes that loadConfig hashed. This avoids
  // claiming under one attestation while executing a concurrently changed file.
  const flowConfig = parseFlowConfigSource(config.flowConfigSource);
  const api = new JobApiClient({
    baseUrl: config.apiBaseUrl,
    apiPrefix: config.apiPrefix,
    token: config.apiToken,
    workerId: config.workerId,
    deploymentFingerprint: config.deploymentFingerprint,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const appium = new AppiumClient({
    baseUrl: config.appiumUrl,
    expectedAppiumVersion: config.appiumVersion,
    capabilities: config.appiumCapabilities,
    sessionFile: config.appiumSessionFile,
    artifactDirectory: config.artifactDirectory,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const worker = new TapoExportWorker(config, api, appium, flowConfig, logger);
  const shutdown = new AbortController();
  const stop = (signal: string): void => {
    logger.info("Shutdown requested", { signal });
    shutdown.abort(new Error(signal));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  try {
    await worker.run(shutdown.signal);
  } finally {
    if (!config.keepSessionOnShutdown) await appium.quit();
  }
}

main().catch((error: unknown) => {
  logger.error("Tapo export runner stopped with a fatal error", {
    error: error instanceof Error ? error.message : "unknown error",
  });
  process.exitCode = 1;
});
