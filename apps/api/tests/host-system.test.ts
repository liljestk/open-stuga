import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  HostSystemMonitor,
  type HostCpuTimes,
  type HostProcessCpuTimes,
  type HostSystemDataSource,
} from "../src/host-system.js";
import { createApi } from "../src/app.js";
import { enqueueHostSystemAlertNotifications } from "../src/host-system-notifications.js";
import { redactSystemErrorMessage } from "../src/system-error-log.js";
import { config } from "./appTestSupport.js";

const GIBIBYTE = 1_073_741_824;

function source(options: {
  now: () => number;
  cpu: HostCpuTimes[];
  memoryUsedPercent?: number;
  storageAvailableGiB?: number | (() => number);
  temperatureCelsius?: number | null;
  eventLoopP95Milliseconds?: number | null;
  eventLoopMaxMilliseconds?: number | null;
  processCpu?: HostProcessCpuTimes[];
}): HostSystemDataSource {
  let cpuIndex = 0;
  let processCpuIndex = 0;
  const memoryLimit = 2 * GIBIBYTE;
  return {
    nowMs: options.now,
    hostname: () => "stugu-test",
    platform: () => "linux",
    architecture: () => "arm64",
    release: () => "test",
    hostUptimeSeconds: () => 7_200,
    serviceUptimeSeconds: () => 600,
    logicalCores: () => 4,
    cpuTimes: () => options.cpu[Math.min(cpuIndex++, options.cpu.length - 1)]!,
    ...(options.processCpu ? {
      processCpuTimes: () => options.processCpu![Math.min(processCpuIndex++, options.processCpu!.length - 1)]!,
    } : {}),
    loadAverage: () => [0.4, 0.3, 0.2],
    hostTotalMemoryBytes: () => 8 * GIBIBYTE,
    hostFreeMemoryBytes: () => 4 * GIBIBYTE,
    processResidentMemoryBytes: () => 128 * 1_048_576,
    cgroupMemory: async () => ({
      limitBytes: memoryLimit,
      usedBytes: memoryLimit * (options.memoryUsedPercent ?? 50) / 100,
    }),
    storage: async () => {
      const available = typeof options.storageAvailableGiB === "function"
        ? options.storageAvailableGiB()
        : options.storageAvailableGiB ?? 60;
      return { totalBytes: 100 * GIBIBYTE, availableBytes: available * GIBIBYTE };
    },
    cpuTemperatureCelsius: async () => options.temperatureCelsius ?? null,
    eventLoopDelayMilliseconds: () => options.eventLoopP95Milliseconds === undefined
      || options.eventLoopP95Milliseconds === null
      ? null
      : {
        p95Milliseconds: options.eventLoopP95Milliseconds,
        maxMilliseconds: options.eventLoopMaxMilliseconds ?? options.eventLoopP95Milliseconds,
      },
  };
}

