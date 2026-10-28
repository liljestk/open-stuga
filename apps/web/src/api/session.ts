import { ApiRequestError } from "./support/request-error";
import type { LocalInvitationRegistrationInput, LocalLoginInput, LocalOwnerSetupInput, GuestAccessGrant, TenantInvitationCreated, TenantMembersResponse } from "@climate-twin/contracts";
import { publishAuthEpoch } from "../authEpoch";
import { apiClientState } from "./support/client-state";
import { completeAuthentication, rememberSession, memberSummary, sessionDocument } from "./support/session-state";
import { request } from "./support/request";
import { tenantInvitationCreatedShape, tenantMemberSummaryShape, tenantMembersResponseShape } from "./support/entity-shapes";
import { noContent, fields } from "./support/response-shapes";

/** The signed-in session, account set-up and the workspace's members. */
export const sessionApi = {
  session: async () => rememberSession(await request("/session", sessionDocument)),
  setupOwner: (input: LocalOwnerSetupInput, bootstrapSecret?: string | null) => completeAuthentication(request("/auth/setup", sessionDocument, {
      method: "POST",
      ...(bootstrapSecret ? { headers: { "X-Stugu-Bootstrap-Secret": bootstrapSecret } } : {}),
      body: JSON.stringify(input),
    })),
  login: (input: LocalLoginInput) => completeAuthentication(request("/auth/login", sessionDocument, {
      method: "POST",
      body: JSON.stringify(input),
    })),
  registerInvitation: (input: LocalInvitationRegistrationInput) => completeAuthentication(request("/auth/register", sessionDocument, {
      method: "POST",
      body: JSON.stringify(input),
    })),
  logout: async () => {
      let completed = false;
      try {
        await request("/auth/logout", noContent, { method: "POST" });
        completed = true;
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
        completed = true;
      } finally {
        apiClientState.csrfToken = null;
      }
      if (completed) publishAuthEpoch();
    },
  tenantMembers: async (): Promise<TenantMembersResponse> => {
      const response = await request("/tenant/members", tenantMembersResponseShape);
      return {
        members: response.members.map(memberSummary),
        invitations: response.invitations.map(memberSummary),
      };
    },
  inviteGuest: async (email: string): Promise<TenantInvitationCreated> => {
      const response = await request("/tenant/members", tenantInvitationCreatedShape, {
        method: "POST",
        body: JSON.stringify({ email, role: "guest" }),
      });
      return { ...response, invitation: memberSummary(response.invitation) };
    },
  updateMemberAccess: async (email: string, grants: GuestAccessGrant[]) => {
      const response = await request(`/tenant/members/${encodeURIComponent(email)}/access`, fields({ member: tenantMemberSummaryShape }), {
        method: "PUT",
        body: JSON.stringify({ grants }),
      });
      return memberSummary(response.member);
    },
  removeTenantMember: (email: string) => request(`/tenant/members/${encodeURIComponent(email.trim().toLowerCase())}`, noContent, { method: "DELETE" }),
};
