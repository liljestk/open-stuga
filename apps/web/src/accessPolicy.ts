import type { TenantMemberRole } from "@climate-twin/contracts";

export type BrowserCapability =
  | "workspace-administration"
  | "developer-tools"
  | "system-operations"
  | "property-mutation"
  | "home-mutation"
  | "area-mutation"
  | "tapo-history-administration";

const administratorCapabilities = new Set<BrowserCapability>([
  "workspace-administration",
  "developer-tools",
  "system-operations",
  "property-mutation",
  "home-mutation",
  "area-mutation",
  "tapo-history-administration",
]);

const nonGuestCapabilities = new Set<BrowserCapability>([
  "developer-tools",
  "property-mutation",
  "home-mutation",
  "area-mutation",
]);

/** Mirrors the API's owner/admin and non-Guest authorization boundaries. */
export function hasBrowserCapability(role: TenantMemberRole, capability: BrowserCapability): boolean {
  if (role === "owner" || role === "admin") return administratorCapabilities.has(capability);
  if (role === "guest") return false;
  return nonGuestCapabilities.has(capability);
}
