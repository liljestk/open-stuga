import type { AuthPrincipal } from "./auth.js";
import { sha256Hex, stableTenantId } from "./auth.js";
import { HttpError } from "./http.js";

export type TenantRole = "owner" | "admin" | "member" | "service";

export interface TenantContext {
  id: string;
  name: string;
  role: TenantRole;
  email: string | null;
  userId: string | null;
  principal: AuthPrincipal;
}

interface MembershipRow {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  user_id: string;
  email: string;
}

interface TenantRow {
  id: string;
  name: string;
}

const STARTER_FLOOR = {
  id: "floor-ground",
  name: "Ground floor",
  type: "ground",
  width: 1000,
  height: 640,
  elevation: 0,
  ceilingHeight: 2.8,
  walls: [],
  rooms: [],
};

async function principalUserId(principal: Exclude<AuthPrincipal, { kind: "api-token" }>): Promise<string> {
  return `user_${(await sha256Hex(`${principal.kind}:${principal.subject}`)).slice(0, 32)}`;
}

async function provisionPersonalTenantForUser(email: string, userId: string, env: Env): Promise<void> {
  const tenantId = await stableTenantId(email);
  const timestamp = new Date().toISOString();
  const localPart = email.split("@", 1)[0] || "My";
  const tenantName = `${localPart}'s Stuga`;
  const house = {
    id: "house-home",
    name: "My home",
    timezone: "UTC",
    floors: [STARTER_FLOOR],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO tenants(id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)`).bind(tenantId, tenantName, timestamp, timestamp),
    env.DB.prepare(`INSERT OR IGNORE INTO tenant_members(tenant_id, user_id, role, created_at)
      VALUES (?, ?, 'owner', ?)`).bind(tenantId, userId, timestamp),
    env.DB.prepare(`INSERT OR IGNORE INTO houses(tenant_id, id, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).bind(tenantId, house.id, JSON.stringify(house), timestamp, timestamp),
  ]);
}

export async function resolveTenant(request: Request, principal: AuthPrincipal, env: Env): Promise<TenantContext> {
  if (principal.kind === "api-token") {
    const tenant = await env.DB.prepare("SELECT id, name FROM tenants WHERE id = ?")
      .bind(principal.tenantId).first<TenantRow>();
    if (!tenant) throw new HttpError(401, "INVALID_API_TOKEN", "API token tenant no longer exists");
    return { id: tenant.id, name: tenant.name, role: "service", email: null, userId: null, principal };
  }

  const userId = await principalUserId(principal);
  const timestamp = new Date().toISOString();
  const subjectHash = await sha256Hex(`${principal.kind}:${principal.subject}`);
  await env.DB.prepare(`INSERT INTO users(id, identity_kind, subject_hash, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at
    WHERE users.email IS NOT excluded.email`)
    .bind(userId, principal.kind, subjectHash, principal.email, timestamp, timestamp).run();

  const invitations = await env.DB.prepare(`SELECT tenant_id, role FROM tenant_invitations WHERE email = ?`)
    .bind(principal.email).all<{ tenant_id: string; role: "admin" | "member" }>();
  if (invitations.results.length > 0) {
    const statements = invitations.results.flatMap((invitation) => [
      env.DB.prepare(`INSERT OR IGNORE INTO tenant_members(tenant_id, user_id, role, created_at)
        VALUES (?, ?, ?, ?)`).bind(invitation.tenant_id, userId, invitation.role, timestamp),
      env.DB.prepare("DELETE FROM tenant_invitations WHERE tenant_id = ? AND email = ?")
        .bind(invitation.tenant_id, principal.email),
    ]);
    await env.DB.batch(statements);
  }

  const requestedTenant = request.headers.get("x-stuga-tenant")?.trim() || null;
  let membership = requestedTenant
    ? await env.DB.prepare(`SELECT t.id, t.name, m.role, m.user_id, u.email FROM tenant_members m
        JOIN tenants t ON t.id = m.tenant_id JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND t.id = ?`)
      .bind(userId, requestedTenant).first<MembershipRow>()
    : await env.DB.prepare(`SELECT t.id, t.name, m.role, m.user_id, u.email FROM tenant_members m
        JOIN tenants t ON t.id = m.tenant_id JOIN users u ON u.id = m.user_id WHERE m.user_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at, t.id LIMIT 1`)
      .bind(userId).first<MembershipRow>();

  if (!membership && requestedTenant) {
    throw new HttpError(403, "TENANT_ACCESS_DENIED", "The authenticated user is not a member of the requested tenant");
  }
  if (!membership) {
    await provisionPersonalTenantForUser(principal.email, userId, env);
    membership = await env.DB.prepare(`SELECT t.id, t.name, m.role, m.user_id, u.email FROM tenant_members m
      JOIN tenants t ON t.id = m.tenant_id JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND t.id = ?`)
      .bind(userId, await stableTenantId(principal.email)).first<MembershipRow>();
  }
  if (!membership) throw new HttpError(500, "TENANT_PROVISION_FAILED", "Tenant could not be provisioned");
  return { id: membership.id, name: membership.name, role: membership.role, email: membership.email, userId: membership.user_id, principal };
}

export function requireTenantAdmin(tenant: TenantContext): void {
  if (tenant.role !== "owner" && tenant.role !== "admin") {
    throw new HttpError(403, "TENANT_ADMIN_REQUIRED", "Tenant administrator permission is required");
  }
}

export function requireTenantOwner(tenant: TenantContext): void {
  if (tenant.role !== "owner") throw new HttpError(403, "TENANT_OWNER_REQUIRED", "Tenant owner permission is required");
}
