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
import { StugubyError, asJson, grantExpired, parseIso, recommendedHomeOverviewDatasets, requiredText, withoutLocalGrantIdentity } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    ensureRecommendedHomeOverviewGrant(stugubyId: string, localHouseId: string): StugubyShareGrant | null;
    backfillRecommendedHomeOverviews(stugubyId: string): void;
    createGrant(stugubyId: string, input: {
            localHouseId: string;
            audience: StugubyGrantAudience;
            datasets: StugubyDatasetGrant[];
            housePolicy?: StugubyShareGrant["housePolicy"];
            expiresAt?: string | null;
        }): StugubyShareGrant;
    localPublicationCatalog(stugubyId: string, localHouseId: string): {
            house: {
                localHouseId: string;
                publicationId: string;
                name: string;
            };
            sensors: Array<{
                localSensorId: string;
                sensorPublicationId: string;
                name: string;
                metricIds: string[];
            }>;
        };
    updateGrant(grantId: string, baseRevision: number, input: Pick<StugubyShareGrant, "audience" | "datasets" | "expiresAt" | "housePolicy">): StugubyShareGrant;
    revokeGrant(grantId: string): StugubyShareGrant;
    republishGrant(grantId: string): void;
    validateGrantAgainstMembership(grant: StugubyShareGrant, authorityNodeId?: unknown ): void;
    validateEditableHomeGrant(grant: StugubyShareGrant): void;
    validateUniqueRecoverySuccessor(grant: StugubyShareGrant): void;
    validateUniqueActiveHomeGrant(grant: StugubyShareGrant): void;
    markLocalHouseInAdoptedProperty(houseId: string): House;
    markLocalSharedHouse(grant: StugubyShareGrant, house: House): void;
    refreshLocalSharedHouseLink(stugubyId: string, houseId: string): void;
    publishGrant(grant: StugubyShareGrant, eventKind: "grant.upserted" | "grant.revoked"): void;
  }

  interface StugubyServiceCore {
    createGrant(stugubyId: string, input: {
            localHouseId: string;
            audience: StugubyGrantAudience;
            datasets: StugubyDatasetGrant[];
            housePolicy?: StugubyShareGrant["housePolicy"];
            expiresAt?: string | null;
        }): StugubyShareGrant;
    localPublicationCatalog(stugubyId: string, localHouseId: string): {
            house: {
                localHouseId: string;
                publicationId: string;
                name: string;
            };
            sensors: Array<{
                localSensorId: string;
                sensorPublicationId: string;
                name: string;
                metricIds: string[];
            }>;
        };
    updateGrant(grantId: string, baseRevision: number, input: Pick<StugubyShareGrant, "audience" | "datasets" | "expiresAt" | "housePolicy">): StugubyShareGrant;
    revokeGrant(grantId: string): StugubyShareGrant;
    republishGrant(grantId: string): void;
    markLocalHouseInAdoptedProperty(houseId: string): House;
  }
}
