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
import type {
  HostSystemAlert,
  HostSystemAlertMetric,
  HostSystemHealth,
  HostSystemState,
  HostSystemThresholds,
} from "@climate-twin/contracts";

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
const STORAGE_WARNING_AVAILABLE_BYTES = 5 * GIBIBYTE;
const STORAGE_CRITICAL_AVAILABLE_BYTES = GIBIBYTE;

export interface HostCpuTimes {
  idle: number;
  total: number;
}

export interface HostStorageSpace {
  totalBytes: number;
  availableBytes: number;
}

export interface HostCgroupMemory {
  limitBytes: number;
  usedBytes: number;
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
  loadAverage(): [number, number, number];
  hostTotalMemoryBytes(): number;
  hostFreeMemoryBytes(): number;
  processResidentMemoryBytes(): number;
  cgroupMemory(): Promise<HostCgroupMemory | null>;
  storage(path: string): Promise<HostStorageSpace>;
  cpuTemperatureCelsius(): Promise<number | null>;
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

export class HostSystemMonitor {
  readonly #source: HostSystemDataSource;
  readonly #storagePath: string;
  readonly #sampleIntervalMs: number;
  readonly #cpuSampleWindowMs: number;
  readonly #crossedAt = new Map<string, number>();
  #previousCpu: HostCpuTimes | null = null;
  #current: HostSystemHealth | null = null;
  #refreshing: Promise<HostSystemHealth> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: HostSystemMonitorOptions) {
    this.#source = options.source ?? defaultSource;
    this.#storagePath = storageProbePath(options.storagePath);
    this.#sampleIntervalMs = Math.max(1_000, options.sampleIntervalMs ?? 30_000);
    this.#cpuSampleWindowMs = Math.max(0, options.cpuSampleWindowMs ?? 100);
  }

