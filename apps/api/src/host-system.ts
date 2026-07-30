import { existsSync } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import {
  arch,
  availableParallelism,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from "node:os";
import { dirname, parse, resolve } from "node:path";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type {
  HostSystemAlert,
  HostSystemAlertMetric,
  HostSystemHealth,
  HostSystemState,
  HostSystemThresholds,
} from "@climate-twin/contracts";
import { hostSystemPrometheusMetrics } from "./host-system-prometheus.js";

const GIBIBYTE = 1_073_741_824;
const CPU_THRESHOLDS: HostSystemThresholds = {
  warningPercent: 85,
  criticalPercent: 95,
  warningAfterSeconds: 300,
  criticalAfterSeconds: 120,
};
const MEMORY_THRESHOLDS: HostSystemThresholds = {
  warningPercent: 85,
  criticalPercent: 95,
  warningAfterSeconds: 300,
  criticalAfterSeconds: 120,
};
const STORAGE_THRESHOLDS: HostSystemThresholds = {
  warningPercent: 85,
  criticalPercent: 95,
  warningAfterSeconds: 0,
  criticalAfterSeconds: 0,
};
const TEMPERATURE_THRESHOLDS: HostSystemThresholds = {
  warningPercent: 75,
  criticalPercent: 85,
  warningAfterSeconds: 120,
  criticalAfterSeconds: 30,
};
const EVENT_LOOP_THRESHOLDS = {
  warningMilliseconds: 250,
  criticalMilliseconds: 1_000,
  warningAfterSeconds: 120,
  criticalAfterSeconds: 30,
} as const;
const STORAGE_WARNING_AVAILABLE_BYTES = 5 * GIBIBYTE;
const STORAGE_CRITICAL_AVAILABLE_BYTES = GIBIBYTE;

export interface HostCpuTimes {
  idle: number;
  total: number;
}

export interface HostProcessCpuTimes {
  userMicroseconds: number;
  systemMicroseconds: number;
}

export interface HostStorageSpace {
  totalBytes: number;
  availableBytes: number;
}

export interface HostCgroupMemory {
  limitBytes: number;
  usedBytes: number;
}

export interface HostEventLoopDelaySample {
  p95Milliseconds: number;
  maxMilliseconds: number;
}

export interface HostSystemDataSource {
  nowMs(): number;
  hostname(): string;
  platform(): string;
  architecture(): string;
  release(): string;
  hostUptimeSeconds(): number;
  serviceUptimeSeconds(): number;
  logicalCores(): number;
  cpuTimes(): HostCpuTimes;
  processCpuTimes?(): HostProcessCpuTimes;
  loadAverage(): [number, number, number];
  hostTotalMemoryBytes(): number;
  hostFreeMemoryBytes(): number;
  processResidentMemoryBytes(): number;
  cgroupMemory(): Promise<HostCgroupMemory | null>;
  storage(path: string): Promise<HostStorageSpace>;
  cpuTemperatureCelsius(): Promise<number | null>;
  eventLoopDelayMilliseconds?(): HostEventLoopDelaySample | null;
}

export interface HostSystemMonitorOptions {
  storagePath: string;
  source?: HostSystemDataSource;
  sampleIntervalMs?: number;
  cpuSampleWindowMs?: number;
}

interface AlertCondition {
  metric: HostSystemAlertMetric;
  severity: "warning" | "critical";
  active: boolean;
  value: number | null;
  unit: HostSystemAlert["unit"];
  threshold: number | null;
  afterSeconds: number;
  message: string;
  recommendation: string;
}

function rounded(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

function percent(used: number, total: number): number {
  if (total <= 0) return 0;
  return rounded(Math.max(0, Math.min(100, used / total * 100)));
}

function thresholdState(value: number | null, thresholds: HostSystemThresholds): HostSystemState {
  if (value === null) return "unknown";
  if (value >= thresholds.criticalPercent) return "critical";
  if (value >= thresholds.warningPercent) return "warning";
  return "healthy";
}

function latencyState(value: number | null): HostSystemState {
  if (value === null) return "unknown";
  if (value >= EVENT_LOOP_THRESHOLDS.criticalMilliseconds) return "critical";
  if (value >= EVENT_LOOP_THRESHOLDS.warningMilliseconds) return "warning";
  return "healthy";
}

const statePriority: Record<HostSystemState, number> = {
  healthy: 0,
  unknown: 1,
  warning: 2,
  critical: 3,
};

function worstState(...states: HostSystemState[]): HostSystemState {
  return states.reduce((worst, state) => statePriority[state] > statePriority[worst] ? state : worst, "healthy");
}

function storageProbePath(databasePath: string): string {
  if (databasePath === ":memory:") return process.cwd();
  let candidate = dirname(resolve(databasePath));
  const root = parse(candidate).root;
  while (!existsSync(candidate) && candidate !== root) candidate = dirname(candidate);
  return candidate;
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

function positiveBytes(value: string | null): number | null {
  if (!value || value === "max") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function defaultCgroupMemory(): Promise<HostCgroupMemory | null> {
  const limit = positiveBytes(
    await optionalText("/sys/fs/cgroup/memory.max")
      ?? await optionalText("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
  );
  const used = positiveBytes(
    await optionalText("/sys/fs/cgroup/memory.current")
      ?? await optionalText("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
  );
  return limit !== null && used !== null ? { limitBytes: limit, usedBytes: used } : null;
}

async function defaultTemperature(): Promise<number | null> {
  const text = await optionalText("/sys/class/thermal/thermal_zone0/temp");
  if (!text) return null;
  const raw = Number(text);
  if (!Number.isFinite(raw)) return null;
  const value = Math.abs(raw) > 1_000 ? raw / 1_000 : raw;
  return value >= -20 && value <= 150 ? rounded(value) : null;
}

function currentCpuTimes(): HostCpuTimes {
  return cpus().reduce<HostCpuTimes>((sum, cpu) => {
    const values = Object.values(cpu.times);
    return {
      idle: sum.idle + cpu.times.idle,
      total: sum.total + values.reduce((total, value) => total + value, 0),
    };
  }, { idle: 0, total: 0 });
}

const defaultSource: HostSystemDataSource = {
  nowMs: () => Date.now(),
  hostname,
  platform,
  architecture: arch,
  release,
  hostUptimeSeconds: uptime,
  serviceUptimeSeconds: () => process.uptime(),
  logicalCores: () => availableParallelism(),
  cpuTimes: currentCpuTimes,
  processCpuTimes: () => {
    const value = process.cpuUsage();
    return { userMicroseconds: value.user, systemMicroseconds: value.system };
  },
  loadAverage: () => loadavg() as [number, number, number],
  hostTotalMemoryBytes: totalmem,
  hostFreeMemoryBytes: freemem,
  processResidentMemoryBytes: () => process.memoryUsage().rss,
  cgroupMemory: defaultCgroupMemory,
  storage: async (path) => {
    const value = await statfs(path);
    return {
      totalBytes: value.bsize * value.blocks,
      availableBytes: value.bsize * value.bavail,
    };
  },
  cpuTemperatureCelsius: defaultTemperature,
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref();
  });
}

function memoryRecommendation(): string {
  return "Pause unusually heavy imports or analytics and check whether a Stugu service is growing unexpectedly.";
}

function cpuRecommendation(): string {
  return "Check active imports, analytics, integrations, and any other workload running on the Stugu host.";
}

function storageRecommendation(): string {
  return "Free space on the Stugu data volume or expand it before history, backups, or updates are interrupted.";
}

function temperatureRecommendation(): string {
  return "Check airflow around the host, its fan or heatsink, and the room temperature.";
}

function eventLoopRecommendation(): string {
  return "Check integrations, history recovery, analytics, and other API work that may be blocking Stugu responses.";
}

export class HostSystemMonitor {
  readonly #source: HostSystemDataSource;
  readonly #storagePath: string;
  readonly #sampleIntervalMs: number;
  readonly #cpuSampleWindowMs: number;
  readonly #eventLoopHistogram: IntervalHistogram | null;
  readonly #crossedAt = new Map<string, number>();
  #previousCpu: HostCpuTimes | null = null;
  #previousProcessCpu: (HostProcessCpuTimes & { sampledAtMs: number }) | null = null;
  #current: HostSystemHealth | null = null;
  #refreshing: Promise<HostSystemHealth> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #eventLoopHistogramEnabled = false;

  constructor(options: HostSystemMonitorOptions) {
    this.#source = options.source ?? defaultSource;
    this.#storagePath = storageProbePath(options.storagePath);
    this.#sampleIntervalMs = Math.max(1_000, options.sampleIntervalMs ?? 30_000);
    this.#cpuSampleWindowMs = Math.max(0, options.cpuSampleWindowMs ?? 100);
    this.#eventLoopHistogram = options.source ? null : monitorEventLoopDelay({ resolution: 20 });
  }

  start(): void {
    if (this.#timer) return;
    if (this.#eventLoopHistogram && !this.#eventLoopHistogramEnabled) {
      this.#eventLoopHistogram.enable();
      this.#eventLoopHistogramEnabled = true;
    }
    void this.refresh().catch(() => undefined);
    this.#timer = setInterval(() => void this.refresh().catch(() => undefined), this.#sampleIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#eventLoopHistogramEnabled) {
      this.#eventLoopHistogram?.disable();
      this.#eventLoopHistogram?.reset();
      this.#eventLoopHistogramEnabled = false;
    }
  }

  async snapshot(): Promise<HostSystemHealth> {
    const stale = !this.#current
      || this.#source.nowMs() - Date.parse(this.#current.sampledAt) >= this.#sampleIntervalMs;
    return stale ? this.refresh() : this.#current!;
  }

  async refresh(): Promise<HostSystemHealth> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#collect().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async prometheusMetrics(): Promise<string> {
    return hostSystemPrometheusMetrics(await this.snapshot());
  }

  async #cpuUsagePercent(): Promise<number | null> {
    let first = this.#previousCpu;
    if (!first) {
      first = this.#source.cpuTimes();
      if (this.#cpuSampleWindowMs > 0) await wait(this.#cpuSampleWindowMs);
    }
    const second = this.#source.cpuTimes();
    this.#previousCpu = second;
    const total = second.total - first.total;
    const idle = second.idle - first.idle;
    return total > 0 ? rounded(Math.max(0, Math.min(100, (1 - idle / total) * 100))) : null;
  }

  #processCpuUsagePercent(nowMs: number): number | null {
    const current = this.#source.processCpuTimes?.();
    if (!current) return null;
    const previous = this.#previousProcessCpu;
    this.#previousProcessCpu = { ...current, sampledAtMs: nowMs };
    if (!previous || nowMs <= previous.sampledAtMs) return null;
    const cpuMilliseconds = (
      current.userMicroseconds - previous.userMicroseconds
      + current.systemMicroseconds - previous.systemMicroseconds
    ) / 1_000;
    const elapsedMilliseconds = nowMs - previous.sampledAtMs;
    const maximum = Math.max(1, this.#source.logicalCores()) * 100;
    return rounded(Math.max(0, Math.min(maximum, cpuMilliseconds / elapsedMilliseconds * 100)));
  }

  #eventLoopDelayMilliseconds(): HostEventLoopDelaySample | null {
    const supplied = this.#source.eventLoopDelayMilliseconds?.();
    if (supplied) {
      return {
        p95Milliseconds: rounded(Math.max(0, supplied.p95Milliseconds), 2),
        maxMilliseconds: rounded(Math.max(0, supplied.maxMilliseconds), 2),
      };
    }
    const histogram = this.#eventLoopHistogram;
    if (!histogram || histogram.count === 0) return null;
    const sample = {
      p95Milliseconds: rounded(histogram.percentile(95) / 1_000_000, 2),
      maxMilliseconds: rounded(histogram.max / 1_000_000, 2),
    };
    histogram.reset();
    return sample;
  }

  #alerts(now: number, conditions: AlertCondition[]): HostSystemAlert[] {
    const matured: Array<{ condition: AlertCondition; startedAt: number }> = [];
    for (const condition of conditions) {
      const key = `${condition.metric}:${condition.severity}`;
      if (!condition.active) {
        this.#crossedAt.delete(key);
        continue;
      }
      if (!this.#crossedAt.has(key)) this.#crossedAt.set(key, now);
      const startedAt = this.#crossedAt.get(key) ?? now;
      if (now - startedAt >= condition.afterSeconds * 1_000) {
        matured.push({ condition, startedAt });
      }
    }
    const selected = new Map<HostSystemAlertMetric, { condition: AlertCondition; startedAt: number }>();
    for (const candidate of matured) {
      const current = selected.get(candidate.condition.metric);
      if (!current || candidate.condition.severity === "critical") {
        selected.set(candidate.condition.metric, candidate);
      }
    }
    return [...selected.values()].map(({ condition, startedAt }) => ({
        id: `host-system-${condition.metric}-${condition.severity}`,
        metric: condition.metric,
        severity: condition.severity,
        value: condition.value,
        unit: condition.unit,
        threshold: condition.threshold,
        startedAt: new Date(startedAt).toISOString(),
        message: condition.message,
        recommendation: condition.recommendation,
      }));
  }

  async #collect(): Promise<HostSystemHealth> {
    const now = this.#source.nowMs();
    const [usagePercent, cgroup, temperatureCelsius, storageResult] = await Promise.all([
      this.#cpuUsagePercent(),
      this.#source.cgroupMemory().catch(() => null),
      this.#source.cpuTemperatureCelsius().catch(() => null),
      this.#source.storage(this.#storagePath).then(
        (value) => ({ value, error: false as const }),
        () => ({ value: null, error: true as const }),
      ),
    ]);
    const eventLoopDelay = this.#eventLoopDelayMilliseconds();
    const processUsagePercent = this.#processCpuUsagePercent(this.#source.nowMs());
    const hostMemoryTotal = this.#source.hostTotalMemoryBytes();
    const useCgroup = Boolean(cgroup && cgroup.limitBytes < hostMemoryTotal * 0.99);
    const memoryTotal = useCgroup ? cgroup!.limitBytes : hostMemoryTotal;
    const memoryUsed = Math.min(
      memoryTotal,
      Math.max(0, useCgroup ? cgroup!.usedBytes : memoryTotal - this.#source.hostFreeMemoryBytes()),
    );
    const memoryUsedPercent = percent(memoryUsed, memoryTotal);
    const storageTotal = storageResult.value?.totalBytes ?? null;
    const storageAvailable = storageResult.value?.availableBytes ?? null;
    const storageUsed = storageTotal === null || storageAvailable === null
      ? null
      : Math.max(0, storageTotal - storageAvailable);
    const storageUsedPercent = storageUsed === null || storageTotal === null
      ? null
      : percent(storageUsed, storageTotal);
    const cpuStrainPercent = usagePercent === null
      ? processUsagePercent
      : processUsagePercent === null
        ? usagePercent
        : Math.max(usagePercent, processUsagePercent);
    const cpuUsageState = thresholdState(cpuStrainPercent, CPU_THRESHOLDS);
    const eventLoopState = latencyState(eventLoopDelay?.p95Milliseconds ?? null);
    const measuredEventLoopState = eventLoopDelay === null ? "healthy" : eventLoopState;
    const temperatureState = temperatureCelsius === null
      ? "healthy"
      : thresholdState(temperatureCelsius, TEMPERATURE_THRESHOLDS);
    const memoryState = thresholdState(memoryUsedPercent, MEMORY_THRESHOLDS);
    const storageState = storageUsedPercent === null
      ? "unknown"
      : storageAvailable! <= STORAGE_CRITICAL_AVAILABLE_BYTES
        || storageUsedPercent >= STORAGE_THRESHOLDS.criticalPercent
        ? "critical"
        : storageAvailable! <= STORAGE_WARNING_AVAILABLE_BYTES
          || storageUsedPercent >= STORAGE_THRESHOLDS.warningPercent
          ? "warning"
          : "healthy";
    const conditions: AlertCondition[] = [
      {
        metric: "cpu", severity: "warning",
        active: cpuStrainPercent !== null && cpuStrainPercent >= CPU_THRESHOLDS.warningPercent,
        value: cpuStrainPercent, unit: "%", threshold: CPU_THRESHOLDS.warningPercent,
        afterSeconds: CPU_THRESHOLDS.warningAfterSeconds,
        message: `CPU use has stayed above ${CPU_THRESHOLDS.warningPercent}%.`,
        recommendation: cpuRecommendation(),
      },
      {
        metric: "cpu", severity: "critical",
        active: cpuStrainPercent !== null && cpuStrainPercent >= CPU_THRESHOLDS.criticalPercent,
        value: cpuStrainPercent, unit: "%", threshold: CPU_THRESHOLDS.criticalPercent,
        afterSeconds: CPU_THRESHOLDS.criticalAfterSeconds,
        message: `CPU use has stayed above ${CPU_THRESHOLDS.criticalPercent}%.`,
        recommendation: cpuRecommendation(),
      },
      {
        metric: "event-loop", severity: "warning",
        active: eventLoopDelay !== null
          && eventLoopDelay.p95Milliseconds >= EVENT_LOOP_THRESHOLDS.warningMilliseconds,
        value: eventLoopDelay?.p95Milliseconds ?? null,
        unit: "ms",
        threshold: EVENT_LOOP_THRESHOLDS.warningMilliseconds,
        afterSeconds: EVENT_LOOP_THRESHOLDS.warningAfterSeconds,
        message: `API response scheduling has stayed above ${EVENT_LOOP_THRESHOLDS.warningMilliseconds} ms (p95).`,
        recommendation: eventLoopRecommendation(),
      },
      {
        metric: "event-loop", severity: "critical",
        active: eventLoopDelay !== null
          && eventLoopDelay.p95Milliseconds >= EVENT_LOOP_THRESHOLDS.criticalMilliseconds,
        value: eventLoopDelay?.p95Milliseconds ?? null,
        unit: "ms",
        threshold: EVENT_LOOP_THRESHOLDS.criticalMilliseconds,
        afterSeconds: EVENT_LOOP_THRESHOLDS.criticalAfterSeconds,
        message: `API response scheduling has stayed above ${EVENT_LOOP_THRESHOLDS.criticalMilliseconds} ms (p95).`,
        recommendation: eventLoopRecommendation(),
      },
      {
        metric: "memory", severity: "warning",
        active: memoryUsedPercent >= MEMORY_THRESHOLDS.warningPercent,
        value: memoryUsedPercent, unit: "%", threshold: MEMORY_THRESHOLDS.warningPercent,
        afterSeconds: MEMORY_THRESHOLDS.warningAfterSeconds,
        message: `Memory use has stayed above ${MEMORY_THRESHOLDS.warningPercent}%.`,
        recommendation: memoryRecommendation(),
      },
      {
        metric: "memory", severity: "critical",
        active: memoryUsedPercent >= MEMORY_THRESHOLDS.criticalPercent,
        value: memoryUsedPercent, unit: "%", threshold: MEMORY_THRESHOLDS.criticalPercent,
        afterSeconds: MEMORY_THRESHOLDS.criticalAfterSeconds,
        message: `Memory use has stayed above ${MEMORY_THRESHOLDS.criticalPercent}%.`,
        recommendation: memoryRecommendation(),
      },
      {
        metric: "storage", severity: "warning",
        active: storageUsedPercent !== null && (
          storageUsedPercent >= STORAGE_THRESHOLDS.warningPercent
          || storageAvailable! <= STORAGE_WARNING_AVAILABLE_BYTES
        ),
        value: storageUsedPercent, unit: "%", threshold: STORAGE_THRESHOLDS.warningPercent,
        afterSeconds: 0,
        message: storageAvailable === null
          ? "Storage space could not be measured."
          : `The Stugu data volume has ${rounded(storageAvailable / GIBIBYTE)} GiB available.`,
        recommendation: storageRecommendation(),
      },
      {
        metric: "storage", severity: "critical",
        active: storageUsedPercent !== null && (
          storageUsedPercent >= STORAGE_THRESHOLDS.criticalPercent
          || storageAvailable! <= STORAGE_CRITICAL_AVAILABLE_BYTES
        ),
        value: storageUsedPercent, unit: "%", threshold: STORAGE_THRESHOLDS.criticalPercent,
        afterSeconds: 0,
        message: storageAvailable === null
          ? "Storage space could not be measured."
          : `The Stugu data volume has only ${rounded(storageAvailable / GIBIBYTE)} GiB available.`,
        recommendation: storageRecommendation(),
      },
      {
        metric: "temperature", severity: "warning",
        active: temperatureCelsius !== null && temperatureCelsius >= TEMPERATURE_THRESHOLDS.warningPercent,
        value: temperatureCelsius, unit: "°C", threshold: TEMPERATURE_THRESHOLDS.warningPercent,
        afterSeconds: TEMPERATURE_THRESHOLDS.warningAfterSeconds,
        message: `The host temperature has stayed above ${TEMPERATURE_THRESHOLDS.warningPercent} °C.`,
        recommendation: temperatureRecommendation(),
      },
      {
        metric: "temperature", severity: "critical",
        active: temperatureCelsius !== null && temperatureCelsius >= TEMPERATURE_THRESHOLDS.criticalPercent,
        value: temperatureCelsius, unit: "°C", threshold: TEMPERATURE_THRESHOLDS.criticalPercent,
        afterSeconds: TEMPERATURE_THRESHOLDS.criticalAfterSeconds,
        message: `The host temperature has stayed above ${TEMPERATURE_THRESHOLDS.criticalPercent} °C.`,
        recommendation: temperatureRecommendation(),
      },
    ];
    const alerts = this.#alerts(now, conditions);
    if (storageResult.error) {
      alerts.push({
        id: "host-system-storage-warning",
        metric: "storage",
        severity: "warning",
        value: null,
        unit: null,
        threshold: null,
        startedAt: new Date(now).toISOString(),
        message: "Stugu could not measure the available space on its data volume.",
        recommendation: "Check that the data volume is mounted and readable by the Stugu service.",
      });
    }
    const alertState: HostSystemState = alerts.some((alert) => alert.severity === "critical")
      ? "critical"
      : alerts.length ? "warning" : "healthy";
    const health: HostSystemHealth = {
      state: worstState(
        worstState(cpuUsageState, temperatureState, measuredEventLoopState),
        memoryState,
        storageState,
        alertState,
      ),
      sampledAt: new Date(now).toISOString(),
      hostname: this.#source.hostname(),
      platform: this.#source.platform(),
      architecture: this.#source.architecture(),
      release: this.#source.release(),
      hostUptimeSeconds: Math.round(this.#source.hostUptimeSeconds()),
      serviceUptimeSeconds: Math.round(this.#source.serviceUptimeSeconds()),
      cpu: {
        state: worstState(cpuUsageState, temperatureState),
        usagePercent,
        processUsagePercent,
        logicalCores: Math.max(1, this.#source.logicalCores()),
        loadAverage: this.#source.loadAverage().map((value) => rounded(value, 2)) as [number, number, number],
        temperatureCelsius,
        usageThresholds: CPU_THRESHOLDS,
        temperatureThresholds: TEMPERATURE_THRESHOLDS,
        eventLoop: {
          state: eventLoopState,
          p95Milliseconds: eventLoopDelay?.p95Milliseconds ?? null,
          maxMilliseconds: eventLoopDelay?.maxMilliseconds ?? null,
          thresholds: EVENT_LOOP_THRESHOLDS,
        },
      },
      memory: {
        state: memoryState,
        scope: useCgroup ? "container" : "host",
        totalBytes: memoryTotal,
        usedBytes: memoryUsed,
        availableBytes: Math.max(0, memoryTotal - memoryUsed),
        usedPercent: memoryUsedPercent,
        processResidentBytes: this.#source.processResidentMemoryBytes(),
        thresholds: MEMORY_THRESHOLDS,
      },
      storage: {
        state: storageState,
        totalBytes: storageTotal,
        usedBytes: storageUsed,
        availableBytes: storageAvailable,
        usedPercent: storageUsedPercent,
        thresholds: STORAGE_THRESHOLDS,
        warningAvailableBytes: STORAGE_WARNING_AVAILABLE_BYTES,
        criticalAvailableBytes: STORAGE_CRITICAL_AVAILABLE_BYTES,
      },
      alerts,
    };
    this.#current = health;
    return health;
  }
}
