import type { AppSession, TenantMemberSummary } from "@climate-twin/contracts";
import { publishAuthEpoch } from "../../authEpoch";
import { assertApiRuntimeVersion } from "../../apiRuntimeVersion";
import { apiClientState } from "./client-state";
import { appSessionShape } from "./entity-shapes";
import { isRecord, type ResponseShape } from "./response-shapes";

/** A session document. Its runtime version is checked first: a stale server may send an older shape. */
export const sessionDocument: ResponseShape<AppSession> = (value, endpoint) => {
  assertApiRuntimeVersion(isRecord(value) && typeof value.systemVersion === "string" ? value.systemVersion : null, true);
  return appSessionShape(value, endpoint);
};

export function memberSummary(value: TenantMemberSummary): TenantMemberSummary {
  return { ...value, email: value.email.trim().toLowerCase(), grants: Array.isArray(value.grants) ? value.grants : [] };
}

export function rememberSession(session: AppSession): AppSession {
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
