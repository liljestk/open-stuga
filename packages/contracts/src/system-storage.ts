/** Where the appliance keeps telemetry archives and backups, and the agent-run operation that moves them. */

export type SystemStorageLocationKind = "managed" | "local-path" | "nas-path";

export interface SystemStorageLocation {
  kind: SystemStorageLocationKind;
  path: string | null;
}

export interface SystemStorageSettings {
  timeseries: SystemStorageLocation;
  backups: SystemStorageLocation;
}

export type SystemStorageOperationPhase =
  | "queued"
  | "validating"
  | "backing-up"
  | "quiescing"
  | "copying"
  | "applying"
  | "verifying"
  | "complete"
  | "failed"
  | "rolling-back"
  | "manual-intervention";

export interface SystemStorageOperation {
  id: string;
  phase: SystemStorageOperationPhase;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  detail: string | null;
  previous: SystemStorageSettings;
  target: SystemStorageSettings;
}

export interface SystemStorageStatus {
  settings: SystemStorageSettings;
  revision: string;
  allowedRoots: string[];
  capability: {
    available: boolean;
    runtime: "docker" | "raspberry-pi" | null;
    agentLastSeenAt: string | null;
    reason:
      | "ready"
      | "agent-not-connected"
      | "agent-upgrade-required"
      | "configuration-unavailable"
      | "configuration-invalid"
      | "not-configured";
    detail: string | null;
  };
  operation: SystemStorageOperation | null;
}
