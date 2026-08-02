import type { AlertSeverity } from "./sensors-alerts.js";

export type HostSystemState = "healthy" | "warning" | "critical" | "unknown";

export type HostSystemAlertMetric =
  | "cpu"
  | "database"
  | "event-loop"
  | "memory"
  | "storage"
  | "storage-forecast"
  | "temperature";

export interface HostSystemThresholds {
  warningPercent: number;
  criticalPercent: number;
  warningAfterSeconds: number;
  criticalAfterSeconds: number;
}

export interface HostSystemLatencyThresholds {
  warningMilliseconds: number;
  criticalMilliseconds: number;
  warningAfterSeconds: number;
  criticalAfterSeconds: number;
}

export interface HostSystemAlert {
  id: string;
  metric: HostSystemAlertMetric;
  severity: Exclude<AlertSeverity, "info">;
  value: number | null;
  unit: "%" | "°C" | "bytes" | "ms" | null;
  threshold: number | null;
  startedAt: string;
  message: string;
  recommendation: string;
}

export interface HostSystemEventLoopStatus {
  state: HostSystemState;
  p95Milliseconds: number | null;
  maxMilliseconds: number | null;
  thresholds: HostSystemLatencyThresholds;
}

export interface HostSystemCpuStatus {
  state: HostSystemState;
  usagePercent: number | null;
  processUsagePercent: number | null;
  logicalCores: number;
  loadAverage: [number, number, number];
  temperatureCelsius: number | null;
  usageThresholds: HostSystemThresholds;
  temperatureThresholds: HostSystemThresholds;
  eventLoop: HostSystemEventLoopStatus;
}

export interface HostSystemMemoryStatus {
  state: HostSystemState;
  scope: "host" | "container";
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
  processResidentBytes: number;
  thresholds: HostSystemThresholds;
}

export interface HostSystemStorageStatus {
  state: HostSystemState;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
  thresholds: HostSystemThresholds;
  warningAvailableBytes: number;
  criticalAvailableBytes: number;
  forecast: HostSystemStorageForecast;
}

export type HostSystemStorageForecastState = "collecting" | "stable" | "projected";

export type HostSystemForecastConfidence = "low" | "medium" | "high";

export interface HostSystemStorageForecast {
  state: HostSystemStorageForecastState;
  sampleCount: number;
  observedSeconds: number;
  /** Positive values mean that available storage is being consumed. */
  growthBytesPerDay: number | null;
  warningAt: string | null;
  criticalAt: string | null;
  confidence: HostSystemForecastConfidence | null;
}

export interface HostSystemSqliteStatus {
  state: HostSystemState;
  sizeBytes: number | null;
  usedBytes: number | null;
  walBytes: number | null;
  pageCount: number | null;
  freePages: number | null;
  tableCount: number | null;
}

export interface HostSystemDatabasePoolStatus {
  total: number;
  idle: number;
  waiting: number;
}

export interface HostSystemDatabaseQueryStatus {
  active: number;
  started: number;
  succeeded: number;
  failed: number;
  averageDurationMilliseconds: number;
  maximumDurationMilliseconds: number;
  averagePoolWaitMilliseconds: number;
  maximumPoolWaitMilliseconds: number;
}

export interface HostSystemTelemetryDatabaseStatus {
  enabled: boolean;
  required: boolean;
  state: HostSystemState | "disabled";
  sizeBytes: number | null;
  latencyMilliseconds: number | null;
  pool: HostSystemDatabasePoolStatus | null;
  queries: HostSystemDatabaseQueryStatus | null;
}

export interface HostSystemDatabaseStatus {
  state: HostSystemState;
  sqlite: HostSystemSqliteStatus;
  telemetry: HostSystemTelemetryDatabaseStatus;
}

export interface HostSystemTelegramAlertDeliveryStatus {
  configured: boolean;
  connected: boolean | null;
  lastDeliveryAt: string | null;
  error: string | null;
}

export interface HostSystemAlertDeliveryStatus {
  telegram: HostSystemTelegramAlertDeliveryStatus;
}

export interface HostSystemHealth {
  state: HostSystemState;
  sampledAt: string;
  hostname: string;
  platform: string;
  architecture: string;
  release: string;
  hostUptimeSeconds: number;
  serviceUptimeSeconds: number;
  cpu: HostSystemCpuStatus;
  memory: HostSystemMemoryStatus;
  storage: HostSystemStorageStatus;
  database: HostSystemDatabaseStatus;
  /** Added by the authenticated API representation when delivery state is available. */
  alertDelivery?: HostSystemAlertDeliveryStatus;
  alerts: HostSystemAlert[];
}
