import { ApiRequestError } from "./support/request-error";
import type { AppSession, LocalInvitationRegistrationInput, LocalLoginInput, LocalOwnerSetupInput, GuestAccessGrant, TenantInvitationCreated, TenantMemberSummary, TenantMembersResponse } from "@climate-twin/contracts";
import { publishAuthEpoch } from "../authEpoch";
import { apiClientState } from "./support/client-state";
import { completeAuthentication, rememberSession, memberSummary } from "./support/session-state";
import { request } from "./support/request";

/** The signed-in session, account set-up and the workspace's members. */
export const sessionApi = {
  session: async () => rememberSession(await request<AppSession>("/session")),
  setupOwner: (input: LocalOwnerSetupInput, bootstrapSecret?: string | null) => completeAuthentication(request<AppSession>("/auth/setup", {
      method: "POST",
      ...(bootstrapSecret ? { headers: { "X-Stugu-Bootstrap-Secret": bootstrapSecret } } : {}),
      body: JSON.stringify(input),
    })),
  login: (input: LocalLoginInput) => completeAuthentication(request<AppSession>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    })),
  registerInvitation: (input: LocalInvitationRegistrationInput) => completeAuthentication(request<AppSession>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    })),
  logout: async () => {
      let completed = false;
      try {
        await request<void>("/auth/logout", { method: "POST" });
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
      const response = await request<Partial<TenantMembersResponse>>("/tenant/members");
      return {
        members: Array.isArray(response.members) ? response.members.map(memberSummary) : [],
        invitations: Array.isArray(response.invitations) ? response.invitations.map(memberSummary) : [],
      };
    },
  inviteGuest: async (email: string): Promise<TenantInvitationCreated> => {
      const response = await request<TenantInvitationCreated>("/tenant/members", {
        method: "POST",
        body: JSON.stringify({ email, role: "guest" }),
      });
      return { ...response, invitation: memberSummary(response.invitation) };
    },
  updateMemberAccess: async (email: string, grants: GuestAccessGrant[]) => {
      const response = await request<{ member: TenantMemberSummary }>(`/tenant/members/${encodeURIComponent(email)}/access`, {
        method: "PUT",
        body: JSON.stringify({ grants }),
      });
      return memberSummary(response.member);
    },
  removeTenantMember: (email: string) => request<void>(`/tenant/members/${encodeURIComponent(email.trim().toLowerCase())}`, { method: "DELETE" }),
};
