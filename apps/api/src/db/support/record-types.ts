import type { AlertDeliveryPolicy, AlertEvent, AlertRule, DailyAnalyticsFindingsSnapshot, NotificationChannel, NotificationDeliveryStage, NotificationSubjectKind, OpeningStateObservation, SecurityAuditEvent, SecurityAuditEventType, SecurityAuditOutcome, SecurityAuditSubjectType, MaintenanceTaskRevisionActor, ManualObservation, ObservationRevisionActor, WeatherBackfillState, WeatherOutageComponent, WeatherProviderName, Sensor, SensorDataGapCompleteness, SensorDataGapSource, SensorDataGapState } from "@climate-twin/contracts";

export interface DemoTelemetryPurgeResult {
  activated: boolean;
  activatedAt: string;
  readings: number;
  measurementSamples: number;
  outdoorTemperatureSamples: number;
  alertEvents: number;
}

export interface StoredDailyAnalyticsFindings {
  snapshot: DailyAnalyticsFindingsSnapshot | null;
  lastAttemptAt: string;
  lastError: string | null;
}

export interface PropertyMigrationResult {
  sourcePropertyId: string;
  targetPropertyId: string;
  houseIds: string[];
  areaIds: string[];
  equipmentIds: string[];
  noteIds: string[];
  maintenanceTaskIds: string[];
}

export interface OpeningStateActivityRecord {
  floorId: string;
  elementId: string;
  source: OpeningStateObservation["source"];
  externalId: string | null;
  connectionId: string | null;
  observationCount: number;
  openedCount: number;
  closedCount: number;
}

export interface SecurityAuditEventInput {
  eventType: SecurityAuditEventType;
  outcome?: SecurityAuditOutcome;
  actorUserId: string | null;
  actorRole: SecurityAuditEvent["actorRole"];
  subjectType: SecurityAuditSubjectType;
  subjectId: string;
  details?: SecurityAuditEvent["details"];
  createdAt?: string;
}

export interface NotificationOutboxItem {
  id: string;
  subjectKind: NotificationSubjectKind;
  subjectId: string;
  eventId: string | null;
  stage: NotificationDeliveryStage;
  sequence: number;
  channel: NotificationChannel;
  destinationId: string;
  payloadJson: string;
  destinationRef: string;
  policy: AlertDeliveryPolicy;
  maxAttempts: number;
  attempts: number;
  lockToken: string;
}

export interface AlertTransition {
  ignoredAsStale: boolean;
  created: AlertEvent | null;
  resolved: AlertEvent | null;
}

export interface DueAlertCondition {
  rule: AlertRule;
  sensorId: string;
  conditionSince: string;
  latestTimestamp: string;
}

export interface TelemetryArchiveRow<T> {
  rowId: number;
  record: T;
}

export interface TelemetryArchiveDirtyRow<T> {
  dirtyId: number;
  version: number;
  record: T;
}

export interface ElectricityPriceArchiveRecord {
  propertyId: string;
  startAt: string;
  endAt: string;
  rawPriceCentsPerKwh: number;
  marginCentsPerKwh: number;
  source: string;
  fetchedAt: string;
}

export interface OpeningStateArchiveRecord {
  observationId: string;
  houseId: string;
  floorId: string;
  elementId: string;
  state: OpeningStateObservation["state"];
  openFraction: number | null;
  source: OpeningStateObservation["source"];
  observedAt: string;
  validUntil: string | null;
  externalId: string | null;
  connectionId: string | null;
  recordedAt: string;
}

export type IntegrationMappingKind = "home-assistant" | "tp-link";

/**
 * A validated, non-secret compatibility mapping imported from a JSON file.
 * The source path is deliberately not retained: the SQLite copy is the
 * durable control-plane record once the file has been accepted.
 */
export interface IntegrationMappingSet<T = unknown> {
  kind: IntegrationMappingKind;
  contentHash: string;
  revision: number;
  mappings: T[];
  createdAt: string;
  updatedAt: string;
}

export type TelemetryCascadeScope = "sensor" | "house" | "house-location" | "property";

export type TelemetryArchiveTable =
  | "measurement_samples"
  | "legacy_readings"
  | "outdoor_temperature_samples"
  | "electricity_price_samples"
  | "opening_state_samples"
  | "heat_pump_state_samples";

export type TelemetryArchiveMutableTable = Exclude<
  TelemetryArchiveTable,
  "measurement_samples" | "opening_state_samples" | "heat_pump_state_samples"
>;

export type TelemetryArchiveWatermarks = Readonly<Record<
  TelemetryArchiveTable,
  number
>>;

export type StoredObservation = ManualObservation & Required<Pick<ManualObservation,
  | "timePrecision"
  | "validFrom"
  | "validTo"
  | "source"
  | "sourceDetail"
  | "confidence"
  | "status"
  | "resolutionNote"
  | "resolvedAt"
  | "revision"
  | "updatedAt"
>>;

export type LocalObservationRevisionActor = Extract<ObservationRevisionActor, "local-rest" | "local-mcp" | "system-service">;

export type LocalMaintenanceTaskRevisionActor = Extract<
  MaintenanceTaskRevisionActor,
  "local-rest" | "local-mcp" | "system-service"
>;

export interface WeatherOutageRecord {
  id: number;
  houseId: string;
  locationKey: string;
  provider: WeatherProviderName;
  component: WeatherOutageComponent;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  lastError: string;
  backfillState: WeatherBackfillState;
  backfillFrom: string | null;
  backfillTo: string | null;
  recoveredPoints: number;
  lastAttemptAt: string | null;
  backfillError: string | null;
}

export interface SensorDataGapRecord {
  id: number;
  sensorId: string;
  metric: string;
  source: SensorDataGapSource;
  startedAt: string;
  detectedAt: string;
  endedAt: string | null;
  recoveryState: SensorDataGapState;
  recoverableUntil: string | null;
  recoveryCompleteness: SensorDataGapCompleteness;
  recoveredPoints: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  recoveryError: string | null;
}

export type SensorUpdate = Partial<Omit<Sensor, "id" | "tpLinkDeviceId" | "tpLinkConnectionId">> & {
  /** Set null to remove a persisted direct TP-Link child-device binding. */
  tpLinkDeviceId?: string | null;
  /** Set null to remove the house-scoped TP-Link connection binding. */
  tpLinkConnectionId?: string | null;
};