  start(): void {
    if (this.#timer) return;
    void this.refresh().catch(() => undefined);
    this.#timer = setInterval(() => void this.refresh().catch(() => undefined), this.#sampleIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
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
    const cpuUsageState = thresholdState(usagePercent, CPU_THRESHOLDS);
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
        active: usagePercent !== null && usagePercent >= CPU_THRESHOLDS.warningPercent,
        value: usagePercent, unit: "%", threshold: CPU_THRESHOLDS.warningPercent,
        afterSeconds: CPU_THRESHOLDS.warningAfterSeconds,
        message: `CPU use has stayed above ${CPU_THRESHOLDS.warningPercent}%.`,
        recommendation: cpuRecommendation(),
      },
      {
        metric: "cpu", severity: "critical",
        active: usagePercent !== null && usagePercent >= CPU_THRESHOLDS.criticalPercent,
        value: usagePercent, unit: "%", threshold: CPU_THRESHOLDS.criticalPercent,
        afterSeconds: CPU_THRESHOLDS.criticalAfterSeconds,
        message: `CPU use has stayed above ${CPU_THRESHOLDS.criticalPercent}%.`,
        recommendation: cpuRecommendation(),
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
        worstState(cpuUsageState, temperatureState),
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
        logicalCores: Math.max(1, this.#source.logicalCores()),
        loadAverage: this.#source.loadAverage().map((value) => rounded(value, 2)) as [number, number, number],
        temperatureCelsius,
        usageThresholds: CPU_THRESHOLDS,
        temperatureThresholds: TEMPERATURE_THRESHOLDS,
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

function metricLine(name: string, value: number | null): string[] {
  return value === null || !Number.isFinite(value) ? [] : [`${name} ${value}`];
}

function escapedLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export function hostSystemPrometheusMetrics(health: HostSystemHealth): string {
  const lines = [
    "# HELP stugu_host_info Static information about the Stugu host.",
    "# TYPE stugu_host_info gauge",
    `stugu_host_info{platform="${escapedLabel(health.platform)}",architecture="${escapedLabel(health.architecture)}",release="${escapedLabel(health.release)}"} 1`,
    "# HELP stugu_host_cpu_usage_percent Host CPU time spent outside the idle state.",
    "# TYPE stugu_host_cpu_usage_percent gauge",
    ...metricLine("stugu_host_cpu_usage_percent", health.cpu.usagePercent),
    "# HELP stugu_host_load_average Host load average over one, five, and fifteen minutes.",
    "# TYPE stugu_host_load_average gauge",
    `stugu_host_load_average{window="1m"} ${health.cpu.loadAverage[0]}`,
    `stugu_host_load_average{window="5m"} ${health.cpu.loadAverage[1]}`,
    `stugu_host_load_average{window="15m"} ${health.cpu.loadAverage[2]}`,
    "# HELP stugu_host_cpu_temperature_celsius Host CPU thermal-zone temperature when available.",
    "# TYPE stugu_host_cpu_temperature_celsius gauge",
    ...metricLine("stugu_host_cpu_temperature_celsius", health.cpu.temperatureCelsius),
    "# HELP stugu_host_memory_bytes Host or container memory by state.",
    "# TYPE stugu_host_memory_bytes gauge",
    `stugu_host_memory_bytes{state="total",scope="${health.memory.scope}"} ${health.memory.totalBytes}`,
    `stugu_host_memory_bytes{state="used",scope="${health.memory.scope}"} ${health.memory.usedBytes}`,
    `stugu_host_memory_bytes{state="available",scope="${health.memory.scope}"} ${health.memory.availableBytes}`,
    "# HELP stugu_process_resident_memory_bytes Resident memory used by the Stugu API process.",
    "# TYPE stugu_process_resident_memory_bytes gauge",
    `stugu_process_resident_memory_bytes ${health.memory.processResidentBytes}`,
    "# HELP stugu_host_storage_bytes Stugu data-volume storage by state.",
    "# TYPE stugu_host_storage_bytes gauge",
    ...metricLine('stugu_host_storage_bytes{state="total"}', health.storage.totalBytes),
    ...metricLine('stugu_host_storage_bytes{state="used"}', health.storage.usedBytes),
    ...metricLine('stugu_host_storage_bytes{state="available"}', health.storage.availableBytes),
    "# HELP stugu_host_uptime_seconds Host uptime.",
    "# TYPE stugu_host_uptime_seconds gauge",
    `stugu_host_uptime_seconds ${health.hostUptimeSeconds}`,
    "# HELP stugu_service_uptime_seconds Stugu API process uptime.",
    "# TYPE stugu_service_uptime_seconds gauge",
    `stugu_service_uptime_seconds ${health.serviceUptimeSeconds}`,
    "# HELP stugu_host_alert_active Whether a sustained built-in host alert is active.",
    "# TYPE stugu_host_alert_active gauge",
  ];
  for (const metric of ["cpu", "memory", "storage", "temperature"] as const) {
    for (const severity of ["warning", "critical"] as const) {
      const active = health.alerts.some((alert) => alert.metric === metric && alert.severity === severity);
      lines.push(`stugu_host_alert_active{metric="${metric}",severity="${severity}"} ${active ? 1 : 0}`);
    }
  }
  lines.push(
    "# HELP stugu_host_health_state Current combined host-health state.",
    "# TYPE stugu_host_health_state gauge",
  );
  for (const state of ["healthy", "warning", "critical", "unknown"] as const) {
    lines.push(`stugu_host_health_state{state="${state}"} ${health.state === state ? 1 : 0}`);
  }
  lines.push(
    "# HELP stugu_host_sample_timestamp_seconds Unix timestamp of the sample.",
    "# TYPE stugu_host_sample_timestamp_seconds gauge",
    `stugu_host_sample_timestamp_seconds ${Date.parse(health.sampledAt) / 1_000}`,
  );
  return `${lines.join("\n")}\n`;
}