describe("host system monitoring", () => {
  it("reports cgroup-aware CPU, memory, storage, and Prometheus metrics", async () => {
    const now = Date.parse("2026-07-30T12:00:00.000Z");
    const monitor = new HostSystemMonitor({
      storagePath: ":memory:",
      cpuSampleWindowMs: 0,
      source: source({
        now: () => now,
        cpu: [{ idle: 0, total: 0 }, { idle: 80, total: 100 }],
        eventLoopP95Milliseconds: 24.25,
        eventLoopMaxMilliseconds: 63.5,
      }),
    });

    const health = await monitor.refresh();

    expect(health).toMatchObject({
      state: "healthy",
      sampledAt: "2026-07-30T12:00:00.000Z",
      cpu: {
        usagePercent: 20,
        logicalCores: 4,
        eventLoop: { state: "healthy", p95Milliseconds: 24.25, maxMilliseconds: 63.5 },
      },
      memory: {
        scope: "container",
        totalBytes: 2 * GIBIBYTE,
        usedBytes: GIBIBYTE,
        usedPercent: 50,
      },
      storage: {
        totalBytes: 100 * GIBIBYTE,
        availableBytes: 60 * GIBIBYTE,
        usedPercent: 40,
      },
      alerts: [],
    });
    const metrics = await monitor.prometheusMetrics();
    expect(metrics).toContain("stugu_host_cpu_usage_percent 20");
    expect(metrics).toContain('stugu_process_event_loop_delay_seconds{statistic="p95"} 0.02425');
    expect(metrics).toContain('stugu_host_memory_bytes{state="total",scope="container"} 2147483648');
    expect(metrics).toContain('stugu_host_alert_active{metric="storage",severity="critical"} 0');
  });

  it("raises immediate low-storage alerts and sustained strain alerts", async () => {
    let now = Date.parse("2026-07-30T12:00:00.000Z");
    const monitor = new HostSystemMonitor({
      storagePath: ":memory:",
      cpuSampleWindowMs: 0,
      source: source({
        now: () => now,
        cpu: [
          { idle: 0, total: 0 },
          { idle: 10, total: 100 },
          { idle: 20, total: 200 },
          { idle: 21, total: 300 },
          { idle: 22, total: 400 },
        ],
        memoryUsedPercent: 90,
        storageAvailableGiB: 0.5,
        temperatureCelsius: 80,
        eventLoopP95Milliseconds: 300,
      }),
    });

    const first = await monitor.refresh();
    expect(first.alerts).toEqual([
      expect.objectContaining({ metric: "storage", severity: "critical" }),
    ]);

    now += 301_000;
    const sustained = await monitor.refresh();
    expect(sustained.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "cpu", severity: "warning" }),
      expect.objectContaining({ metric: "event-loop", severity: "warning" }),
      expect.objectContaining({ metric: "memory", severity: "warning" }),
      expect.objectContaining({ metric: "storage", severity: "critical" }),
      expect.objectContaining({ metric: "temperature", severity: "warning" }),
    ]));
    expect(sustained.state).toBe("critical");

    now += 1_000;
    const escalating = await monitor.refresh();
    expect(escalating.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "cpu", severity: "warning" }),
    ]));

    now += 121_000;
    const escalated = await monitor.refresh();
    expect(escalated.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "cpu", severity: "critical" }),
    ]));
  });

  it("detects one saturated API core even when aggregate host CPU is modest", async () => {
    let now = Date.parse("2026-07-30T12:00:00.000Z");
    const monitor = new HostSystemMonitor({
      storagePath: ":memory:",
      cpuSampleWindowMs: 0,
      source: source({
        now: () => now,
        cpu: [
          { idle: 0, total: 0 },
          { idle: 80, total: 100 },
          { idle: 160, total: 200 },
          { idle: 240, total: 300 },
        ],
        processCpu: [
          { userMicroseconds: 0, systemMicroseconds: 0 },
          { userMicroseconds: 121_000_000, systemMicroseconds: 0 },
          { userMicroseconds: 242_000_000, systemMicroseconds: 0 },
        ],
      }),
    });

    await monitor.refresh();
    now += 121_000;
    const saturated = await monitor.refresh();
    expect(saturated.cpu).toMatchObject({ usagePercent: 20, processUsagePercent: 100, state: "critical" });
    expect(saturated.alerts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "cpu" }),
    ]));

    now += 121_000;
    const sustained = await monitor.refresh();
    expect(sustained.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "cpu", severity: "critical", value: 100 }),
    ]));
    expect(await monitor.prometheusMetrics()).toContain("stugu_process_cpu_usage_percent 100");
  });

  it("reports an event-loop-only stall without mislabeling CPU as strained", async () => {
    const now = Date.parse("2026-07-30T12:00:00.000Z");
    const monitor = new HostSystemMonitor({
      storagePath: ":memory:",
      cpuSampleWindowMs: 0,
      source: source({
        now: () => now,
        cpu: [{ idle: 0, total: 0 }, { idle: 80, total: 100 }],
        eventLoopP95Milliseconds: 1_500,
      }),
    });

    const health = await monitor.refresh();

    expect(health.state).toBe("critical");
    expect(health.cpu.state).toBe("healthy");
    expect(health.cpu.eventLoop.state).toBe("critical");
  });

  it("projects sustained storage growth without alerting on low-confidence history", async () => {
    let now = Date.parse("2026-07-30T12:00:00.000Z");
    let availableGiB = 60;
    const monitor = new HostSystemMonitor({
      storagePath: ":memory:",
      cpuSampleWindowMs: 0,
      source: source({
        now: () => now,
        cpu: [{ idle: 0, total: 0 }, { idle: 80, total: 100 }],
        storageAvailableGiB: () => availableGiB,
      }),
    });

    await monitor.refresh();
    for (const nextAvailable of [50, 40]) {
      now += 8 * 60 * 60_000;
      availableGiB = nextAvailable;
      const lowConfidence = await monitor.refresh();
      expect(lowConfidence.alerts).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ metric: "storage-forecast" }),
      ]));
    }
    now += 8 * 60 * 60_000;
    availableGiB = 30;
    const projected = await monitor.refresh();

    expect(projected.storage.forecast).toMatchObject({
      state: "projected",
      confidence: "medium",
      sampleCount: 4,
      growthBytesPerDay: 30 * GIBIBYTE,
      warningAt: expect.any(String),
      criticalAt: expect.any(String),
    });
    expect(projected.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "storage-forecast", severity: "critical" }),
    ]));
    expect(await monitor.prometheusMetrics()).toContain("stugu_host_storage_growth_bytes_per_day");
  });

  it("keeps a storage-probe alert stable across repeated failed samples", async () => {
    let now = Date.parse("2026-07-30T12:00:00.000Z");
    const failingSource = source({ now: () => now, cpu: [{ idle: 0, total: 0 }, { idle: 80, total: 100 }] });
    failingSource.storage = async () => { throw new Error("volume unavailable"); };
    const monitor = new HostSystemMonitor({ storagePath: ":memory:", cpuSampleWindowMs: 0, source: failingSource });
    const first = await monitor.refresh();
    now += 30_000;
    const second = await monitor.refresh();
    expect(second.alerts.find((alert) => alert.metric === "storage")?.startedAt)
      .toBe(first.alerts.find((alert) => alert.metric === "storage")?.startedAt);
  });

  it("serves owner-only JSON health and Prometheus representations", async () => {
    const runtime = createApi({ config, startBackground: false });
    try {
      await request(runtime.app).get("/api/v1/system/health").expect(200).expect(({ body }) => {
        expect(body).toMatchObject({
          sampledAt: expect.any(String),
          cpu: { usagePercent: expect.any(Number) },
          memory: { totalBytes: expect.any(Number), usedPercent: expect.any(Number) },
          storage: { totalBytes: expect.any(Number), usedPercent: expect.any(Number) },
          database: { sqlite: { sizeBytes: expect.any(Number), tableCount: expect.any(Number) } },
          alertDelivery: { telegram: { configured: false } },
          alerts: expect.any(Array),
        });
      });
      await request(runtime.app).get("/api/v1/system/metrics").expect(200).expect(({ text, headers }) => {
        expect(headers["content-type"]).toContain("text/plain");
        expect(text).toContain("# TYPE stugu_host_cpu_usage_percent gauge");
        expect(text).toContain("stugu_host_storage_bytes");
        expect(text).toContain("stugu_sqlite_database_bytes");
      });
      runtime.systemErrorLog.record({
        source: "test",
        code: "EXPORT_TEST",
        message: "token=super-secret owner@example.test https://private.test/path?q=secret",
      });
      await request(runtime.app).get("/api/v1/system/error-logs").expect(200).expect(({ text, headers }) => {
        expect(headers["content-type"]).toContain("application/x-ndjson");
        expect(headers["content-disposition"]).toContain("stugu-error-logs-");
        expect(text).toContain("EXPORT_TEST");
        expect(text).toContain("[redacted]");
        expect(text).not.toContain("super-secret");
        expect(text).not.toContain("owner@example.test");
        expect(text).not.toContain("private.test");
      });
      await request(runtime.app).get("/api/v1/openapi.json").expect(200).expect(({ body }) => {
        expect(body.paths["/system/health"].get.operationId).toBe("getHostSystemHealth");
        expect(body.paths["/system/metrics"].get.operationId).toBe("getHostSystemPrometheusMetrics");
        expect(body.paths["/system/error-logs"].get.operationId).toBe("exportSystemErrorLogs");
      });
    } finally {
      await runtime.close();
    }
  });

  it("lets a metrics collector use only the configured machine key", async () => {
    const runtime = createApi({
      config: { ...config, localAuthTestBypass: false, ingestApiKey: "metrics-test-key" },
      startBackground: false,
    });
    try {
      await request(runtime.app).post("/api/v1/auth/setup").send({
        email: "owner@stugu.test",
        password: "owner-password-1234",
      }).expect(201);
      await request(runtime.app).get("/api/v1/system/metrics").expect(401);
      await request(runtime.app).get("/api/v1/system/metrics")
        .set("x-api-key", "metrics-test-key")
        .expect(200)
        .expect(({ text }) => expect(text).toContain("stugu_host_health_state"));
      await request(runtime.app).get("/api/v1/system/health")
        .set("x-api-key", "metrics-test-key")
        .expect(401);
      await request(runtime.app).get("/api/v1/system/error-logs")
        .set("x-api-key", "metrics-test-key")
        .expect(401);
    } finally {
      await runtime.close();
    }
  });

  it("deduplicates active Telegram host alerts and queues a recovery", async () => {
    const telegramConfig = {
      ...config,
      telegramBotToken: "123456:abcdefghijklmnopqrstuvwxyzABCDE",
      telegramChatId: "99112233",
    };
    const runtime = createApi({ config: telegramConfig, startBackground: false });
    try {
      const baseline = await runtime.hostSystem.refresh();
      const alert = {
        id: "host-system-database-warning",
        metric: "database" as const,
        severity: "warning" as const,
        value: null,
        unit: null,
        threshold: null,
        startedAt: baseline.sampledAt,
        message: "The telemetry database is unavailable.",
        recommendation: "Check the database.",
      };
      const active = { ...baseline, state: "warning" as const, alerts: [...baseline.alerts, alert] };
      expect(enqueueHostSystemAlertNotifications(runtime.database, telegramConfig, {
        previous: baseline,
        current: active,
      })).toBe(1);
      expect(enqueueHostSystemAlertNotifications(runtime.database, telegramConfig, {
        previous: active,
        current: active,
      })).toBe(0);
      const critical = {
        ...alert,
        id: "host-system-database-critical",
        severity: "critical" as const,
        startedAt: new Date(Date.parse(alert.startedAt) + 1_000).toISOString(),
      };
      const escalated = { ...active, state: "critical" as const, alerts: [...active.alerts, critical] };
      expect(enqueueHostSystemAlertNotifications(runtime.database, telegramConfig, {
        previous: active,
        current: escalated,
      })).toBe(1);
      expect(enqueueHostSystemAlertNotifications(runtime.database, telegramConfig, {
        previous: escalated,
        current: active,
      })).toBe(1);
      const recovered = {
        ...baseline,
        sampledAt: new Date(Date.parse(baseline.sampledAt) + 60_000).toISOString(),
      };
      expect(enqueueHostSystemAlertNotifications(runtime.database, telegramConfig, {
        previous: active,
        current: recovered,
      })).toBe(1);
      expect(runtime.database.listNotificationDeliveries()).toEqual(expect.arrayContaining([
        expect.objectContaining({ subjectKind: "system", stage: "initial", channel: "telegram" }),
        expect.objectContaining({ subjectKind: "system", stage: "resolved", channel: "telegram" }),
      ]));
    } finally {
      await runtime.close();
    }
  });

  it("redacts credentials and personal identifiers before log storage", () => {
    const redacted = redactSystemErrorMessage(
      "Bearer abc token=secret user@example.test 192.168.1.8 123456:abcdefghijklmnopqrstuvwxyzABCDE C:\\Users\\owner\\private.db /home/owner/private.db",
    );
    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("user@example.test");
    expect(redacted).not.toContain("192.168.1.8");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyzABCDE");
    expect(redacted).not.toContain("owner");
    expect(redacted).not.toContain("private.db");
  });
});
