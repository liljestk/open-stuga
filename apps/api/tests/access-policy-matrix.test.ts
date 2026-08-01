import type { TenantMemberRole } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { roleCanAccessNonGuestConfiguration, roleCanManageWorkspace } from "../src/app/access-policy.js";

describe("API role guard matrix", () => {
  it("covers all 10 role-by-guard cells", () => {
    const expected: Record<TenantMemberRole, { workspaceAdmin: boolean; nonGuest: boolean }> = {
      owner: { workspaceAdmin: true, nonGuest: true },
      admin: { workspaceAdmin: true, nonGuest: true },
      member: { workspaceAdmin: false, nonGuest: true },
      guest: { workspaceAdmin: false, nonGuest: false },
      service: { workspaceAdmin: false, nonGuest: true },
    };
    const cells = (Object.keys(expected) as TenantMemberRole[]).flatMap((role) => [
      { role, guard: "workspaceAdmin", actual: roleCanManageWorkspace(role) },
      { role, guard: "nonGuest", actual: roleCanAccessNonGuestConfiguration(role) },
    ] as const);

    expect(cells).toHaveLength(10);
    for (const cell of cells) {
      expect(cell.actual, `${cell.role}: ${cell.guard}`).toBe(expected[cell.role][cell.guard]);
    }
  });
});
