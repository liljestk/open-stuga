import type {
  HostSystemAlert,
  HostSystemAlertMetric,
  HostSystemDatabaseStatus,
  HostSystemStorageForecast,
  HostSystemThresholds,
} from "@climate-twin/contracts";

const GIBIBYTE = 1_073_741_824;

export const CPU_THRESHOLDS: HostSystemThresholds = {
  warningPercent: 85,
  criticalPercent: 95,
  warningAfterSeconds: 300,
  criticalAfterSeconds: 120,
};
export const MEMORY_THRESHOLDS: HostSystemThresholds = {
  warningPercent: 85,
  criticalPercent: 95,
  warningAfterSeconds: 300,
  criticalAfterSeconds: 120,
};
export const STORAGE_THRESHOLDS: HostSystemThresholds = {
  warningPercent: 85,
  criticalPercent: 95,
  warningAfterSeconds: 0,
  criticalAfterSeconds: 0,
};
export const TEMPERATURE_THRESHOLDS: HostSystemThresholds = {
  warningPercent: 75,
  criticalPercent: 85,
  warningAfterSeconds: 120,
  criticalAfterSeconds: 30,
};
export const EVENT_LOOP_THRESHOLDS = {
  warningMilliseconds: 250,
  criticalMilliseconds: 1_000,
  warningAfterSeconds: 120,
  criticalAfterSeconds: 30,
} as const;
export const STORAGE_WARNING_AVAILABLE_BYTES = 5 * GIBIBYTE;
export const STORAGE_CRITICAL_AVAILABLE_BYTES = GIBIBYTE;

