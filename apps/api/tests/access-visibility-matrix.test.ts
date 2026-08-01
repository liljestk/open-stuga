import type { GuestAccessGrant, TenantMemberRole } from "@climate-twin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LocalVisibility, type LocalRequestPrincipal } from "../src/app/support/index.js";
import { ClimateDatabase } from "../src/db.js";

type Scope = "workspace" | "property" | "home" | "area";

const scopes: Scope[] = ["workspace", "property", "home", "area"];

function principal(role: TenantMemberRole, grants: GuestAccessGrant[] = []): LocalRequestPrincipal {
  return {
    userId: `${role}-id`,
    email: `${role}@example.test`,
    role,
    joinedAt: "2026-08-01T00:00:00.000Z",
    grants,
    bootstrap: false,
  } as unknown as LocalRequestPrincipal;
}

describe("LocalVisibility role and hierarchy matrix", () => {
  let database: ClimateDatabase | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("covers all 32 server role/grant-by-Workspace/Property/Home/area cells", () => {
    database = new ClimateDatabase(":memory:", true);
    const property = database.createProperty({
      id: "property-visible",
      name: "Visible estate",
      description: "Private description",
      location: { latitude: 60.17, longitude: 24.94 },
    });
    database.createHouse({
      id: "home-visible",
      propertyId: property.id,
      name: "Visible home",
      timezone: "Europe/Helsinki",
      floors: [],
    });
    database.createPropertyArea({
      id: "area-visible",
      propertyId: property.id,
      name: "Visible yard",
      kind: "yard",
      polygon: [],
    });

    const cases: Array<{
      name: string;
      role: TenantMemberRole;
      grants?: GuestAccessGrant[];
      allowed: Scope[];
    }> = [
      ...(["owner", "admin", "member", "service"] as TenantMemberRole[]).map((role) => ({
        name: role,
        role,
        allowed: scopes,
      })),
      { name: "guest without grants", role: "guest", allowed: [] },
      {
        name: "guest with Property grant",
        role: "guest",
        grants: [{ scopeType: "property", scopeId: property.id }],
        allowed: ["property", "home", "area"],
      },
      {
        name: "guest with Home grant",
        role: "guest",
        grants: [{ scopeType: "house", scopeId: "home-visible" }],
        allowed: ["property", "home"],
      },
      {
        name: "guest with area grant",
        role: "guest",
        grants: [{ scopeType: "area", scopeId: "area-visible" }],
        allowed: ["property", "area"],
      },
    ];

    const cells = cases.flatMap((testCase) => {
      const visibility = new LocalVisibility(database!, principal(testCase.role, testCase.grants));
      const actual: Record<Scope, boolean> = {
        workspace: !visibility.restricted,
        property: visibility.property(property) !== null,
        home: visibility.house("home-visible"),
        area: visibility.area("area-visible"),
      };
      return scopes.map((scope) => ({ ...testCase, scope, actual: actual[scope] }));
    });

    expect(cells).toHaveLength(32);
    for (const cell of cells) {
      expect(cell.actual, `${cell.name}: ${cell.scope}`).toBe(cell.allowed.includes(cell.scope));
    }

    const homeGuest = new LocalVisibility(database, principal("guest", [{ scopeType: "house", scopeId: "home-visible" }]));
    expect(homeGuest.property(property)).toMatchObject({ description: null, location: null });
  });
});
