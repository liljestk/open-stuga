import { roleCanAccessNonGuestConfiguration, roleCanManageWorkspace, type TenantMemberRole } from "@climate-twin/contracts";

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

/** The browser's view of the API's owner/admin and non-Guest boundaries, built on the shared role predicates. */
export function hasBrowserCapability(role: TenantMemberRole, capability: BrowserCapability): boolean {
  if (roleCanManageWorkspace(role)) return administratorCapabilities.has(capability);
  if (!roleCanAccessNonGuestConfiguration(role)) return false;
  return nonGuestCapabilities.has(capability);
}
