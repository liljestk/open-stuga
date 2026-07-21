export type AttentionCode =
  | "login_required"
  | "two_factor_required"
  | "ui_drift"
  | "device_not_found"
  | "configuration_error";

export interface ExportJob {
  id: string;
  sensorId: string;
  deviceId: string;
  deviceName: string;
  metric: string;
  from: string;
  to: string;
  timeZone: string;
  intervalMinutes: number;
  expectedRecipient: string;
  status: string;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: string;
  /** API-clock instant used for deterministic date-picker navigation. */
  serverNow: string;
  /** Relative lease lifetime measured against the API clock, never the runner wall clock. */
  leaseTtlMs: number;
}

export interface ClaimedJob {
  job: ExportJob;
}

export type WorkerJobStatus =
  | "running"
  | "waiting-email"
  | "needs-attention"
  | "failed";

export interface JobStatusUpdate {
  status: WorkerJobStatus;
  detail?: string;
}

export interface RunnerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
