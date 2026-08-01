import type { TenantMemberRole } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { hasBrowserCapability, type BrowserCapability } from "./accessPolicy";

const capabilities: BrowserCapability[] = [
  "workspace-administration",
  "developer-tools",
  "system-operations",
  "property-mutation",
  "home-mutation",
  "area-mutation",
  "tapo-history-administration",
];

const expected: Record<TenantMemberRole, BrowserCapability[]> = {
  owner: capabilities,
  admin: capabilities,
  member: ["developer-tools", "property-mutation", "home-mutation", "area-mutation"],
  guest: [],
  service: ["developer-tools", "property-mutation", "home-mutation", "area-mutation"],
};

describe("browser/API permission parity", () => {
  it("covers all 35 role-by-visible-action cells", () => {
    const roles = Object.keys(expected) as TenantMemberRole[];
    const cells = roles.flatMap((role) => capabilities.map((capability) => ({
      role,
      capability,
      allowed: hasBrowserCapability(role, capability),
    })));

    expect(cells).toHaveLength(35);
    for (const cell of cells) {
      expect(cell.allowed, `${cell.role}: ${cell.capability}`).toBe(expected[cell.role].includes(cell.capability));
    }
  });
});
