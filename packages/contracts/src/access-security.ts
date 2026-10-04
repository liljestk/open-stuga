import type { Floor, HouseLocation, HouseMapPlacement, StugubyHouseLink } from "./building-structure.js";

export type PropertyNoteKind = "note" | "inspection" | "maintenance";

/** Free-form context attached to a property or one of its resources. */
export interface PropertyNote {
  id: string;
  propertyId: string;
  houseId: string | null;
  areaId: string | null;
  equipmentId: string | null;
  kind: PropertyNoteKind;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export type PropertyNoteInput = Pick<PropertyNote, "propertyId" | "kind" | "text">
  & Partial<Pick<PropertyNote, "id" | "houseId" | "areaId" | "equipmentId">>;

export type PropertyNotePatch = Partial<Pick<PropertyNote, "houseId" | "areaId" | "equipmentId" | "kind" | "text">>;

export type TenantMemberRole = "owner" | "admin" | "member" | "guest" | "service";

export type GuestAccessScope = "property" | "house" | "area";

export interface GuestAccessGrant {
  scopeType: GuestAccessScope;
  scopeId: string;
}

export interface TenantMemberSummary {
  email: string;
  role: Exclude<TenantMemberRole, "service">;
  joinedAt?: string;
  invitedAt?: string;
  expiresAt?: string;
  grants: GuestAccessGrant[];
}

/** One tenant the authenticated principal may explicitly select. */
export interface TenantAccessSummary {
  id: string;
  name: string;
  role: TenantMemberRole;
}

export interface AppSession {
  authenticated: boolean;
  principal: { type: string; email: string | null };
  tenant: { id: string; name: string; role: TenantMemberRole };
  /** All memberships available to this principal, without other members' identities. */
  availableTenants: TenantAccessSummary[];
  /** Guests are always read-only; this explicit flag keeps clients fail-closed. */
  readOnly: boolean;
  grants: GuestAccessGrant[];
  /** Present for cookie-authenticated local sessions and submitted as X-CSRF-Token on mutations. */
  csrfToken?: string;
  /** True only while the pristine local database still permits first-owner setup. */
  setupRequired?: boolean;
  /** Returned after first-owner setup synchronizes the optional Access group. */
  cloudflareAccess?: CloudflareAccessSyncSummary;
}

export interface LocalAuthCredentials {
  email: string;
  password: string;
}

export type LocalOwnerSetupInput = LocalAuthCredentials;

export interface LocalInvitationRegistrationInput {
  token: string;
  password: string;
  /** Optional confirmation only. The one-time token identifies the invitation. */
  email?: string;
}

export type LocalLoginInput = LocalAuthCredentials;

export interface TenantMemberCreateInput {
  email: string;
  role: Exclude<TenantMemberRole, "owner" | "service">;
  grants?: GuestAccessGrant[];
}

export interface TenantMemberAccessUpdateInput {
  grants: GuestAccessGrant[];
}

export interface TenantMembersResponse {
  members: TenantMemberSummary[];
  invitations: TenantMemberSummary[];
}

export interface CloudflareAccessSyncSummary {
  status: "disabled" | "pending" | "synced";
  lastSyncedAt: string | null;
}

export interface TenantInvitationCreated {
  invitation: TenantMemberSummary;
  /** Shown once; only its SHA-256 digest is persisted. */
  registrationToken: string;
  activationPath: string;
  expiresAt: string;
  cloudflareAccess?: CloudflareAccessSyncSummary;
}

export type SecurityAuditOutcome = "succeeded" | "denied";

export const SECURITY_AUDIT_EVENT_TYPES = [
  "auth.owner.created", "auth.invitation.accepted", "auth.login", "auth.logout",
  "membership.invitation.created", "membership.grants.replaced", "membership.revoked",
  "integration.credentials.configured", "integration.credentials.rotated", "integration.credentials.revoked",
  "integration.grant.issued", "integration.grant.revoked",
  "system.update.settings.changed", "system.update.requested",
  "system.storage.change.requested", "cloudflare.setup.started",
] as const;

export type SecurityAuditEventType = (typeof SECURITY_AUDIT_EVENT_TYPES)[number];

/**
 * Every subject an audit event may describe. The security audit table constrains
 * `subject_type` to this list, so both sides must be generated from it: adding a
 * member here without migrating the table makes the audited route fail its insert.
 */
export const SECURITY_AUDIT_SUBJECT_TYPES = [
  "account",
  "workspace-member",
  "integration",
  "integration-grant",
  "system-update-settings",
  "system-update",
  "system-storage",
  "cloudflare-connection",
] as const;

export type SecurityAuditSubjectType = (typeof SECURITY_AUDIT_SUBJECT_TYPES)[number];

export type SecurityAuditDetailValue = string | number | boolean | null;

/** Append-only, secret-free evidence for authentication and privileged credential changes. */
export interface SecurityAuditEvent {
  id: string;
  eventType: SecurityAuditEventType;
  outcome: SecurityAuditOutcome;
  actorUserId: string | null;
  actorRole: TenantMemberRole | null;
  subjectType: SecurityAuditSubjectType;
  subjectId: string;
  details: Record<string, SecurityAuditDetailValue>;
  createdAt: string;
}

export interface House {
  id: string;
  /** Every current house belongs to exactly one property. Legacy records are backfilled at deserialization/migration time. */
  propertyId: string;
  name: string;
  timezone: string;
  location?: HouseLocation;
  mapPlacement?: HouseMapPlacement;
  /**
   * Clockwise compass bearing of the floor plan's top/up direction.
   * 0 = north, 90 = east, 180 = south, and 270 = west.
   * Omitted until the user confirms the plan's real-world orientation.
   */
  orientationDegrees?: number;
  floors: Floor[];
  /** Present for a Home shared through Stuguby or owned inside an adopted Property. */
  stuguby?: StugubyHouseLink;
  createdAt: string;
  updatedAt: string;
}

/** True when this installation may attach local-only data and integrations to the Home. */
export function hasLocalHouseAuthority(house: Pick<House, "stuguby">): boolean {
  return !house.stuguby
    || house.stuguby.syncState === "detached"
    || house.stuguby.ownership === "local";
}
