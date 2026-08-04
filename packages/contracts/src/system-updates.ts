export type SystemUpdateDay = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export type SystemUpdateMode = "manual" | "automatic";
export type SystemUpdatePhase =
  | "queued"
  | "preparing"
  | "backup"
  | "pulling"
  | "applying"
  | "verifying"
  | "complete"
  | "failed"
  | "rolling-back";

export interface SystemUpdateSettings {
  mode: SystemUpdateMode;
  includePrereleases: boolean;
  checkIntervalHours: 6 | 12 | 24 | 168;
  updateTime: string;
  updateDays: SystemUpdateDay[];
  timezone: string;
}

export interface SystemRelease {
  version: string;
  tagName: string;
  name: string;
  notes: string;
  publishedAt: string;
  url: string;
  prerelease: boolean;
}

export interface SystemUpdateActivity {
  phase: SystemUpdatePhase;
  at: string;
  detail: string;
}

export interface SystemUpdateOperation {
  id: string;
  version: string;
  tagName: string;
  phase: SystemUpdatePhase;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  phaseStartedAt: string;
  detail: string | null;
  previousVersion: string;
  activity: SystemUpdateActivity[];
}

export interface SystemUpdateCapability {
  available: boolean;
  runtime: "docker" | "raspberry-pi" | null;
  agentLastSeenAt: string | null;
  reason: string;
  detail?: string | null;
}

export interface SystemUpdateApplicationProjection {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  capability: SystemUpdateCapability;
  operation: SystemUpdateOperation | null;
}

export type HostUpdatePhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installing"
  | "ready-to-restart"
  | "restarting"
  | "verifying"
  | "complete"
  | "cancelled"
  | "failed"
  | "returned"
  | "recovery-needed";

export interface HostUpdateReadyToRestart {
  operationId: string;
  targetVersion: string;
  targetGeneration: number;
  targetDigest: string;
  targetSlot?: string;
}

export interface SystemUpdateHostProjection {
  supported: boolean;
  phase: HostUpdatePhase;
  reason: string | null;
  detail: string | null;
  currentVersion: string | null;
  currentGeneration: number | null;
  activeSlot: string | null;
  updateAvailable: boolean;
  targetVersion: string | null;
  targetGeneration: number | null;
  targetDigest: string | null;
  updatedAt: string | null;
  readyToRestart: HostUpdateReadyToRestart | null;
}

export type SystemUpdateWorkflowPhase =
  | "preparing"
  | "backup-active"
  | "backup-complete"
  | "host-stage-requested"
  | "host-stage-queueing"
  | "host-staging"
  | "awaiting-restart"
  | "restarting"
  | "host-verifying"
  | "host-complete"
  | "application-queueing"
  | "application-queued"
  | "application-updating"
  | "application-failed"
  | "complete"
  | "failed"
  | "cancelled"
  | "returned"
  | "recovery-needed";

export type SystemUpdateWorkflowStepId =
  | "backup"
  | "stage-host"
  | "restart-host"
  | "verify-host"
  | "update-application"
  | "verify-application";

export type SystemUpdateWorkflowStepState =
  | "pending"
  | "active"
  | "waiting"
  | "complete"
  | "skipped"
  | "failed"
  | "rolled-back";

export interface SystemUpdateWorkflowStep {
  id: SystemUpdateWorkflowStepId;
  state: SystemUpdateWorkflowStepState;
  detail?: string;
}

export interface SystemUpdateWorkflowProjection {
  id: string;
  revision: number;
  action: "update-everything";
  phase: SystemUpdateWorkflowPhase;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
  detail: string;
  hostOperationId: string | null;
  targets: {
    applicationVersion: string | null;
    hostVersion: string | null;
    hostGeneration: number | null;
    hostDigest: string | null;
  };
  steps: SystemUpdateWorkflowStep[];
  canCancel: boolean;
  recoveryRequired: boolean;
  reason: string | null;
}

export interface SystemUpdateStatus {
  schema: "stugu-system-updates/v2";
  revision: number;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  latestRelease: SystemRelease | null;
  releases: SystemRelease[];
  lastCheckedAt: string | null;
  checkError: string | null;
  settings: SystemUpdateSettings;
  nextUpdateWindowAt: string | null;
  capability: SystemUpdateCapability;
  operation: SystemUpdateOperation | null;
  application: SystemUpdateApplicationProjection;
  host: SystemUpdateHostProjection;
  workflow: SystemUpdateWorkflowProjection | null;
}

export interface UpdateEverythingRequest {
  action: "update-everything";
  expectedRevision: number;
}

export interface ActivateHostUpdateRequest {
  action: "activate-host";
  expectedRevision: number;
  workflowId: string;
  hostOperationId: string;
  targetVersion: string;
  targetGeneration: number;
  targetDigest: string;
  confirmation: "RESTART_AND_INSTALL";
}

export interface CancelHostUpdateRequest {
  action: "cancel-host";
  expectedRevision: number;
  workflowId: string;
  hostOperationId: string;
  targetVersion: string;
  targetGeneration: number;
  targetDigest: string;
}

export interface RetryApplicationUpdateRequest {
  action: "retry-application";
  expectedRevision: number;
  workflowId: string;
}

export type SystemUpdateOperationRequest =
  | UpdateEverythingRequest
  | ActivateHostUpdateRequest
  | CancelHostUpdateRequest
  | RetryApplicationUpdateRequest;
