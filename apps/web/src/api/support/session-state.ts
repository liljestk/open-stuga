import type { AppSession, TenantMemberSummary } from "@climate-twin/contracts";
import { publishAuthEpoch } from "../../authEpoch";
import { assertApiRuntimeVersion } from "../../apiRuntimeVersion";
import { apiClientState } from "./client-state";

export function memberSummary(value: TenantMemberSummary): TenantMemberSummary {
  return { ...value, email: value.email.trim().toLowerCase(), grants: Array.isArray(value.grants) ? value.grants : [] };
}

export function rememberSession(session: AppSession & { systemVersion?: unknown }): AppSession {
  assertApiRuntimeVersion(typeof session.systemVersion === "string" ? session.systemVersion : null, true);
  apiClientState.csrfToken = session.authenticated && typeof session.csrfToken === "string" && session.csrfToken
    ? session.csrfToken
    : null;
  return { ...session, availableTenants: [session.tenant] };
}

export async function completeAuthentication(promise: Promise<AppSession>): Promise<AppSession> {
  const session = rememberSession(await promise);
  publishAuthEpoch();
  return session;
}
