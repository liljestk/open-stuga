import type { AppConfig } from "../src/config.js";

export function sensorGapRecoveryConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0, apiHost: "127.0.0.1", databasePath: ":memory:",
    integrationSecretsFile: "unused.json",
    assetDirectory: ".",
    mockEnabled: false,
    mockIntervalMs: 2_000,
    retentionDays: 730,
    ingestApiKey: null,
    haUrl: null, haToken: null, haEntityMapFile: null,
    tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null,
    tpLinkDeviceMapFile: null,
    tpLinkPollIntervalMs: 10_000,
    tpLinkPython: "python",
    tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
    corsOrigin: null,
    localAuthTestBypass: true,
    ...overrides,
  };
}
