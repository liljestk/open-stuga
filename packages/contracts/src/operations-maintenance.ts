import type { AlertSeverity } from "./sensors-alerts.js";

export const OBSERVATION_KINDS = ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const OBSERVATION_SEVERITIES = ["info", "warning", "critical"] as const satisfies readonly AlertSeverity[];

export const OBSERVATION_TIME_PRECISIONS = ["exact", "approximate", "date-only", "date-range", "unknown"] as const;
export type ObservationTimePrecision = (typeof OBSERVATION_TIME_PRECISIONS)[number];

export const OBSERVATION_SOURCES = [
  "owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown",
] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export const OBSERVATION_CONFIDENCES = ["confirmed", "probable", "uncertain", "awaiting-inspection"] as const;
export type ObservationConfidence = (typeof OBSERVATION_CONFIDENCES)[number];

export const OBSERVATION_STATUSES = ["open", "resolved"] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

/** Maximum canonical resolution outcome length accepted by API and MCP writes. */
export const MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH = 5_000 as const;

export type ObservationRevisionActor = "local-rest" | "local-mcp" | "local-migration" | "workspace-user" | "system-service";

export type ObservationChangedField =
  | "floorId"
  | "sensorId"
  | "kind"
  | "severity"
  | "note"
  | "x"
  | "y"
  | "occurredAt"
  | "timePrecision"
  | "validFrom"
  | "validTo"
  | "source"
  | "sourceDetail"
  | "confidence"
  | "status"
  | "resolutionNote"
  | "resolvedAt";

export interface ManualObservation {
  id: string;
  houseId: string;
  floorId: string;
  sensorId: string | null;
  kind: ObservationKind;
  severity: AlertSeverity;
  note: string;
  x: number | null;
  y: number | null;
  /** Observed time. Exact/approximate values are canonical UTC instants; date-only values stay YYYY-MM-DD. */
  occurredAt: string;
  /** Immutable server-recorded time. */
  createdAt: string;
  /** Additive v1 fields are optional so older stored/demo objects remain wire-compatible. Current servers always return them. */
  timePrecision?: ObservationTimePrecision;
  validFrom?: string | null;
  validTo?: string | null;
  source?: ObservationSource;
  sourceDetail?: string | null;
  confidence?: ObservationConfidence;
  /** Lifecycle state. Older observations without this additive field are open. */
  status?: ObservationStatus;
  /** Required, human-readable outcome while resolved, for example "Fixed leak". */
  resolutionNote?: string | null;
  /** Server-recorded resolution instant. Cleared when the observation is reopened. */
  resolvedAt?: string | null;
  revision?: number;
  updatedAt?: string;
}

export type ManualObservationInput = Pick<ManualObservation, "houseId" | "floorId" | "kind" | "severity" | "note"> & {
  id?: string;
  sensorId?: string | null;
  x?: number | null;
  y?: number | null;
  occurredAt?: string;
  timePrecision?: ObservationTimePrecision;
  validFrom?: string | null;
  validTo?: string | null;
  source?: ObservationSource;
  sourceDetail?: string | null;
  confidence?: ObservationConfidence;
};

export type ManualObservationPatch = {
  /** Optimistic concurrency guard. The patch is rejected when the stored revision has moved on. */
  baseRevision: number;
} & Partial<Pick<ManualObservation,
  | "floorId"
  | "sensorId"
  | "kind"
  | "severity"
  | "note"
  | "x"
  | "y"
  | "occurredAt"
  | "timePrecision"
  | "validFrom"
  | "validTo"
  | "source"
  | "sourceDetail"
  | "confidence"
  | "status"
  | "resolutionNote"
>>;

export interface ObservationRevision {
  observationId: string;
  revision: number;
  changedAt: string;
  actor: ObservationRevisionActor;
  actorId?: string | null;
  actorLabel?: string | null;
  changedFields: ObservationChangedField[];
  snapshot: ManualObservation;
}

/** Why a maintenance task exists. This classification must remain visible to users. */
export const MAINTENANCE_TASK_BASES = ["required", "scheduled", "condition-based", "predictive", "optional-improvement"] as const;
export type MaintenanceTaskBasis = (typeof MAINTENANCE_TASK_BASES)[number];

export const MAINTENANCE_TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type MaintenanceTaskPriority = (typeof MAINTENANCE_TASK_PRIORITIES)[number];

export const MAINTENANCE_TASK_STATUSES = ["planned", "in-progress", "completed", "verified", "cancelled"] as const;
export type MaintenanceTaskStatus = (typeof MAINTENANCE_TASK_STATUSES)[number];

export type MaintenanceTaskRevisionActor = ObservationRevisionActor;

export type MaintenanceTaskChangedField =
  | "propertyId"
  | "houseId"
  | "floorId"
  | "areaId"
  | "equipmentId"
  | "title"
  | "description"
  | "basis"
  | "basisDetail"
  | "priority"
  | "plannedFor"
  | "dueBy"
  | "observationIds"
  | "status"
  | "completionNote"
  | "completedAt"
  | "verificationNote"
  | "verifiedAt";

