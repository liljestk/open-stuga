import type { TenantMemberRole } from "@climate-twin/contracts";

export function roleCanManageWorkspace(role: TenantMemberRole): boolean {
  return role === "owner" || role === "admin";
}

export function roleCanAccessNonGuestConfiguration(role: TenantMemberRole): boolean {
  return role !== "guest";
}
