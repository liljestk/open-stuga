export const hex = (character = "a") => character.repeat(64);

export function healthyEvidence() {
  return {
    schema: "stugu-rpi-doctor-evidence/v1",
    collectedAt: "2026-08-09T10:00:00Z",
    durationMs: 800,
    deep: false,
    identity: {
      machineIdSha256: hex("1"),
      hostnameSha256: hex("2"),
      hardwareFingerprint: `sha256:${hex("3")}`,
    },
    system: {
      cpuCount: 4,
      loadAverage: [0.4, 0.3, 0.2],
      memoryTotalBytes: 8_000,
      memoryAvailableBytes: 4_000,
      rootTotalBytes: 10_000,
      rootAvailableBytes: 6_000,
    },
    service: {
      available: true,
      ActiveState: "active",
      SubState: "running",
      NRestarts: "0",
      ExecMainStatus: "0",
    },
    docker: {
      available: true,
      containers: [{ name: "stugu-api-1", state: "running", health: "healthy", restartCount: 0 }],
      stats: [],
    },
    health: {
      available: true,
      status: "ok",
      database: "ready",
      systemVersion: "1.2.3",
      eventLoopLagMs: 1.5,
      telemetryArchive: { enabled: true, required: false, phase: "ready", caughtUp: true, timescaleAvailable: true },
    },
    database: {
      available: true,
      queues: {
        alertEvaluation: { count: 0, capped: false },
        notifications: { count: 0, capped: false, deadLettered: 0 },
        tapoExports: { count: 0, capped: false, needsAttention: 0 },
      },
      integrations: {
        homeAssistantMetrics: 2,
        tpLinkMetrics: 3,
        heatPumpConnections: 1,
        connectedDevices: 1,
      },
    },
    updater: { available: true, hardwareFingerprint: `sha256:${hex("3")}`, status: { phase: "idle" } },
    versions: { host: "1.2.3", release: { version: "1.2.3" } },
  };
}
