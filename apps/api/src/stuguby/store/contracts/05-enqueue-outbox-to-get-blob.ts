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
import { OutboxRow, RemoteTelemetryQuery, StugubyEventLogPage, StugubyOutboxItem, boundedLimit } from "../support/01-stuguby-row-to-event-blob-digests.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    enqueueOutbox(stugubyId: string, destinationNodeId: string, event: StugubySignedEvent): void;
    dueOutbox(limit?: number): StugubyOutboxItem[];
    acknowledgeOutbox(ids: number[]): void;
    discardOutboxGrantEpoch(stugubyId: string, grantId: string, throughEpoch: number): void;
    failOutbox(id: number, attempts: number): void;
    inboxEventStatus(event: StugubySignedEvent): "new" | "duplicate" | "non-monotonic";
    recordInboxEvent(event: StugubySignedEvent): boolean;
    appendEventForMember(stugubyId: string, targetNodeId: string, event: StugubySignedEvent): number | null;
    eventPage(stugubyId: string, targetNodeId: string, afterCursor: number, limit?: number): StugubyEventLogPage;
    applyDatasetEvent(event: StugubySignedEvent): {
            applied: boolean;
            deletionReceipt?: StugubyDeletionReceipt;
        };
    insertTelemetry(event: StugubySignedEvent, payload: StugubyTelemetryPayload, receivedAt: string): void;
    purgeGrantData(stugubyId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt;
    listRemoteResources(stugubyId: string): StugubyRemoteResource[];
    remoteTelemetry(query: RemoteTelemetryQuery): Array<Record<string, string | number | null>>;
    remoteTelemetryCount(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    promoteRecoveryTelemetry(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    markRemoteStale(stugubyId: string): void;
    markRemoteCurrent(stugubyId: string): void;
    purgeDepartedReplicas(stugubyId: string): void;
    enforceRetention(stugubyId: string): void;
    pullCursor(stugubyId: string): number;
    recordSync(stugubyId: string, cursor: number, error: string | null): void;
    acceptRequest(nodeId: string, requestId: string, expiresAt: string): boolean;
    registerBlob(digest: string, byteLength: number, mediaType: string, relativePath: string): void;
    getBlob(digest: string): {
            digest: string;
            byteLength: number;
            mediaType: string;
            relativePath: string;
        } | null;
  }

  interface StugubyStoreCore {
    enqueueOutbox(stugubyId: string, destinationNodeId: string, event: StugubySignedEvent): void;
    dueOutbox(limit?: number): StugubyOutboxItem[];
    acknowledgeOutbox(ids: number[]): void;
    discardOutboxGrantEpoch(stugubyId: string, grantId: string, throughEpoch: number): void;
    failOutbox(id: number, attempts: number): void;
    inboxEventStatus(event: StugubySignedEvent): "new" | "duplicate" | "non-monotonic";
    recordInboxEvent(event: StugubySignedEvent): boolean;
    appendEventForMember(stugubyId: string, targetNodeId: string, event: StugubySignedEvent): number | null;
    eventPage(stugubyId: string, targetNodeId: string, afterCursor: number, limit?: number): StugubyEventLogPage;
    applyDatasetEvent(event: StugubySignedEvent): {
            applied: boolean;
            deletionReceipt?: StugubyDeletionReceipt;
        };
    purgeGrantData(stugubyId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt;
    listRemoteResources(stugubyId: string): StugubyRemoteResource[];
    remoteTelemetry(query: RemoteTelemetryQuery): Array<Record<string, string | number | null>>;
    remoteTelemetryCount(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    promoteRecoveryTelemetry(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    markRemoteStale(stugubyId: string): void;
    markRemoteCurrent(stugubyId: string): void;
    purgeDepartedReplicas(stugubyId: string): void;
    enforceRetention(stugubyId: string): void;
    pullCursor(stugubyId: string): number;
    recordSync(stugubyId: string, cursor: number, error: string | null): void;
    acceptRequest(nodeId: string, requestId: string, expiresAt: string): boolean;
    registerBlob(digest: string, byteLength: number, mediaType: string, relativePath: string): void;
    getBlob(digest: string): {
            digest: string;
            byteLength: number;
            mediaType: string;
            relativePath: string;
        } | null;
  }
}
