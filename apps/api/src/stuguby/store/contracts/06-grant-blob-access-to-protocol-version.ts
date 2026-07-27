import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  STUGBY_PROTOCOL_VERSION,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  type JsonValue,
  type StugubyDataset,
  type StugubyDeletionReceipt,
  type StugubyInvitation,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubyRemoteResource,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
  type StugubyTelemetryPayload,
} from "@climate-twin/stuguby-protocol";
import { StugubyDeletionReceiptResult, boundedLimit, eventBlobDigests, resourceBlobDigests } from "../support/01-stuguby-row-to-event-blob-digests.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    grantBlobAccess(stugubyId: string, digest: string, nodeId: string, grantId: string, grantEpoch: number): void;
    registerBlobReference(stugubyId: string, digest: string, grantId: string, grantEpoch: number, kind: "local" | "relay" | "replica"): void;
    canReadBlob(stugubyId: string, digest: string, nodeId: string): boolean;
    acknowledgeEventCursor(stugubyId: string, nodeId: string, cursor: number): string[];
    releaseRelayReferencesWithoutAccess(stugubyId: string, grantId: string, beforeOrAtEpoch: number): string[];
    purgeReplicaBlobReferences(stugubyId: string, grantId: string, beforeEpoch: number): string[];
    reconcileReplicaBlobReferences(stugubyId: string): string[];
    retireLocalBlobReferences(stugubyId: string, grantId: string, throughEpoch: number): void;
    hasBlobReferences(digest: string): boolean;
    unregisterBlob(digest: string): void;
    pendingBlobDeletions(limit?: number): string[];
    unreferencedBlobBytes(): number;
    staleUnreferencedBlobs(cutoff: string, limit?: number): string[];
    listDeletionReceipts(stugubyId: string): StugubyDeletionReceipt[];
    getDeletionReceipt(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt | null;
    expectDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): void;
    hasPendingDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): boolean;
    releaseDeletionBlobAccess(receipt: StugubyDeletionReceipt): string[];
    processDeletionReceipt(receipt: StugubyDeletionReceipt): StugubyDeletionReceiptResult;
    pendingDeletions(stugubyId: string, nodeId: string): number;
    pendingDeletionsForStuguby(stugubyId: string): number;
    audit(stugubyId: string | null, eventType: string, actorNodeId: string | null, subjectId: string | null, details: Record<string, string | number | boolean | null>, createdAt?: string): void;
    listAudit(stugubyId: string, limit?: number): Array<Record<string, unknown>>;
    protocolVersion(): typeof STUGBY_PROTOCOL_VERSION;
  }

  interface StugubyStoreCore {
    grantBlobAccess(stugubyId: string, digest: string, nodeId: string, grantId: string, grantEpoch: number): void;
    registerBlobReference(stugubyId: string, digest: string, grantId: string, grantEpoch: number, kind: "local" | "relay" | "replica"): void;
    canReadBlob(stugubyId: string, digest: string, nodeId: string): boolean;
    acknowledgeEventCursor(stugubyId: string, nodeId: string, cursor: number): string[];
    releaseRelayReferencesWithoutAccess(stugubyId: string, grantId: string, beforeOrAtEpoch: number): string[];
    purgeReplicaBlobReferences(stugubyId: string, grantId: string, beforeEpoch: number): string[];
    reconcileReplicaBlobReferences(stugubyId: string): string[];
    retireLocalBlobReferences(stugubyId: string, grantId: string, throughEpoch: number): void;
    hasBlobReferences(digest: string): boolean;
    unregisterBlob(digest: string): void;
    pendingBlobDeletions(limit?: number): string[];
    unreferencedBlobBytes(): number;
    staleUnreferencedBlobs(cutoff: string, limit?: number): string[];
    listDeletionReceipts(stugubyId: string): StugubyDeletionReceipt[];
    getDeletionReceipt(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt | null;
    expectDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): void;
    hasPendingDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): boolean;
    releaseDeletionBlobAccess(receipt: StugubyDeletionReceipt): string[];
    processDeletionReceipt(receipt: StugubyDeletionReceipt): StugubyDeletionReceiptResult;
    pendingDeletions(stugubyId: string, nodeId: string): number;
    pendingDeletionsForStuguby(stugubyId: string): number;
    audit(stugubyId: string | null, eventType: string, actorNodeId: string | null, subjectId: string | null, details: Record<string, string | number | boolean | null>, createdAt?: string): void;
    listAudit(stugubyId: string, limit?: number): Array<Record<string, unknown>>;
    protocolVersion(): typeof STUGBY_PROTOCOL_VERSION;
  }
}
