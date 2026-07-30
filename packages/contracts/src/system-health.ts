import type { AlertSeverity } from "./sensors-alerts.js";

export type HostSystemState = "healthy" | "warning" | "critical" | "unknown";

export type HostSystemAlertMetric = "cpu" | "memory" | "storage" | "temperature";

export interface HostSystemThresholds {
  warningPercent: number;
  criticalPercent: number;
  warningAfterSeconds: number;
  criticalAfterSeconds: number;
}

export interface HostSystemAlert {
  id: string;
  metric: HostSystemAlertMetric;
  severity: Exclude<AlertSeverity, "info">;
  value: number | null;
  unit: "%" | "°C" | "bytes" | null;
  threshold: number | null;
  startedAt: string;
  message: string;
  recommendation: string;
}

export interface HostSystemCpuStatus {
  state: HostSystemState;
  usagePercent: number | null;
  logicalCores: number;
  loadAverage: [number, number, number];
  temperatureCelsius: number | null;
  usageThresholds: HostSystemThresholds;
  temperatureThresholds: HostSystemThresholds;
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
  alerts: HostSystemAlert[];
}
