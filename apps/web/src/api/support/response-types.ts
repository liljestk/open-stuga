import type { House, HouseLocation, HouseMapPlacement, MeasurementSample, OutdoorTemperatureSample, Sensor, StugubyAuthorityTransfer, StugubyHomeProjection, StugubyPropertyAdoption, SystemUpdateOperationRequest, SystemUpdateStatus } from "@climate-twin/contracts";
import type { StugubyInvitation, StugubyMember, StugubyNodeIdentity, StugubySummary, StugubyDeletionReceipt, StugubyPropertyConflict, StugubyRemoteResource, StugubyShareGrant, StugubySharedProperty } from "@climate-twin/stuguby-protocol";

/** Independent, nullable updates for a house's real-world placement. */
export interface HouseGeoreferencePatch {
  location?: HouseLocation | null;
  mapPlacement?: HouseMapPlacement | null;
  orientationDegrees?: number | null;
}

export type CreateHouseInput = Pick<House, "name" | "timezone" | "floors">
  & Partial<Pick<House, "propertyId" | "location" | "mapPlacement" | "orientationDegrees">>;

export type CreateSensorInput = Omit<Sensor, "id">;

export interface MaintenanceTaskFilters {
  propertyId?: string;
  houseId?: string;
  areaId?: string;
  equipmentId?: string;
}

export interface HistoricalImportResult {
  submitted: number;
  accepted: number;
  ignoredDuplicates: number;
}

export interface SensorMeasurementPage {
  samples: MeasurementSample[];
  nextCursor: string | null;
}

export interface MeasurementHistoryPage {
  samples: MeasurementSample[];
  from: string;
  to: string;
  bucketSeconds: number | null;
  truncated: boolean;
  nextCursor?: string | null;
}

export interface OutdoorTemperatureHistoryPage {
  samples: OutdoorTemperatureSample[];
  from: string;
  to: string;
  truncated: boolean;
}

export type TpLinkHistoryExportProvider = "appium" | "private-cloud";

export type TpLinkHistoryExportJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting-email"
  | "needs-attention"
  | "completed"
  | "failed"
  | "cancelled";

export interface TpLinkHistoryExportJob {
  id: string;
  canary: boolean;
  provider: TpLinkHistoryExportProvider;
  sensorId: string;
  deviceId: string;
  deviceName: string;
  timeZone: string;
  metric: string;
  expectedRecipient: string | null;
  from: string;
  to: string;
  intervalMinutes: number;
  status: TpLinkHistoryExportJobStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  submittedAt: string | null;
  mailboxMessageId: string | null;
  sourceArtifactSha256: string | null;
  sourceArtifactBytes: number | null;
  parserVersion: string | null;
  sourceSchemaSignature: string | null;
  stagedSampleCount: number;
  consumedSampleCount: number;
  lastError: string | null;
  attentionReason: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TpLinkHistoryExportJobsResponse {
  enabled: boolean;
  automation: {
    operational: boolean;
    canaryPending: boolean;
    waitingEmails: number;
    maxPendingEmails: number;
    exportIntervalMinutes: 1 | 15 | 30 | 60 | 360 | 720 | 1440;
    canaryApprovalMaxAgeDays: number;
    mailbox: {
      lastSuccessfulPollAt: string | null;
      lastErrorAt: string | null;
      lastErrorCode: string | null;
      consecutiveFailures: number;
      budgetExhaustions: number;
    };
    lastWorkerSeenAt: string | null;
    deploymentFingerprintPrefix: string | null;
  };
  jobs: TpLinkHistoryExportJob[];
}

export interface LocationSuggestion {
  id: string;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  source: "open-meteo-geocoding";
  confidence: "high" | "medium";
}

export interface AppleNotesSetupMetadata {
  available?: boolean;
  snapshotPath?: string;
  capturePath?: string;
  limitations?: string[];
  steps?: string[];
}

export interface StugubyListResponse {
  identity: StugubyNodeIdentity;
  publicOrigin: string | null;
  suggestedPublicOrigin?: string | null;
  publicOriginConfigurable?: boolean;
  stugubys: StugubySummary[];
}

export interface StugubyLocalMember extends StugubyMember {
  localLabel: string | null;
}

export interface StugubyLocalInvitation extends StugubyInvitation {
  localLabel: string | null;
}

export interface StugubyInvitationCreated extends StugubyLocalInvitation {
  joinSecret: string;
  joinUrl: string;
}

export interface StugubyLocalPublicationCatalog {
  house: { localHouseId: string; publicationId: string; name: string };
  sensors: Array<{ localSensorId: string; sensorPublicationId: string; name: string; metricIds: string[] }>;
}

export interface StugubyDetailResponse {
  stuguby: StugubySummary;
  members: StugubyLocalMember[];
  invitations: StugubyLocalInvitation[];
  grants: StugubyShareGrant[];
  sharedProperty: StugubySharedProperty | null;
  propertyAdoption: StugubyPropertyAdoption | null;
  propertyConflicts: StugubyPropertyConflict[];
  propertyCommandCounts: { pending: number; conflicts: number };
  homeCommandCounts: { pending: number; conflicts: number };
  homeProjections: StugubyHomeProjection[];
  authorityTransfers: StugubyAuthorityTransfer[];
  remoteResources: StugubyRemoteResource[];
  deletionReceipts: StugubyDeletionReceipt[];
  audit: Array<{
    id: number;
    eventType: string;
    actorNodeId: string | null;
    subjectId: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface StugubyRemoteTelemetrySample {
  authorityNodeId: string;
  publicationId: string;
  sensorPublicationId: string;
  metricId: string;
  timestamp: string;
  value: number;
  quality: string;
  correctionOf: string | null;
}

export type SystemUpdateBlockReason =
  | "agent-offline"
  | "agent-not-connected"
  | "agent-upgrade-required"
  | "host-updater-offline"
  | "host-updater-upgrade-required"
  | "platform-managed-externally"
  | "factory-transition-required"
  | "appliance-upgrade-required"
  | "cli-transition-required"
  | "hardware-unqualified"
  | "mutation-busy"
  | "recovery-required"
  | "backup-unavailable"
  | "off-device-backup-required"
  | "metadata-unavailable"
  | "feed-trust-stale"
  | "trust-verification-failed"
  | "verification-failed"
  | "status-stale"
  | "not-configured";

export type SystemUpdateLiveStatus = Pick<
  SystemUpdateStatus,
  "currentVersion" | "latestVersion" | "updateAvailable" | "capability" | "operation"
> & Partial<Pick<SystemUpdateStatus, "schema" | "revision" | "application" | "host" | "workflow">>;

export type SystemUpdateOperationInput = SystemUpdateOperationRequest;
