import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  HostSystemMonitor,
  type HostCpuTimes,
  type HostSystemDataSource,
} from "../src/host-system.js";
import { createApi } from "../src/app.js";
import { config } from "./appTestSupport.js";

const GIBIBYTE = 1_073_741_824;

function source(options: {
  now: () => number;
  cpu: HostCpuTimes[];
  memoryUsedPercent?: number;
  storageAvailableGiB?: number;
  temperatureCelsius?: number | null;
}): HostSystemDataSource {
  let cpuIndex = 0;
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
    loadAverage: () => [0.4, 0.3, 0.2],
    hostTotalMemoryBytes: () => 8 * GIBIBYTE,
    hostFreeMemoryBytes: () => 4 * GIBIBYTE,
    processResidentMemoryBytes: () => 128 * 1_048_576,
    cgroupMemory: async () => ({
      limitBytes: memoryLimit,
      usedBytes: memoryLimit * (options.memoryUsedPercent ?? 50) / 100,
    }),
    storage: async () => ({
      totalBytes: 100 * GIBIBYTE,
      availableBytes: (options.storageAvailableGiB ?? 60) * GIBIBYTE,
    }),
    cpuTemperatureCelsius: async () => options.temperatureCelsius ?? null,
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
      }),
    });

    const health = await monitor.refresh();

    expect(health).toMatchObject({
      state: "healthy",
      sampledAt: "2026-07-30T12:00:00.000Z",
      cpu: { usagePercent: 20, logicalCores: 4 },
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

  it("serves owner-only JSON health and Prometheus representations", async () => {
    const runtime = createApi({ config, startBackground: false });
    try {
      await request(runtime.app).get("/api/v1/system/health").expect(200).expect(({ body }) => {
        expect(body).toMatchObject({
          sampledAt: expect.any(String),
          cpu: { usagePercent: expect.any(Number) },
          memory: { totalBytes: expect.any(Number), usedPercent: expect.any(Number) },
          storage: { totalBytes: expect.any(Number), usedPercent: expect.any(Number) },
          alerts: expect.any(Array),
        });
      });
      await request(runtime.app).get("/api/v1/system/metrics").expect(200).expect(({ text, headers }) => {
        expect(headers["content-type"]).toContain("text/plain");
        expect(text).toContain("# TYPE stugu_host_cpu_usage_percent gauge");
        expect(text).toContain("stugu_host_storage_bytes");
      });
      await request(runtime.app).get("/api/v1/openapi.json").expect(200).expect(({ body }) => {
        expect(body.paths["/system/health"].get.operationId).toBe("getHostSystemHealth");
        expect(body.paths["/system/metrics"].get.operationId).toBe("getHostSystemPrometheusMetrics");
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
    } finally {
      await runtime.close();
    }
  });
});
