import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  AreaEquipment,
  Floor,
  House,
  MaintenanceTask,
  MeasurementSample,
  Property,
  PropertyArea,
  PropertyAreaKind,
  PropertyNote,
  Sensor,
  StugubyHouseLink,
  StugubyPropertyLink,
} from "@climate-twin/contracts";
import {
  STUGBY_MAX_BATCH_EVENTS,
  STUGBY_MAX_BLOB_BYTES,
  STUGBY_MAX_CLOCK_SKEW_SECONDS,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  canonicalJson,
  eventSigningValue,
  isStugubyDataset,
  isStugubyRole,
  requestSigningValue,
  validateDatasetPayload,
  validateHomeCommand,
  validateHomeCommandResult,
  validatePropertyCommand,
  validatePropertyCommandResult,
  validateShareGrant,
  validateSharedProperty,
  validateSignedEvent,
  type JsonObject,
  type JsonValue,
  type StugubyDataset,
  type StugubyDatasetGrant,
  type StugubyDeletionReceipt,
  type StugubyBlobMediaType,
  type StugubyBlobReference,
  type StugubyEventBatch,
  type StugubyEventPage,
  type StugubyGrantAudience,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyHomeCommandSnapshot,
  type StugubyHomeDirectoryPayload,
  type StugubyHomeFloorPlanPayload,
  type StugubyHomeLocationPayload,
  type StugubyHomeNotesPayload,
  type StugubyHomeObservationsPayload,
  type StugubyHomeRecoveryKind,
  type StugubyHomeRecoveryPayload,
  type StugubyHomeStructurePayload,
  type StugubyInvitation,
  type StugubyJoinRequest,
  type StugubyJoinResponse,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubyRole,
  type StugubySensorCatalogPayload,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
  type StugubyTelemetryPayload,
  type StugubyWireEvent,
} from "@climate-twin/stuguby-protocol";
import type { ClimateDatabase } from "../../../db.js";
import type { TelemetryBus } from "../../../events.js";
import type { StugubyNodeKeys } from "../../identity.js";
import { publicKeyFingerprint } from "../../identity.js";
import { durableAtomicWriteFileSync } from "../../durable-write.js";
import {
  StugubyStore,
  type StugubyAuthorityTransfer,
  type StugubyHomeProjection,
  type StugubyLocalInvitation,
  type StugubyLocalMember,
  type StugubyOutboxItem,
  type StugubyPropertyAdoption,
} from "../../store.js";
import { DATASET_SCHEMAS, ISO_DATE_TIME, MachineRequestProof, Notification, StugubyError, UUID, asJson, enabledDataset, eventBlobReferences, grantAudienceIncludes, grantExpired, sha256, validateGrantTransition } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    distribute(event: StugubySignedEvent, explicitGrant?: StugubyShareGrant): void;
    appendForMember(stugubyId: string, nodeId: string, event: StugubySignedEvent): void;
    publishMember(member: StugubyMember): void;
    sendMemberSnapshot(member: StugubyMember, targetNodeId: string): void;
    sendSharedPropertySnapshot(property: StugubySharedProperty, targetNodeId: string): void;
    subscribeNotifications(stugubyId: string, nodeId: string, listener: (cursor: number) => void): () => void;
    replaceNotificationStream(stugubyId: string, nodeId: string, close: () => void): () => void;
    authenticateMachineRequest(stugubyId: string, proof: MachineRequestProof): StugubyMember;
    ingestEventBatch(actor: StugubyMember, stugubyId: string, batch: StugubyEventBatch): {
            accepted: string[];
            duplicates: string[];
        };
    eventPage(actor: StugubyMember, stugubyId: string, cursor: number, limit: number): StugubyEventPage;
    authorizeDatasetEvent(event: StugubySignedEvent): StugubyShareGrant;
    verifyEvent(event: StugubySignedEvent, publicKey: string): void;
    syncNow(stugubyId: string): Promise<StugubySummary>;
    syncAll(): Promise<void>;
    syncFederation(stugubyId: string, throwOnError: boolean, bypassCooldown?: boolean): Promise<void>;
    ensureNotificationStreams(): void;
  }

  interface StugubyServiceCore {
    subscribeNotifications(stugubyId: string, nodeId: string, listener: (cursor: number) => void): () => void;
    replaceNotificationStream(stugubyId: string, nodeId: string, close: () => void): () => void;
    authenticateMachineRequest(stugubyId: string, proof: MachineRequestProof): StugubyMember;
    ingestEventBatch(actor: StugubyMember, stugubyId: string, batch: StugubyEventBatch): {
            accepted: string[];
            duplicates: string[];
        };
    eventPage(actor: StugubyMember, stugubyId: string, cursor: number, limit: number): StugubyEventPage;
    syncNow(stugubyId: string): Promise<StugubySummary>;
    syncAll(): Promise<void>;
  }
}
