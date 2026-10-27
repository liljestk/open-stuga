import {
  roleCanAccessNonGuestConfiguration,
  roleCanManageWorkspace,
  roleIsWorkspacePerson,
  type TenantMemberRole,
} from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";

describe("API role guard matrix", () => {
  it("covers all 15 role-by-guard cells", () => {
    const expected: Record<TenantMemberRole, { workspaceAdmin: boolean; nonGuest: boolean; person: boolean }> = {
      owner: { workspaceAdmin: true, nonGuest: true, person: true },
      admin: { workspaceAdmin: true, nonGuest: true, person: true },
      member: { workspaceAdmin: false, nonGuest: true, person: true },
      guest: { workspaceAdmin: false, nonGuest: false, person: false },
      service: { workspaceAdmin: false, nonGuest: true, person: false },
    };
    const cells = (Object.keys(expected) as TenantMemberRole[]).flatMap((role) => [
      { role, guard: "workspaceAdmin", actual: roleCanManageWorkspace(role) },
      { role, guard: "nonGuest", actual: roleCanAccessNonGuestConfiguration(role) },
      { role, guard: "person", actual: roleIsWorkspacePerson(role) },
    ] as const);

    expect(cells).toHaveLength(15);
    for (const cell of cells) {
      expect(cell.actual, `${cell.role}: ${cell.guard}`).toBe(expected[cell.role][cell.guard]);
    }
  });
});