export interface HostAlertCondition {
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

interface HostAlertConditionInput {
  nowMs: number;
  cpuStrainPercent: number | null;
  eventLoopP95Milliseconds: number | null;
  memoryUsedPercent: number;
  storageUsedPercent: number | null;
  storageAvailableBytes: number | null;
  storageForecast: HostSystemStorageForecast;
  temperatureCelsius: number | null;
  database: HostSystemDatabaseStatus;
}

function rounded(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

function daysUntil(timestamp: string | null, nowMs: number): number | null {
  if (!timestamp) return null;
  const value = (Date.parse(timestamp) - nowMs) / 86_400_000;
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

export function buildHostAlertConditions(input: HostAlertConditionInput): HostAlertCondition[] {
  const forecastWarningDays = daysUntil(input.storageForecast.warningAt, input.nowMs);
  const forecastCriticalDays = daysUntil(input.storageForecast.criticalAt, input.nowMs);
  const trustedForecast = input.storageForecast.confidence === "medium"
    || input.storageForecast.confidence === "high";
  const storageRecommendation = "Free space on the Stugu data volume or expand it before history, backups, or updates are interrupted.";
  const databaseRecommendation = "Check the database service, its storage, and the Stugu telemetry archive connection.";
  return [
    {
      metric: "cpu", severity: "warning",
      active: input.cpuStrainPercent !== null && input.cpuStrainPercent >= CPU_THRESHOLDS.warningPercent,
      value: input.cpuStrainPercent, unit: "%", threshold: CPU_THRESHOLDS.warningPercent,
      afterSeconds: CPU_THRESHOLDS.warningAfterSeconds,
      message: `CPU use has stayed above ${CPU_THRESHOLDS.warningPercent}%.`,
      recommendation: "Check active imports, analytics, integrations, and any other workload running on the Stugu host.",
    },
    {
      metric: "cpu", severity: "critical",
      active: input.cpuStrainPercent !== null && input.cpuStrainPercent >= CPU_THRESHOLDS.criticalPercent,
      value: input.cpuStrainPercent, unit: "%", threshold: CPU_THRESHOLDS.criticalPercent,
      afterSeconds: CPU_THRESHOLDS.criticalAfterSeconds,
      message: `CPU use has stayed above ${CPU_THRESHOLDS.criticalPercent}%.`,
      recommendation: "Check active imports, analytics, integrations, and any other workload running on the Stugu host.",
    },
    {
      metric: "event-loop", severity: "warning",
      active: input.eventLoopP95Milliseconds !== null
        && input.eventLoopP95Milliseconds >= EVENT_LOOP_THRESHOLDS.warningMilliseconds,
      value: input.eventLoopP95Milliseconds, unit: "ms", threshold: EVENT_LOOP_THRESHOLDS.warningMilliseconds,
      afterSeconds: EVENT_LOOP_THRESHOLDS.warningAfterSeconds,
      message: `API response scheduling has stayed above ${EVENT_LOOP_THRESHOLDS.warningMilliseconds} ms (p95).`,
      recommendation: "Check integrations, history recovery, analytics, and other API work that may be blocking Stugu responses.",
    },
    {
      metric: "event-loop", severity: "critical",
      active: input.eventLoopP95Milliseconds !== null
        && input.eventLoopP95Milliseconds >= EVENT_LOOP_THRESHOLDS.criticalMilliseconds,
      value: input.eventLoopP95Milliseconds, unit: "ms", threshold: EVENT_LOOP_THRESHOLDS.criticalMilliseconds,
      afterSeconds: EVENT_LOOP_THRESHOLDS.criticalAfterSeconds,
      message: `API response scheduling has stayed above ${EVENT_LOOP_THRESHOLDS.criticalMilliseconds} ms (p95).`,
      recommendation: "Check integrations, history recovery, analytics, and other API work that may be blocking Stugu responses.",
    },
    ...(["warning", "critical"] as const).map((severity): HostAlertCondition => ({
      metric: "memory",
      severity,
      active: input.memoryUsedPercent >= MEMORY_THRESHOLDS[`${severity}Percent`],
      value: input.memoryUsedPercent,
      unit: "%",
      threshold: MEMORY_THRESHOLDS[`${severity}Percent`],
      afterSeconds: MEMORY_THRESHOLDS[`${severity}AfterSeconds`],
      message: `Memory use has stayed above ${MEMORY_THRESHOLDS[`${severity}Percent`]}%.`,
      recommendation: "Pause unusually heavy imports or analytics and check whether a Stugu service is growing unexpectedly.",
    })),
    ...(["warning", "critical"] as const).map((severity): HostAlertCondition => ({
      metric: "storage",
      severity,
      active: (input.storageUsedPercent !== null
        && input.storageUsedPercent >= STORAGE_THRESHOLDS[`${severity}Percent`])
        || (input.storageAvailableBytes !== null
          && input.storageAvailableBytes <= (severity === "critical"
          ? STORAGE_CRITICAL_AVAILABLE_BYTES
          : STORAGE_WARNING_AVAILABLE_BYTES)),
      value: input.storageUsedPercent,
      unit: "%",
      threshold: STORAGE_THRESHOLDS[`${severity}Percent`],
      afterSeconds: 0,
      message: input.storageAvailableBytes === null
        ? input.storageUsedPercent === null
          ? "Storage space could not be measured."
          : `The Stugu data volume is ${rounded(input.storageUsedPercent)}% used.`
        : `The Stugu data volume has ${severity === "critical" ? "only " : ""}${rounded(input.storageAvailableBytes / GIBIBYTE)} GiB available.`,
      recommendation: storageRecommendation,
    })),
    {
      metric: "storage-forecast", severity: "warning",
      active: trustedForecast && forecastWarningDays !== null && forecastWarningDays <= 30,
      value: forecastWarningDays === null ? null : rounded(forecastWarningDays),
      unit: null, threshold: 30, afterSeconds: 0,
      message: forecastWarningDays === null
        ? "Storage growth could not be projected."
        : `At the observed growth rate, storage reaches its warning threshold in about ${rounded(forecastWarningDays)} days.`,
      recommendation: storageRecommendation,
    },
    {
      metric: "storage-forecast", severity: "critical",
      active: trustedForecast && forecastCriticalDays !== null && forecastCriticalDays <= 7,
      value: forecastCriticalDays === null ? null : rounded(forecastCriticalDays),
      unit: null, threshold: 7, afterSeconds: 0,
      message: forecastCriticalDays === null
        ? "Storage growth could not be projected."
        : `At the observed growth rate, storage reaches its critical threshold in about ${rounded(forecastCriticalDays)} days.`,
      recommendation: storageRecommendation,
    },
    {
      metric: "database", severity: "warning", active: input.database.state === "warning",
      value: input.database.telemetry.latencyMilliseconds, unit: "ms", threshold: null, afterSeconds: 120,
      message: "The optional telemetry database has remained unavailable.", recommendation: databaseRecommendation,
    },
    {
      metric: "database", severity: "critical", active: input.database.state === "critical",
      value: input.database.telemetry.latencyMilliseconds, unit: "ms", threshold: null, afterSeconds: 30,
      message: "A required Stugu database has remained unavailable.", recommendation: databaseRecommendation,
    },
    ...(["warning", "critical"] as const).map((severity): HostAlertCondition => ({
      metric: "temperature",
      severity,
      active: input.temperatureCelsius !== null
        && input.temperatureCelsius >= TEMPERATURE_THRESHOLDS[`${severity}Percent`],
      value: input.temperatureCelsius,
      unit: "°C",
      threshold: TEMPERATURE_THRESHOLDS[`${severity}Percent`],
      afterSeconds: TEMPERATURE_THRESHOLDS[`${severity}AfterSeconds`],
      message: `The host temperature has stayed above ${TEMPERATURE_THRESHOLDS[`${severity}Percent`]} °C.`,
      recommendation: "Check airflow around the host, its fan or heatsink, and the room temperature.",
    })),
  ];
}
