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
import { STUGBY_MAX_STAGED_BLOB_BYTES, StugubyError, isLoopbackHostname, parseIso, recordValue, requiredText, sha256 } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { StugubyServiceCore as StugubyService } from "../core.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    recordDeletionReceipt(actor: StugubyMember, receipt: StugubyDeletionReceipt): void;
    downloadReferencedBlobs(
        stuguby: StugubySummary,
        event: StugubySignedEvent,
        references: StugubyBlobReference[],
      ): Promise<void>;
    signedFetch(stuguby: StugubySummary, path: string, input: { method: string; body?: string | Uint8Array; contentType?: string; signal?: AbortSignal; stream?: boolean }): Promise<Response>;
    readBoundedResponse(response: Response, maximumBytes: number, code: string, message: string): Promise<Uint8Array>;
    remoteError(response: Response, fallback: string): Promise<StugubyError>;
    readJsonResponse(response: Response, maximumBytes: number, label: string): Promise<unknown>;
    storeDataUrl(value: string): { digest: string; byteLength: number; mediaType: "image/png" | "image/jpeg" | "image/webp" };
    storeBlob(data: Uint8Array, mediaType: string, expectedDigest?: string): {
            digest: string;
            byteLength: number;
            mediaType: StugubyBlobMediaType;
        };
    storeUploadedBlob(member: StugubyMember, stugubyId: string, data: Uint8Array, mediaType: string, expectedDigest: string): ReturnType<StugubyService["storeBlob"]>;
    deleteUnreferencedBlobs(digests: string[]): void;
    readBlob(digest: string): {
            data: Buffer;
            mediaType: string;
        };
    readBlobFor(member: StugubyMember, stugubyId: string, digest: string): {
            data: Buffer;
            mediaType: string;
        };
    requireStuguby(id: string): StugubySummary;
    requireLocalPublisher(id: string): StugubySummary;
    requireCoordinator(id: string): StugubySummary;
    requireReadyCoordinator(id: string): StugubySummary;
  }

  interface StugubyServiceCore {
    recordDeletionReceipt(actor: StugubyMember, receipt: StugubyDeletionReceipt): void;
    storeBlob(data: Uint8Array, mediaType: string, expectedDigest?: string): {
            digest: string;
            byteLength: number;
            mediaType: StugubyBlobMediaType;
        };
    storeUploadedBlob(member: StugubyMember, stugubyId: string, data: Uint8Array, mediaType: string, expectedDigest: string): ReturnType<StugubyService["storeBlob"]>;
    readBlob(digest: string): {
            data: Buffer;
            mediaType: string;
        };
    readBlobFor(member: StugubyMember, stugubyId: string, digest: string): {
            data: Buffer;
            mediaType: string;
        };
  }
}
