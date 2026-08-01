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
import { StugubyAuthorityTransfer, StugubyHomeProjection, StugubyStoredHomeCommand, StugubyStoredPropertyCommand, boundedLimit } from "../support/01-stuguby-row-to-event-blob-digests.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    getPropertyCommand(commandId: string): StugubyStoredPropertyCommand | null;
    pendingPropertyCommands(stugubyId: string, limit?: number): StugubyStoredPropertyCommand[];
    propertyCommandCounts(stugubyId: string): {
            pending: number;
            conflicts: number;
        };
    deferPropertyCommand(commandId: string, attempts: number, nextAttemptAt: string): void;
    cancelPendingPropertyCommands(stugubyId: string, now?: string): number;
    completePropertyCommand(result: StugubyPropertyCommandResult): StugubyStoredPropertyCommand;
    homeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    bumpHomeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    pendingHomeCommandFor(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyStoredHomeCommand | null;
    enqueueHomeCommand(command: StugubyHomeCommand): StugubyStoredHomeCommand;
    getHomeCommand(commandId: string): StugubyStoredHomeCommand | null;
    pendingHomeCommands(stugubyId: string, limit?: number): StugubyStoredHomeCommand[];
    homeCommandCounts(stugubyId: string): {
            pending: number;
            conflicts: number;
        };
    homeCommandCountsFor(stugubyId: string, authorityNodeId: string, publicationId: string): {
            pending: number;
            conflicts: number;
        };
    deferHomeCommand(commandId: string, attempts: number, nextAttemptAt: string): void;
    completeHomeCommand(result: StugubyHomeCommandResult): StugubyStoredHomeCommand;
    cancelPendingHomeCommands(stugubyId: string, now?: string): number;
    cancelPendingHomeCommandsFor(stugubyId: string, authorityNodeId: string, publicationId: string, now?: string): number;
    propertyFieldRevisions(stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string): Record<string, number>;
    setPropertyFieldRevisions(stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, fields: readonly string[], revision: number): void;
    listPropertyConflicts(stugubyId: string, includeResolved?: boolean): StugubyPropertyConflict[];
    resolvePropertyConflict(stugubyId: string, commandId: string, now?: string): boolean;
    saveMigrationSnapshot(stugubyId: string, sourcePropertyId: string, targetPropertyId: string, snapshot: JsonValue, now?: string): string;
    upsertHomeProjection(projection: StugubyHomeProjection): StugubyHomeProjection;
    getHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null;
    listHomeProjections(stugubyId: string): StugubyHomeProjection[];
    removeHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null;
    saveAuthorityTransfer(transfer: StugubyAuthorityTransfer): StugubyAuthorityTransfer;
    listAuthorityTransfers(stugubyId: string): StugubyAuthorityTransfer[];
    nextSequence(stugubyId: string, streamId: string): number;
    reserveLiveTelemetrySample(stugubyId: string, grantId: string, utcHour: string, maximum: number): boolean;
  }

  interface StugubyStoreCore {
    getPropertyCommand(commandId: string): StugubyStoredPropertyCommand | null;
    pendingPropertyCommands(stugubyId: string, limit?: number): StugubyStoredPropertyCommand[];
    propertyCommandCounts(stugubyId: string): {
            pending: number;
            conflicts: number;
        };
    deferPropertyCommand(commandId: string, attempts: number, nextAttemptAt: string): void;
    cancelPendingPropertyCommands(stugubyId: string, now?: string): number;
    completePropertyCommand(result: StugubyPropertyCommandResult): StugubyStoredPropertyCommand;
    homeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    bumpHomeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    pendingHomeCommandFor(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyStoredHomeCommand | null;
    enqueueHomeCommand(command: StugubyHomeCommand): StugubyStoredHomeCommand;
    getHomeCommand(commandId: string): StugubyStoredHomeCommand | null;
    pendingHomeCommands(stugubyId: string, limit?: number): StugubyStoredHomeCommand[];
    homeCommandCounts(stugubyId: string): {
            pending: number;
            conflicts: number;
        };
    homeCommandCountsFor(stugubyId: string, authorityNodeId: string, publicationId: string): {
            pending: number;
            conflicts: number;
        };
    deferHomeCommand(commandId: string, attempts: number, nextAttemptAt: string): void;
    completeHomeCommand(result: StugubyHomeCommandResult): StugubyStoredHomeCommand;
    cancelPendingHomeCommands(stugubyId: string, now?: string): number;
    cancelPendingHomeCommandsFor(stugubyId: string, authorityNodeId: string, publicationId: string, now?: string): number;
    propertyFieldRevisions(stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string): Record<string, number>;
    setPropertyFieldRevisions(stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, fields: readonly string[], revision: number): void;
    listPropertyConflicts(stugubyId: string, includeResolved?: boolean): StugubyPropertyConflict[];
    resolvePropertyConflict(stugubyId: string, commandId: string, now?: string): boolean;
    saveMigrationSnapshot(stugubyId: string, sourcePropertyId: string, targetPropertyId: string, snapshot: JsonValue, now?: string): string;
    upsertHomeProjection(projection: StugubyHomeProjection): StugubyHomeProjection;
    getHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null;
    listHomeProjections(stugubyId: string): StugubyHomeProjection[];
    removeHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null;
    saveAuthorityTransfer(transfer: StugubyAuthorityTransfer): StugubyAuthorityTransfer;
    listAuthorityTransfers(stugubyId: string): StugubyAuthorityTransfer[];
    nextSequence(stugubyId: string, streamId: string): number;
    reserveLiveTelemetrySample(stugubyId: string, grantId: string, utcHour: string, maximum: number): boolean;
  }
}