export interface MaintenanceTask {
  id: string;
  /** Stable owner used for outdoor/estate work even when no house exists. */
  propertyId: string;
  /** Optional building context for indoor work, scheduling defaults, and evidence links. */
  houseId: string | null;
  floorId: string | null;
  /** Optional mapped outdoor/estate context. Both resources must belong to the house's property. */
  areaId?: string | null;
  equipmentId?: string | null;
  title: string;
  description: string | null;
  basis: MaintenanceTaskBasis;
  basisDetail: string | null;
  priority: MaintenanceTaskPriority;
  /** Property-local calendar date in YYYY-MM-DD form. */
  plannedFor: string | null;
  /** Property-local calendar date in YYYY-MM-DD form. Predictive tasks cannot claim a formal due date. */
  dueBy: string | null;
  /** Canonically sorted, duplicate-free evidence links. */
  observationIds: string[];
  status: MaintenanceTaskStatus;
  completionNote: string | null;
  /** Server-recorded instant when work was marked completed. */
  completedAt: string | null;
  verificationNote: string | null;
  /** Server-recorded instant when completed work was verified. */
  verifiedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type MaintenanceTaskInputCommon = Pick<MaintenanceTask, "title" | "basis"> & {
  id?: string;
  floorId?: string | null;
  areaId?: string | null;
  equipmentId?: string | null;
  description?: string | null;
  basisDetail?: string | null;
  priority?: MaintenanceTaskPriority;
  plannedFor?: string | null;
  dueBy?: string | null;
  observationIds?: string[];
};

/** Existing house-first clients may omit propertyId; land-only work supplies propertyId and a nullable houseId. */
export type MaintenanceTaskInput = MaintenanceTaskInputCommon & (
  | { propertyId: string; houseId?: string | null }
  | { houseId: string; propertyId?: string }
);

export type MaintenanceTaskPatch = {
  /** Optimistic concurrency guard. */
  baseRevision: number;
} & Partial<Pick<MaintenanceTask,
  | "houseId"
  | "floorId"
  | "areaId"
  | "equipmentId"
  | "title"
  | "description"
  | "basis"
  | "basisDetail"
  | "priority"
  | "plannedFor"
  | "dueBy"
  | "observationIds"
  | "status"
  | "completionNote"
  | "verificationNote"
>>;

export interface MaintenanceTaskRevision {
  maintenanceTaskId: string;
  revision: number;
  changedAt: string;
  actor: MaintenanceTaskRevisionActor;
  actorId?: string | null;
  actorLabel?: string | null;
  changedFields: MaintenanceTaskChangedField[];
  snapshot: MaintenanceTask;
}

export interface StaticParameter {
  id: string;
  houseId: string;
  scopeType: "house" | "floor" | "room" | "sensor";
  scopeId: string;
  key: string;
  value: string | number | boolean;
  unit: string | null;
  label: string;
}

export type StaticParameterInput = Omit<StaticParameter, "id" | "unit"> & { id?: string; unit?: string | null };

export interface AssetRecord {
  id: string;
  houseId: string;
  name: string;
  mimeType: string;
  kind: "floor-plan" | "model-3d" | "other";
  size: number;
  createdAt: string;
}

export type DataExportPrivacyLevel = "structure" | "operations" | "full";

export interface DataExportPreview {
  schemaVersion: "stugu.export/v1";
  generatedAt: string;
  privacyLevel: DataExportPrivacyLevel;
  includesTelemetry: boolean;
  counts: Record<string, number>;
  sensitiveCategories: string[];
  estimatedTelemetryRows: number;
}

export interface BackupOperationStatus {
  available: boolean;
  schedulerHealthy: boolean;
  requestId: string | null;
  state: "idle" | "requested" | "running" | "complete" | "failed";
  requestedAt: string | null;
  completedAt: string | null;
  backupPath: string | null;
  lastError: string | null;
  latestVerifiedBackupAt: string | null;
  latestRestoreDrillAt: string | null;
}

export type SetupDoctorCheckStatus = "pass" | "warning" | "fail" | "not-applicable";

export interface SetupDoctorCheck {
  id: string;
  category: "storage" | "telemetry" | "integration" | "sensors" | "notifications" | "recovery" | "security";
  status: SetupDoctorCheckStatus;
  title: string;
  detail: string;
  action: string | null;
}

export interface SetupDoctorReport {
  generatedAt: string;
  overall: "ready" | "attention" | "blocked";
  checks: SetupDoctorCheck[];
}

export interface SensorLabelDescriptor {
  sensorId: string;
  sensorName: string;
  houseName: string;
  roomName: string | null;
  setupUri: string;
}

export interface AssetUploadInput {
  houseId: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "model/gltf+json" | "model/gltf-binary";
  kind: AssetRecord["kind"];
  /** Base64 bytes, optionally prefixed by a data URL. */
  data: string;
}
