import type { AnalyticsAggregation, AnalyticsResolution } from "./measurement-analytics.js";

export type ScheduledDataExportFrequency = "daily" | "weekly" | "monthly";
export type ScheduledDataExportPeriod = "24h" | "7d" | "30d" | "90d";
export type ScheduledDataExportRunStatus = "never" | "pending" | "complete" | "failed";

export interface ScheduledDataExport {
  id: string;
  houseId: string;
  name: string;
  enabled: boolean;
  frequency: ScheduledDataExportFrequency;
  timeLocal: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  period: ScheduledDataExportPeriod;
  sensorIds: string[];
  measurementIds: string[];
  resolution: Exclude<AnalyticsResolution, "auto">;
  aggregation: AnalyticsAggregation;
  retentionCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduledDataExportRunStatus;
  lastRunError: string | null;
  lastOutputName: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledDataExportInput {
  name: string;
  enabled: boolean;
  frequency: ScheduledDataExportFrequency;
  timeLocal: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  period: ScheduledDataExportPeriod;
  sensorIds: string[];
  measurementIds: string[];
  resolution: Exclude<AnalyticsResolution, "auto">;
  aggregation: AnalyticsAggregation;
  retentionCount: number;
}

export interface ScheduledDataExportUpdate extends ScheduledDataExportInput {
  baseRevision: number;
}
