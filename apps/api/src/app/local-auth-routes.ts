import {
  LocalAuthError,
  type LocalAuthIdentity,
} from "../local-auth.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";
import {
  HttpError,
  LOCAL_SESSION_COOKIE,
  auditAccountSubject,
  authAttemptKeys,
  bodyObject,
  clearLocalSessionCookies,
  cookieValue,
  keyMatches,
  localSetupRequestAllowed,
  requestPrincipal,
  requireJsonContentType,
  sessionDocument,
  setLocalSessionCookies,
} from "./support/index.js";


export type LocalAuthRouteContext = Pick<
  ApiRouteRegistrationContext,
  | "app"
  | "prefix"
  | "config"
  | "localAuth"
  | "authAbuseLimiter"
  | "recordSecurityAudit"
  | "synchronizeCloudflareAccess"
>;

export function registerLocalAuthRoutes(context: LocalAuthRouteContext): void {
  const config = context.config;

  context.app.post(`${context.prefix}/auth/setup`, async (request, response) => {
    requireJsonContentType(request);
    const configuredSecret = config.localAuthBootstrapSecret ?? null;
    const providedSecret = request.header("x-stugu-bootstrap-secret");
    const secretAuthorized = Boolean(
      configuredSecret
      && providedSecret
      && keyMatches(providedSecret, configuredSecret),
    );
    if (!localSetupRequestAllowed(request, config) && !secretAuthorized) {
      throw new HttpError(403, "BOOTSTRAP_LOCAL_ONLY", "First-owner setup is restricted to the local machine");
    }
    if (context.localAuth.isInitialized()) {
      throw new HttpError(409, "AUTH_ALREADY_INITIALIZED", "Local authentication has already been initialized");
    }
    const body = bodyObject(request.body);
    const release = context.authAbuseLimiter.enter(
      authAttemptKeys(request, config, "setup", body.email),
      response,
    );
    try {
      const identity = await context.localAuth.createFirstOwner(body.email, body.password);
      const issued = context.localAuth.issueSession(identity);
      setLocalSessionCookies(response, request, config, issued.token, issued.session.csrfToken);
      context.recordSecurityAudit(identity, {
        eventType: "auth.owner.created",
        subjectType: "account",
        subjectId: identity.email,
        details: { role: identity.role },
      });
      const cloudflareAccessStatus = await context.synchronizeCloudflareAccess();
      response.status(201).json({
        ...sessionDocument(issued.session, issued.session.csrfToken),
        cloudflareAccess: cloudflareAccessStatus,
      });
    } finally {
      release();
    }
  });

  context.app.post(`${context.prefix}/auth/register`, async (request, response) => {
    requireJsonContentType(request);
    if (!context.localAuth.isInitialized()) {
      throw new HttpError(409, "SETUP_REQUIRED", "Create the first owner before accepting invitations");
    }
    const body = bodyObject(request.body);
    const release = context.authAbuseLimiter.enter(
      authAttemptKeys(request, config, "register", body.token),
      response,
    );
    try {
      const identity = await context.localAuth.registerInvitation(body.token, body.password, body.email);
      const issued = context.localAuth.issueSession(identity);
      setLocalSessionCookies(response, request, config, issued.token, issued.session.csrfToken);
      context.recordSecurityAudit(identity, {
        eventType: "auth.invitation.accepted",
        subjectType: "account",
        subjectId: identity.email,
        details: { role: identity.role, grantCount: identity.grants.length },
      });
      response.status(201).json(sessionDocument(issued.session, issued.session.csrfToken));
    } finally {
      release();
    }
  });

  context.app.post(`${context.prefix}/auth/login`, async (request, response) => {
    requireJsonContentType(request);
    if (!context.localAuth.isInitialized()) {
      throw new HttpError(409, "SETUP_REQUIRED", "Create the first owner before signing in");
    }
    const body = bodyObject(request.body);
    const release = context.authAbuseLimiter.enter(
      authAttemptKeys(request, config, "login", body.email),
      response,
    );
    try {
      let identity: LocalAuthIdentity | null;
      try {
        identity = await context.localAuth.verifyCredentials(body.email, body.password);
      } catch (error) {
        context.recordSecurityAudit(null, {
          eventType: "auth.login",
          outcome: "denied",
          subjectType: "account",
          subjectId: auditAccountSubject(body.email),
          details: { reason: error instanceof LocalAuthError ? error.code : "VERIFICATION_FAILED" },
        });
        throw error;
      }
      if (!identity) {
        context.recordSecurityAudit(null, {
          eventType: "auth.login",
          outcome: "denied",
          subjectType: "account",
          subjectId: auditAccountSubject(body.email),
          details: { reason: "INVALID_CREDENTIALS" },
        });
        throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
      }
      const previousToken = cookieValue(request, LOCAL_SESSION_COOKIE);
      if (previousToken) context.localAuth.revokeSession(previousToken);
      const issued = context.localAuth.issueSession(identity);
      setLocalSessionCookies(response, request, config, issued.token, issued.session.csrfToken);
      context.recordSecurityAudit(identity, {
        eventType: "auth.login",
        subjectType: "account",
        subjectId: identity.email,
        details: { role: identity.role },
      });
      response.json(sessionDocument(issued.session, issued.session.csrfToken));
    } finally {
      release();
    }
  });

  context.app.post(`${context.prefix}/auth/logout`, (request, response) => {
    const principal = requestPrincipal(response);
    context.localAuth.revokeSession(cookieValue(request, LOCAL_SESSION_COOKIE));
    context.recordSecurityAudit(principal, {
      eventType: "auth.logout",
      subjectType: "account",
      subjectId: principal.email || principal.userId,
    });
    clearLocalSessionCookies(response, request, config);
    response.status(204).end();
  });
}
