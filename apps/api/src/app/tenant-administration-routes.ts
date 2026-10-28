import type { ApiRouteRegistrationContext } from "./route-registration-context.js";
import { HttpError } from "../http-error.js";
import { auditAccountSubject, requestPrincipal, requireWorkspaceAdmin } from "./support/local-sessions.js";
import { bodyObject, enumValue } from "../request-fields.js";
import { boundedQueryInteger } from "./support/query-fields.js";
import { requireJsonContentType } from "./support/request-classification.js";

export type TenantAdministrationRouteContext = Pick<
  ApiRouteRegistrationContext,
  | "app"
  | "prefix"
  | "localAuth"
  | "cloudflareAccess"
  | "synchronizeCloudflareAccess"
  | "recordSecurityAudit"
  | "database"
>;

export function registerTenantAdministrationRoutes(
  context: TenantAdministrationRouteContext,
): void {
  context.app.get(`${context.prefix}/tenant/members`, requireWorkspaceAdmin, (_request, response) => {
    const directory = context.localAuth.listWorkspaceMembers();
    if (context.cloudflareAccess) void context.synchronizeCloudflareAccess();
    response.json(directory);
  });

  context.app.post(`${context.prefix}/tenant/members`, requireWorkspaceAdmin, async (request, response) => {
    requireJsonContentType(request);
    const body = bodyObject(request.body);
    const role = enumValue(body.role, ["admin", "member", "guest"] as const, "role");
    const principal = requestPrincipal(response);
    const created = context.localAuth.inviteMember(principal, body.email, role, body.grants === undefined ? [] : body.grants);
    context.recordSecurityAudit(principal, {
      eventType: "membership.invitation.created",
      subjectType: "workspace-member",
      subjectId: created.invitation.email,
      details: { role: created.invitation.role, grantCount: created.invitation.grants.length },
    });
    const cloudflareAccessStatus = await context.synchronizeCloudflareAccess();
    response.status(201).json({
      invitation: created.invitation,
      registrationToken: created.registrationToken,
      // URL fragments remain client-side and avoid leaking the one-time token
      // through HTTP access logs, browser referrers, or intermediary caches.
      activationPath: `/invite-bootstrap#invite=${encodeURIComponent(created.registrationToken)}`,
      expiresAt: created.expiresAt,
      cloudflareAccess: cloudflareAccessStatus,
    });
  });

  context.app.put(
    `${context.prefix}/tenant/members/:email/access`,
    requireWorkspaceAdmin,
    (request, response) => {
      requireJsonContentType(request);
      const body = bodyObject(request.body);
      const member = context.localAuth.updateMemberAccess(request.params.email, body.grants);
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "membership.grants.replaced",
        subjectType: "workspace-member",
        subjectId: member.email,
        details: { grantCount: member.grants.length },
      });
      response.json({ member });
    },
  );

  context.app.delete(
    `${context.prefix}/tenant/members/:email`,
    requireWorkspaceAdmin,
    async (request, response) => {
      const principal = requestPrincipal(response);
      if (!context.localAuth.removeMember(request.params.email, principal)) {
        throw new HttpError(404, "MEMBER_NOT_FOUND", "Member or invitation not found");
      }
      context.recordSecurityAudit(principal, {
        eventType: "membership.revoked",
        subjectType: "workspace-member",
        subjectId: auditAccountSubject(request.params.email),
      });
      await context.synchronizeCloudflareAccess();
      response.status(204).end();
    },
  );

  context.app.get(`${context.prefix}/security/audit-events`, requireWorkspaceAdmin, (request, response) => {
    const limit = boundedQueryInteger(request.query.limit, "limit", 1, 500) ?? 100;
    const offset = boundedQueryInteger(request.query.offset, "offset", 0, 1_000_000) ?? 0;
    response.json({ events: context.database.listSecurityAuditEvents(limit, offset) });
  });
}
