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
import { GrantRow, InvitationRow, JoinAdmissionRow, ProjectionResourceType, PublicationResourceType, SharedPropertyRow, StugubyInvitationAdmission, StugubyPropertyAdoption, StugubyStoredPropertyCommand, invitationFromRow } from "../support/01-stuguby-row-to-event-blob-digests.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    admitInvitation(id: string, secretHash: string, identity: StugubyNodeIdentity, now?: string): StugubyInvitationAdmission;
    markInvitationProvisioned(invitationId: string, nodeId: string, now?: string): void;
    revokeInvitation(stugubyId: string, invitationId: string): void;
    upsertGrant(grant: StugubyShareGrant): void;
    publicationId(stugubyId: string, resourceType: PublicationResourceType, localId: string): string;
    getGrant(id: string): StugubyShareGrant | null;
    listGrants(stugubyId: string, authorityNodeId?: string): StugubyShareGrant[];
    revokeGrant(id: string): StugubyShareGrant;
    removeInvalidGrant(id: string): string[];
    getSharedProperty(stugubyId: string): StugubySharedProperty | null;
    saveSharedProperty(property: StugubySharedProperty, expectedRevision?: number): StugubySharedProperty;
    getPropertyAdoption(stugubyId: string): StugubyPropertyAdoption | null;
    adoptProperty(stugubyId: string, localPropertyId: string, revision: number, now?: string): StugubyPropertyAdoption;
    releaseDetachedProperty(localPropertyId: string, exceptStugubyId: string): number;
    markPropertyMaterialized(stugubyId: string, revision: number): void;
    detachProperty(stugubyId: string, now?: string): StugubyPropertyAdoption;
    projectionId(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType, remoteId: string, preferredLocalId?: string): string;
    listProjectionIds(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType): Array<{
            remoteId: string;
            localId: string;
        }>;
    removeProjectionIds(stugubyId: string, authorityNodeId: string, projections: Array<{
            resourceType: ProjectionResourceType;
            localId: string;
        }>): number;
    projectionRemoteId(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType, localId: string): string;
    publicationLocalId(stugubyId: string, authorityNodeId: string, resourceType: PublicationResourceType, publicationId: string, create?: boolean): string | null;
    enqueuePropertyCommand(command: StugubyPropertyCommand): StugubyStoredPropertyCommand;
    pendingPropertyCommandFor(stugubyId: string, actorNodeId: string, entityKind: StugubyPropertyEntityKind, entityId: string): StugubyStoredPropertyCommand | null;
  }

  interface StugubyStoreCore {
    admitInvitation(id: string, secretHash: string, identity: StugubyNodeIdentity, now?: string): StugubyInvitationAdmission;
    markInvitationProvisioned(invitationId: string, nodeId: string, now?: string): void;
    revokeInvitation(stugubyId: string, invitationId: string): void;
    upsertGrant(grant: StugubyShareGrant): void;
    publicationId(stugubyId: string, resourceType: PublicationResourceType, localId: string): string;
    getGrant(id: string): StugubyShareGrant | null;
    listGrants(stugubyId: string, authorityNodeId?: string): StugubyShareGrant[];
    revokeGrant(id: string): StugubyShareGrant;
    removeInvalidGrant(id: string): string[];
    getSharedProperty(stugubyId: string): StugubySharedProperty | null;
    saveSharedProperty(property: StugubySharedProperty, expectedRevision?: number): StugubySharedProperty;
    getPropertyAdoption(stugubyId: string): StugubyPropertyAdoption | null;
    adoptProperty(stugubyId: string, localPropertyId: string, revision: number, now?: string): StugubyPropertyAdoption;
    releaseDetachedProperty(localPropertyId: string, exceptStugubyId: string): number;
    markPropertyMaterialized(stugubyId: string, revision: number): void;
    detachProperty(stugubyId: string, now?: string): StugubyPropertyAdoption;
    projectionId(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType, remoteId: string, preferredLocalId?: string): string;
    listProjectionIds(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType): Array<{
            remoteId: string;
            localId: string;
        }>;
    removeProjectionIds(stugubyId: string, authorityNodeId: string, projections: Array<{
            resourceType: ProjectionResourceType;
            localId: string;
        }>): number;
    projectionRemoteId(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType, localId: string): string;
    publicationLocalId(stugubyId: string, authorityNodeId: string, resourceType: PublicationResourceType, publicationId: string, create?: boolean): string | null;
    enqueuePropertyCommand(command: StugubyPropertyCommand): StugubyStoredPropertyCommand;
    pendingPropertyCommandFor(stugubyId: string, actorNodeId: string, entityKind: StugubyPropertyEntityKind, entityId: string): StugubyStoredPropertyCommand | null;
  }
}
